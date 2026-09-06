import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
import app as worker_app

class BeatThisIsolationTests(unittest.TestCase):
    def test_runtime_pair_and_final0_are_exactly_pinned(self):
        manifest = json.loads((ROOT / "model_manifest.json").read_text())
        self.assertEqual(manifest["runtime"]["torch"], "2.5.1+cu124")
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
        self.assertIn("torch==2.5.1+cu124 torchaudio==2.5.1+cu124", docker)
        self.assertIn("--no-deps", docker)

    def test_modal_boundary_reuses_shared_secret_and_has_private_l4_volume(self):
        source = (ROOT / "modal_app.py").read_text()
        self.assertIn('VOLUME_NAME = "beat-this-models-smoke-v1"', source)
        self.assertIn('SECRET_NAME = "music-ai-worker-runtime"', source)
        self.assertIn('"gpu": "L4"', source)
        self.assertIn("downloaded final0 does not match the reviewed SHA-256", source)

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

    def test_installation_status_preserves_exact_promotion_blocker(self):
        status = json.loads((ROOT / "installation-status.json").read_text())
        beat_this = status["providers"]["BEAT_THIS"]
        evidence = beat_this["evidence"]
        self.assertEqual(beat_this["classification"], "BLOCKED_UPSTREAM")
        self.assertTrue(evidence["endpointConfigured"])
        self.assertTrue(evidence["realSmokeAndHealthObserved"])
        self.assertEqual(
            evidence["modalAppId"],
            "ap-PQ5CqhaR31JiEloxyPn8La",
        )
        self.assertFalse(evidence["signedPromotionRecordPresent"])
        self.assertFalse(evidence["promotionSigningKeyPairValidated"])
        self.assertIn("modalImageId", evidence["missingPromotionFields"])
        self.assertIn("sourceImageDigest", evidence["missingPromotionFields"])
        self.assertIn("runtime.accelerate", evidence["missingPromotionFields"])
        self.assertIn("Signing guessed values", beat_this["blockers"][0])