import argparse
import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

import activate_promotion
import promote_modal
import release_modal


def release_evidence():
    manifest = promote_modal.MANIFEST
    return {
        "schemaVersion": 1,
        "provider": "BEAT_THIS",
        "modalAppId": "ap-Test",
        "modalDeploymentId": "v7",
        "modalFunctionId": "fu-Test",
        "modalImageId": "im-Test",
        "endpointOrigin": "https://beat-this.example.test",
        "sourceRevision": "b" * 40,
        "sourceImageDigest": "sha256:" + "c" * 64,
        "smokeEvidence": {
            "provider": "BEAT_THIS",
            "featureExecutionSucceeded": True,
            "checkpoint": {
                "name": "final0",
                "sha256": manifest["checkpointSha256"],
            },
            "fixture": {
                "sourceSha256": "d" * 64,
                "sha256": "e" * 64,
                "sampleRate": 44100,
                "channels": 2,
                "frames": 1000,
                "durationSeconds": 1.0,
            },
            "result": {
                "beatCount": 4,
                "downbeatCount": 1,
                "firstBeats": [0.0, 0.5, 1.0, 1.5],
                "firstDownbeats": [0.0],
                "confidence": 0.9,
            },
        },
    }


def promotion_record(evidence):
    return promote_modal.record(argparse.Namespace(
        modal_app_id=evidence["modalAppId"],
        modal_deployment_id=evidence["modalDeploymentId"],
        modal_function_id=evidence["modalFunctionId"],
        modal_image_id=evidence["modalImageId"],
        endpoint_origin=evidence["endpointOrigin"],
        source_revision=evidence["sourceRevision"],
        source_image_digest=evidence["sourceImageDigest"],
        release_evidence_sha256=promote_modal.release_evidence_sha256(evidence),
    ))


def matching_health(record):
    runtime = record["runtime"]
    return {
        "provider": "BEAT_THIS",
        "status": "ready",
        "ready": True,
        "healthy": True,
        "retryable": False,
        "retryAfterSeconds": None,
        "checksum": record["checkpointSha256"],
        "modalAppId": record["modalAppId"],
        "modalDeploymentId": record["modalDeploymentId"],
        "modalFunctionId": record["modalFunctionId"],
        "modalImageId": record["modalImageId"],
        "modelVersion": record["modelVersion"],
        "checkpointSha256": record["checkpointSha256"],
        "revision": record["checkpointRevision"],
        "sourceRevision": record["sourceRevision"],
        "sourceImageDigest": record["sourceImageDigest"],
        "runtime": {"pythonVersion": runtime["python"]},
        "framework": {
            "python": runtime["python"],
            "cuda_image": runtime["cudaImage"],
            "cuda": runtime["cuda"],
            "pytorch": runtime["pytorch"],
            "torchvision": runtime["torchvision"],
            "torchaudio": runtime["torchaudio"],
            "torch_index_url": runtime["torchIndexUrl"],
            "transformers": runtime["transformers"],
            "accelerate": runtime["accelerate"],
        },
        "packageName": "beat-this",
        "packageVersion": record["modelVersion"],
        "packageReady": True,
        "assetReady": True,
        "featureExecutionReady": True,
        "runtimeReady": True,
        "checkpointReady": True,
        "smokeTested": True,
        "gpuReady": True,
        "identityReady": True,
        "reason": None,
    }


def container_refresh(evidence):
    return {
        "schemaVersion": 1,
        "provider": "BEAT_THIS",
        "modalAppId": evidence["modalAppId"],
        "modalDeploymentId": evidence["modalDeploymentId"],
        "stoppedContainerIds": ["ta-Old"],
        "staleContainerIds": [],
    }


class BeatThisReleaseTests(unittest.TestCase):
    def test_health_request_budget_covers_a_real_gpu_cold_start(self):
        self.assertEqual(release_modal.HEALTH_REQUEST_TIMEOUT_SECONDS, 300)

    def test_release_activation_uses_a_reviewed_source_revision_branch(self):
        repository = Path(__file__).resolve().parents[3]
        workflow = (
            repository / ".github/workflows/release-beat-this.yml"
        ).read_text()

        self.assertIn("pull-requests: write", workflow)
        self.assertIn(
            'activation_branch="beat-this-activation/$SOURCE_REVISION"',
            workflow,
        )
        self.assertIn('--base "$RELEASE_BRANCH"', workflow)
        self.assertIn('--head "$activation_branch"', workflow)
        self.assertIn(
            'git push origin "HEAD:refs/heads/$activation_branch"',
            workflow,
        )
        self.assertNotIn('git push origin "HEAD:$RELEASE_BRANCH"', workflow)
        self.assertIn("Reopen or merge this same pull request", workflow)
        self.assertIn("deploy.py --candidate", workflow)
        self.assertIn("verify-candidate-refresh", workflow)
        self.assertIn("promotion/candidate-refresh-health.json", workflow)

    def test_modal_metadata_requires_one_deployed_app_and_latest_version(self):
        self.assertEqual(
            release_modal.deployed_app_id([
                {"app_id": "ap-Old", "description": "beat-this-worker",
                 "state": "stopped"},
                {"app_id": "ap-Live", "description": "beat-this-worker",
                 "state": "deployed"},
            ]),
            "ap-Live",
        )
        self.assertEqual(
            release_modal.deployed_version([{"version": "v12"}]),
            "v12",
        )
        with self.assertRaises(ValueError):
            release_modal.deployed_app_id([
                {"app_id": "ap-One", "description": "beat-this-worker",
                 "state": "deployed"},
                {"app_id": "ap-Two", "description": "beat-this-worker",
                 "state": "deployed"},
            ])
        metadata = {
            "modalAppId": "ap-Live",
            "modalDeploymentId": "v12",
            "modalFunctionId": "fu-Live",
            "endpointOrigin": "https://beat-this.example.test",
        }
        self.assertEqual(
            release_modal.identity(metadata),
            {
                "BEAT_THIS_MODAL_APP_ID": "ap-Live",
                "BEAT_THIS_MODAL_DEPLOYMENT_ID": "v12",
                "BEAT_THIS_MODAL_FUNCTION_ID": "fu-Live",
            },
        )

    def test_real_smoke_evidence_is_required(self):
        evidence = release_evidence()
        release_modal.validate_release_evidence(evidence)
        evidence["smokeEvidence"]["result"]["downbeatCount"] = 0
        with self.assertRaisesRegex(ValueError, "smoke evidence"):
            release_modal.validate_release_evidence(evidence)

    def test_release_health_retries_only_explicit_startup(self):
        evidence = release_evidence()
        ready = matching_health(promotion_record(evidence))
        starting = {
            **ready,
            **promote_modal.STARTUP_HEALTH_CONTRACT,
            "packageReady": False,
            "assetReady": False,
            "featureExecutionReady": False,
            "runtimeReady": False,
            "checkpointReady": False,
            "smokeTested": False,
            "gpuReady": False,
        }
        with patch.object(
            release_modal, "read_health", side_effect=[starting, ready]
        ) as fetch, patch.object(promote_modal.time, "sleep"):
            self.assertEqual(
                release_modal.verified_health(evidence, "token", attempts=2),
                ready,
            )
        self.assertEqual(fetch.call_count, 2)

        rejected = (
            {
                "provider": "BEAT_THIS",
                "status": "not_ready",
                "ready": False,
                "retryable": False,
            },
            {**ready, "modalFunctionId": "fu-Wrong"},
            {"provider": "BEAT_THIS", "status": "ready", "ready": True},
        )
        for payload in rejected:
            with self.subTest(payload=payload), patch.object(
                release_modal, "read_health", return_value=payload
            ) as fetch, self.assertRaises(ValueError):
                release_modal.verified_health(evidence, "token", attempts=3)
            fetch.assert_called_once()

        with patch.object(
            release_modal, "read_health", side_effect=OSError("network failed")
        ) as fetch, self.assertRaises(OSError):
            release_modal.verified_health(evidence, "token", attempts=3)
        fetch.assert_called_once()

    def test_container_refresh_waits_for_modal_stop_convergence(self):
        with patch.object(
            release_modal,
            "running_container_ids",
            side_effect=[["ta-Old"], ["ta-Old"], []],
        ) as containers, patch.object(release_modal.time, "sleep") as sleep:
            release_modal.wait_for_stopped_containers(
                "ap-Live", ["ta-Old"], attempts=3, delay_seconds=1
            )
        self.assertEqual(containers.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

        with patch.object(
            release_modal,
            "running_container_ids",
            return_value=["ta-Old"],
        ), patch.object(release_modal.time, "sleep"), self.assertRaisesRegex(
            RuntimeError, "old Beat This containers"
        ):
            release_modal.wait_for_stopped_containers(
                "ap-Live", ["ta-Old"], attempts=2, delay_seconds=0
            )

    def test_candidate_refresh_uses_trusted_derived_origin_and_evidence(self):
        evidence = release_evidence()
        expected = release_modal.expected_health(evidence)
        report = {"provider": "BEAT_THIS", "finalStatus": "ready"}
        with patch.object(
            promote_modal,
            "candidate_origin_from_production",
            return_value="https://workspace--beat-this-candidate.modal.run",
        ) as derive, patch.object(
            promote_modal,
            "refresh_candidate_and_verify",
            return_value=report,
        ) as refresh:
            self.assertEqual(
                release_modal.verified_candidate_refresh(
                    evidence, "token", attempts=4
                ),
                report,
            )
        derive.assert_called_once_with(evidence["endpointOrigin"])
        refresh.assert_called_once_with(
            "https://workspace--beat-this-candidate.modal.run",
            "token",
            expected,
            attempts=4,
            delay_seconds=10,
        )

    def test_validation_precedes_canonical_record_replacement(self):
        evidence = release_evidence()
        record = promotion_record(evidence)
        health = matching_health(record)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_key = root / "private.pem"
            public_key = root / "public.pem"
            api_output = root / "promotion.generated.ts"
            release_output = root / "release.json"
            subprocess.run(
                ["openssl", "genpkey", "-algorithm", "Ed25519",
                 "-out", str(private_key)],
                check=True,
            )
            public_key.write_text(promote_modal.public_key(private_key))
            bundle = {
                "record": record,
                "signature": promote_modal.sign(record, private_key),
            }
            activate_promotion.activate(
                bundle,
                public_key.read_text(),
                evidence,
                container_refresh(evidence),
                health,
                api_output,
                release_output,
            )
            bundle_literal = (
                api_output.read_text().splitlines()[1].split(" = ", 1)[1][:-1]
            )
            self.assertEqual(
                json.loads(bundle_literal),
                promote_modal.canonical(bundle),
            )
            retained = json.loads(release_output.read_text())
            self.assertEqual(
                retained["smokeEvidence"]["result"]["beatCount"],
                4,
            )
            self.assertEqual(
                retained["containerRefresh"]["staleContainerIds"],
                [],
            )
            original_api = api_output.read_text()
            original_release = release_output.read_text()
            broken_health = {**health, "modalImageId": "im-Other"}
            with self.assertRaisesRegex(ValueError, "live health"):
                activate_promotion.activate(
                    bundle,
                    public_key.read_text(),
                    evidence,
                    container_refresh(evidence),
                    broken_health,
                    api_output,
                    release_output,
                )
            self.assertEqual(api_output.read_text(), original_api)
            self.assertEqual(release_output.read_text(), original_release)

    def test_legacy_key_material_produces_verifiable_ed25519_signature(self):
        normalized, key_format = promote_modal.private_key_bytes(
            base64.b64encode(b"legacy-provider-key-material").decode()
        )
        evidence = release_evidence()
        record = promotion_record(evidence)
        with tempfile.TemporaryDirectory() as directory:
            key_path = Path(directory) / "private.der"
            key_path.write_bytes(normalized)
            signature = promote_modal.sign(record, key_path, key_format)
            public_key = promote_modal.public_key(key_path, key_format)
            activate_promotion.verify_signature(record, signature, public_key)


if __name__ == "__main__":
    unittest.main()