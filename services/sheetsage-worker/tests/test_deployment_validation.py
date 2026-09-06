import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location(
    "deployment_validation", ROOT / "deployment_validation.py"
)
validation = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(validation)


class Response:
    status = 200

    def __init__(self, body):
        import json
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def read(self):
        return self.body


class DeploymentValidationTests(unittest.TestCase):
    def ready_health(self):
        return {
            "provider": "SHEETSAGE",
            "version": "0.2.1",
            "assetsVerified": True,
            "runtimeReady": True,
            "checkpointReady": True,
            "smokeTested": True,
            "smokeProofVerified": True,
            "healthy": True,
            "status": "ready",
            "checksum": "a" * 64,
        }

    def test_authenticated_live_health_passes_every_gate(self):
        opener = MagicMock()
        opener.open.return_value = Response(self.ready_health())
        with patch.object(validation, "build_opener", return_value=opener):
            result = validation.validate_deployment(
                "https://workspace--sheetsage-candidate.modal.run",
                "a" * 64,
                token="secret",
            )
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        self.assertIn("signed_real_smoke_proof", result["validatedGates"])

    def test_mismatch_names_all_failed_evidence_without_secret(self):
        health = self.ready_health()
        health.update({
            "checkpointReady": False,
            "smokeProofVerified": False,
            "checksum": "b" * 64,
        })
        with self.assertRaises(validation.DeploymentValidationError) as raised:
            validation.validate_health_evidence(health, "a" * 64)
        message = str(raised.exception)
        self.assertIn("checkpoint_ready", message)
        self.assertIn("signed_real_smoke_proof", message)
        self.assertIn("manifest_checksum", message)
        self.assertNotIn("secret", message)

    def test_non_https_endpoint_fails_before_sending_authentication(self):
        with patch.object(validation, "build_opener") as opened:
            with self.assertRaises(validation.DeploymentValidationError):
                validation.validate_deployment(
                    "http://worker.example", "a" * 64, token="secret"
                )
        opened.assert_not_called()

    def test_non_modal_endpoint_never_receives_authentication(self):
        with patch.object(validation, "build_opener") as opened:
            with self.assertRaises(validation.DeploymentValidationError):
                validation.validate_deployment(
                    "https://attacker.example", "a" * 64, token="secret"
                )
        opened.assert_not_called()

    def test_redirect_is_not_followed(self):
        import urllib.error
        opener = MagicMock()
        opener.open.side_effect = urllib.error.HTTPError(
            "https://workspace--sheetsage-candidate.modal.run/health",
            302,
            "redirect",
            {},
            None,
        )
        with patch.object(validation, "build_opener", return_value=opener):
            with self.assertRaises(validation.DeploymentValidationError) as raised:
                validation.validate_deployment(
                    "https://workspace--sheetsage-candidate.modal.run",
                    "a" * 64,
                    token="secret",
                )
        self.assertEqual(
            str(raised.exception), "deployment validation failed: health_http_302"
        )


if __name__ == "__main__":
    unittest.main()