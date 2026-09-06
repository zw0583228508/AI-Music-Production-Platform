import json
import os
import sys
import unittest
import base64
import hashlib
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
import app as worker_app
import promote_modal

class BeatThisIsolationTests(unittest.TestCase):
    def test_runtime_pair_and_final0_are_exactly_pinned(self):
        manifest = json.loads((ROOT / "model_manifest.json").read_text())
        self.assertEqual(manifest["runtime"]["pytorch"], "2.5.1+cu124")
        self.assertEqual(manifest["runtime"]["torchvision"], "0.20.1+cu124")
        self.assertEqual(manifest["runtime"]["torchaudio"], "2.5.1+cu124")
        self.assertEqual(manifest["runtime"]["gpu"], "L4")
        self.assertEqual(
            manifest["checkpointSha256"],
            "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
        )

    def test_worker_is_fail_closed_and_never_uses_checkpoint_short_name(self):
        app_source = (ROOT / "app.py").read_text()
        docker = (ROOT / "Dockerfile").read_text()
        self.assertIn('checkpoint_path=str(CHECKPOINT)', app_source)
        self.assertNotIn('checkpoint_path="final0"', app_source)
        self.assertIn("torch.cuda.is_available()", app_source)
        self.assertIn("torch==2.5.1+cu124 torchvision==0.20.1+cu124 torchaudio==2.5.1+cu124", docker)
        self.assertIn("--no-deps", docker)

    def test_modal_boundary_reuses_shared_secret_and_has_private_l4_volume(self):
        source = (ROOT / "modal_app.py").read_text()
        self.assertIn('VOLUME_NAME = "beat-this-models-smoke-v1"', source)
        self.assertIn('SECRET_NAME = "music-ai-worker-runtime"', source)
        self.assertIn('IDENTITY_SECRET_NAME = "beat-this-deployment-identity-v1"', source)
        self.assertIn('"gpu": "L4"', source)
        self.assertIn("downloaded final0 does not match the reviewed SHA-256", source)
        self.assertIn("deploy through deploy.py", source)
        deploy_source = (ROOT / "deploy.py").read_text()
        self.assertIn('"git", "diff", "--quiet", "HEAD"', deploy_source)
        self.assertIn('"BEAT_THIS_SOURCE_REVISION": revision', deploy_source)

    def test_real_audio_fixture_is_built_from_the_reviewed_attachment(self):
        docker = (ROOT / "Dockerfile").read_text()
        modal_source = (ROOT / "modal_app.py").read_text()
        smoke_source = (ROOT / "smoke_test.py").read_text()
        source_sha = "ae58781b9d3ac4b6e57aaf94a146cb04565ea1b4cc58cc99cdc41cb507274749"
        self.assertIn(source_sha, docker)
        self.assertIn("ffmpeg -v error -ss 30 -t 30", docker)
        self.assertNotIn("sine=", docker)
        self.assertIn('IMAGE_SMOKE_FIXTURE = "/app/_smoke/real-audio.wav"', modal_source)
        for field in ("sourceSha256", "sampleRate", "channels", "frames", "durationSeconds"):
            self.assertIn(f'"{field}"', smoke_source)
        for field in ("beatCount", "downbeatCount", "firstBeats", "firstDownbeats"):
            self.assertIn(f'"{field}"', smoke_source)
        self.assertIn('"checkpoint":', smoke_source)
        self.assertIn('"fixture":', smoke_source)

    def test_health_and_bearer_boundary_fail_closed_without_attestation(self):
        with patch.object(worker_app, "runtime_ready", return_value=False), \
             patch.object(worker_app, "asset_ready", return_value=False), \
             patch.object(worker_app, "smoke_ready", return_value=False):
            health = worker_app.health()
        self.assertEqual(health["status"], "not_ready")
        self.assertFalse(health["ready"])
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(Exception) as raised:
                worker_app.auth(type("Request", (), {"headers": {}})())
        self.assertEqual(getattr(raised.exception, "status_code", None), 401)

    def test_first_health_after_container_refresh_is_retryable_not_server_error(self):
        with patch.object(
            worker_app, "runtime_ready",
            side_effect=worker_app.RuntimeInitializing("sensitive CUDA failure"),
        ):
            health = worker_app.health()
        self.assertEqual(health["status"], "starting")
        self.assertFalse(health["ready"])
        self.assertFalse(health["healthy"])
        self.assertTrue(health["retryable"])
        self.assertEqual(health["retryAfterSeconds"], 5)
        self.assertNotIn("CUDA", health["reason"])

        with patch.object(worker_app, "runtime_ready", return_value=True), \
             patch.object(worker_app, "asset_ready", side_effect=OSError("private path")):
            failed = worker_app.health()
        self.assertEqual(failed["status"], "not_ready")
        self.assertFalse(failed["retryable"])
        self.assertEqual(failed["reason"], "runtime readiness check failed")

    def test_release_health_retry_is_bounded_and_only_accepts_starting(self):
        expected = {
            "provider": "BEAT_THIS", "modalAppId": "ap-x",
            "modalDeploymentId": "v1", "modalFunctionId": "fu-x",
            "modalImageId": "im-x", "modelVersion": "1.1.0",
            "checkpointSha256": "a" * 64, "checkpointRevision": "model-rev",
            "sourceRevision": "b" * 40, "sourceImageDigest": "sha256:" + "c" * 64,
            "runtime": {
                "python": "3.11", "cudaImage": "cuda", "cuda": "12",
                "pytorch": "torch", "torchvision": "vision", "torchaudio": "audio",
                "torchIndexUrl": "index", "transformers": "transformers",
                "accelerate": "accelerate",
            },
        }
        ready = {
            **{key: value for key, value in expected.items() if key != "runtime"},
            "status": "ready", "ready": True, "healthy": True,
            "retryable": False, "retryAfterSeconds": None,
            "revision": expected["checkpointRevision"],
            "runtime": {"pythonVersion": "3.11"},
            "framework": {
                "cuda_image": "cuda", "cuda": "12", "pytorch": "torch",
                "torchvision": "vision", "torchaudio": "audio",
                "torch_index_url": "index", "transformers": "transformers",
                "accelerate": "accelerate",
            },
        }
        starting = {
            **ready, "status": "starting", "ready": False, "healthy": False,
            "retryable": True, "retryAfterSeconds": 5,
        }
        with patch.object(promote_modal.time, "sleep"), self.assertRaises(TimeoutError):
            promote_modal.verify_live_health_with_retries(
                lambda: starting, expected, attempts=2, delay_seconds=0
            )
        with self.assertRaises(ValueError):
            promote_modal.verify_live_health_with_retries(
                lambda: {"provider": "BEAT_THIS", "status": "not_ready",
                         "ready": False, "retryable": False},
                expected, attempts=2, delay_seconds=0,
            )

        rejected_startups = (
            {key: value for key, value in starting.items() if key != "runtime"},
            {key: value for key, value in starting.items() if key != "healthy"},
            {**starting, "retryAfterSeconds": 10},
            {**starting, "modalImageId": "im-other"},
        )
        for payload in rejected_startups:
            with self.subTest(payload=payload), patch.object(
                promote_modal.time, "sleep"
            ) as sleep, self.assertRaises(ValueError):
                fetch = unittest.mock.Mock(return_value=payload)
                promote_modal.verify_live_health_with_retries(
                    fetch, expected, attempts=2, delay_seconds=0
                )
            fetch.assert_called_once()
            sleep.assert_not_called()

        trusted_origin = promote_modal.INSTALLATION_STATUS["providers"]["BEAT_THIS"][
            "evidence"
        ]["liveHealthEndpointOrigin"]
        with patch.object(promote_modal.time, "sleep"), \
             patch.object(promote_modal, "fetch_authenticated_health",
                          return_value=ready) as refresh:
            with tempfile.TemporaryDirectory() as directory:
                health_file = Path(directory) / "cold-health.json"
                health_file.write_text(json.dumps(starting))
                promote_modal.verify_health_file_with_retries(
                    health_file, trusted_origin, expected,
                    "secret", attempts=2, delay_seconds=0,
                )
        refresh.assert_called_once_with(trusted_origin, "secret")

    def test_authenticated_retry_rejects_untrusted_origin_before_building_request(self):
        with patch.object(promote_modal, "Request") as request:
            with self.assertRaisesRegex(ValueError, "trusted Beat This"):
                promote_modal.fetch_authenticated_health(
                    "https://attacker.example.test", "secret"
                )
        request.assert_not_called()

    def test_bearer_prefers_provider_token_and_accepts_shared_fallback(self):
        request = type("Request", (), {"headers": {"authorization": "Bearer shared"}})()
        with patch.dict(os.environ, {"MUSIC_AI_WORKER_TOKEN": "shared"}, clear=True):
            worker_app.auth(request)
        with patch.dict(
            os.environ,
            {"BEAT_THIS_WORKER_TOKEN": "provider", "MUSIC_AI_WORKER_TOKEN": "shared"},
            clear=True,
        ):
            worker_app.auth(type("Request", (), {
                "headers": {"authorization": "Bearer provider"}
            })())
            with self.assertRaises(Exception):
                worker_app.auth(request)

    def test_health_contract_contains_complete_promotion_identity(self):
        source = (ROOT / "app.py").read_text()
        for field in ("modalAppId", "modalDeploymentId", "modalFunctionId",
                      "modalImageId", "checkpointSha256", "sourceRevision",
                      "sourceImageDigest", "framework"):
            self.assertIn(f'"{field}"', source)

    def test_nonstandard_signing_material_is_domain_separated_ed25519_seed(self):
        raw = b"x" * 24
        encoded, key_format = promote_modal.private_key_bytes(
            base64.b64encode(raw).decode()
        )
        self.assertEqual(key_format, "DER")
        self.assertEqual(encoded[:16], promote_modal.ED25519_PKCS8_PREFIX)
        self.assertEqual(
            encoded[16:],
            hashlib.sha256(promote_modal.KEY_DERIVATION_DOMAIN + raw).digest(),
        )

    def test_promotion_requires_matching_authenticated_health(self):
        expected = {
            "provider": "BEAT_THIS", "modalAppId": "ap-x",
            "modalDeploymentId": "v1", "modalFunctionId": "fu-x",
            "modalImageId": "im-x", "modelVersion": "1.1.0",
            "checkpointSha256": "a" * 64, "checkpointRevision": "model-rev",
            "sourceRevision": "b" * 40, "sourceImageDigest": "sha256:" + "c" * 64,
            "runtime": {
                "python": "3.11", "cudaImage": "cuda", "cuda": "12",
                "pytorch": "torch", "torchvision": "vision",
                "torchaudio": "audio", "torchIndexUrl": "index",
                "transformers": "transformers", "accelerate": "accelerate",
            },
        }
        health = {
            **{key: value for key, value in expected.items() if key != "runtime"},
            "status": "ready", "ready": True, "healthy": True,
            "retryable": False, "retryAfterSeconds": None,
            "revision": expected["checkpointRevision"],
            "runtime": {"pythonVersion": "3.11"},
            "framework": {
                "cuda_image": "cuda", "cuda": "12", "pytorch": "torch",
                "torchvision": "vision", "torchaudio": "audio",
                "torch_index_url": "index", "transformers": "transformers",
                "accelerate": "accelerate",
            },
        }
        promote_modal.verify_live_health(health, expected)
        health["modalImageId"] = "im-other"
        with self.assertRaises(ValueError):
            promote_modal.verify_live_health(health, expected)