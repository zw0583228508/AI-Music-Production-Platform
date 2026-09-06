import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import modal_app


class ModalConfigTests(unittest.TestCase):
    def test_isolated_modal_boundary(self):
        self.assertEqual(modal_app.APP_NAME, "music-mir-worker")
        self.assertEqual(modal_app.PY311_VOLUME_NAME, "music-mir-py311-models-smoke-v1")
        self.assertEqual(modal_app.PY314_VOLUME_NAME, "music-mir-py314-models-smoke-v1")
        self.assertEqual(modal_app.RUNTIME_SECRET_NAME, "music-ai-worker-runtime")
        self.assertEqual(modal_app.ASSET_MOUNT, "/var/lib/music-mir/assets")

    def test_shared_py311_runtime_has_no_beat_this_dependency_or_exposure(self):
        root = Path(__file__).parents[1]
        requirements = (root / "requirements-py311.txt").read_text(encoding="utf-8").lower()
        dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn("beat-this", requirements)
        self.assertNotIn("BEAT_THIS", dockerfile)

    def test_fixture_is_bounded_to_volume(self):
        self.assertEqual(modal_app._relative_fixture("_smoke/real.wav").as_posix(), "_smoke/real.wav")
        for unsafe in ("/etc/passwd", "../fixture.wav", ""):
            with self.assertRaises(ValueError):
                modal_app._relative_fixture(unsafe)

    def test_smoke_log_tail_redacts_private_values_and_is_bounded(self):
        value = "x" * 3000 + " Bearer secret-value https://private.example/a?token=x SOURCE_URL=https://audio.example/a"
        sanitized = modal_app._redacted_tail(value)
        self.assertLessEqual(len(sanitized), 2048)
        self.assertNotIn("secret-value", sanitized)
        self.assertNotIn("private.example", sanitized)
        self.assertNotIn("audio.example", sanitized)
