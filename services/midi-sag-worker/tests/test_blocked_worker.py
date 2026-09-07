import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


WORKER = Path(__file__).parents[1]
sys.path.insert(0, str(WORKER))
app_module = importlib.import_module("app")


class FakeRequest:
    def __init__(self, token):
        self.headers = {"Authorization": f"Bearer {token}"}


class BlockedWorkerTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(
            os.environ,
            {
                "MIDI_SAG_API_TOKEN": "midi-token",
                "MUSE_CONTROL_LITE_API_TOKEN": "muse-token",
            },
            clear=False,
        )
        self.environment.start()

    def tearDown(self):
        self.environment.stop()

    def test_health_uses_identity_specific_authentication(self):
        midi = app_module.health(FakeRequest("midi-token"))
        self.assertEqual(midi["provider"], "MIDI_SAG")

        with self.assertRaises(HTTPException) as wrong_identity:
            app_module.health(
                FakeRequest("midi-token"),
                provider="MUSE_CONTROL_LITE",
            )
        self.assertEqual(wrong_identity.exception.status_code, 401)

        muse = app_module.health(
            FakeRequest("muse-token"),
            provider="MUSE_CONTROL_LITE",
        )
        self.assertEqual(muse["provider"], "MUSE_CONTROL_LITE")

    def test_each_health_state_is_terminal_and_muse_has_no_midi_smoke(self):
        midi = app_module.health(FakeRequest("midi-token"))
        muse = app_module.health(
            FakeRequest("muse-token"),
            provider="MUSE_CONTROL_LITE",
        )
        self.assertEqual(midi["status"], "BLOCKED_UPSTREAM")
        self.assertEqual(muse["status"], "BLOCKED_MISSING_LICENSED_ASSET")
        for state in (midi, muse):
            self.assertFalse(state["healthy"])
            self.assertFalse(state["runtimeReady"])
            self.assertFalse(state["checkpointReady"])
            self.assertFalse(state["smokeTested"])
        self.assertEqual(muse["modelVersion"], "UNVERIFIED")
        self.assertTrue(all(
            "MIDI evidence is not evidence" not in finding
            for finding in midi["findings"]
        ))
        self.assertTrue(any(
            "not evidence" in finding for finding in muse["findings"]
        ))

    def test_missing_identity_token_fails_closed(self):
        with patch.dict(
            os.environ,
            {"MIDI_SAG_API_TOKEN": "midi-token"},
            clear=True,
        ):
            with self.assertRaises(HTTPException) as missing:
                app_module.health(
                    FakeRequest("midi-token"),
                    provider="MUSE_CONTROL_LITE",
                )
        self.assertEqual(missing.exception.status_code, 503)

    def test_arrange_blocks_before_decoding_or_inference(self):
        payload = app_module.ArrangeRequest(vocalWavBase64="%%%%")
        with patch.object(
            app_module,
            "run_pipeline",
            side_effect=AssertionError("inference must not execute while blocked"),
        ) as run_pipeline:
            with self.assertRaises(HTTPException) as blocked:
                app_module.arrange(payload, FakeRequest("midi-token"))
        self.assertEqual(blocked.exception.status_code, 503)
        self.assertIn("BLOCKED", blocked.exception.detail)
        run_pipeline.assert_not_called()

    def test_midi_validation_rejects_truncated_track_chunk(self):
        inference = importlib.import_module("inference")
        self.assertFalse(inference.valid_midi(
            b"MThd\0\0\0\6\0\1\0\1\1\xe0"
            b"MTrk\0\0\0\14\0\x90\x3c"
        ))


if __name__ == "__main__":
    unittest.main()