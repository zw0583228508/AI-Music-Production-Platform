import importlib.util
import sys
import types
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("sheetsage_modal_app", ROOT / "modal_app.py")
modal_app = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(modal_app)


class ModalReleaseTests(unittest.TestCase):
    def test_release_smokes_deploys_then_validates_modal_derived_endpoint(self):
        events = []
        provision_app = MagicMock()
        provision_app.run.return_value = nullcontext()
        smoke_remote = MagicMock()
        smoke_remote.remote.side_effect = lambda fixture: (
            events.append(("smoke", fixture))
            or {"manifestSha256": "a" * 64}
        )
        provision_module = types.SimpleNamespace(
            app=provision_app, smoke_remote=smoke_remote
        )
        validation_module = types.SimpleNamespace(
            validate_deployment=lambda endpoint, checksum: (
                events.append(("validate", endpoint, checksum))
                or {
                    "provider": "SHEETSAGE",
                    "version": "0.2.1",
                    "checksum": checksum,
                    "validatedGates": ["assets_verified"],
                }
            )
        )
        with patch.dict(
            sys.modules,
            {
                "modal_provision": provision_module,
                "deployment_validation": validation_module,
            },
        ), patch.object(
            modal_app.app,
            "deploy",
            side_effect=lambda **kwargs: events.append(("deploy", kwargs["strategy"])),
        ), patch.object(
            modal_app,
            "deployed_candidate_endpoint_url",
            return_value="https://workspace--sheetsage-worker-candidate-sheetsage.modal.run",
        ):
            result = modal_app.deploy_and_validate("licensed.wav")
        self.assertTrue(result["validated"])
        self.assertEqual(
            events,
            [
                ("smoke", "licensed.wav"),
                ("deploy", "recreate"),
                (
                    "validate",
                    "https://workspace--sheetsage-worker-candidate-sheetsage.modal.run",
                    "a" * 64,
                ),
                ("deploy", "rolling"),
            ],
        )

    def test_failed_candidate_attestation_never_deploys_production(self):
        events = []
        provision_app = MagicMock()
        provision_app.run.return_value = nullcontext()
        smoke_remote = MagicMock()
        smoke_remote.remote.return_value = {"manifestSha256": "a" * 64}
        provision_module = types.SimpleNamespace(
            app=provision_app, smoke_remote=smoke_remote
        )

        def reject_candidate(endpoint, checksum):
            events.append(("validate", endpoint))
            raise RuntimeError("deployment validation failed: checkpoint_ready")

        validation_module = types.SimpleNamespace(
            validate_deployment=reject_candidate
        )

        def record_deploy(**kwargs):
            events.append(("deploy", kwargs["name"], kwargs["strategy"]))

        with patch.dict(
            sys.modules,
            {
                "modal_provision": provision_module,
                "deployment_validation": validation_module,
            },
        ), patch.object(
            modal_app.app, "deploy", side_effect=record_deploy
        ), patch.object(
            modal_app,
            "deployed_candidate_endpoint_url",
            return_value="https://workspace--sheetsage-worker-candidate-sheetsage.modal.run",
        ):
            with self.assertRaisesRegex(RuntimeError, "checkpoint_ready"):
                modal_app.deploy_and_validate("licensed.wav")

        self.assertEqual(
            events,
            [
                (
                    "deploy",
                    modal_app.CANDIDATE_APP_NAME,
                    "recreate",
                ),
                (
                    "validate",
                    "https://workspace--sheetsage-worker-candidate-sheetsage.modal.run",
                ),
            ],
        )


if __name__ == "__main__":
    unittest.main()