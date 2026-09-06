import base64
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parents[1]))
import app


class MirWorkerTests(unittest.TestCase):
    def test_madmom_phase_two_assets_are_explicitly_pinned(self):
        assets = app.MANIFEST["providers"]["MADMOM"]["assets"]
        self.assertEqual(len(assets), 8)
        self.assertEqual(
            {Path(asset["path"]).name for asset in assets},
            {f"downbeats_blstm_{index}.pkl" for index in range(1, 9)},
        )
        self.assertTrue(all(len(asset["sha256"]) == 64 for asset in assets))

    def test_auth_fails_closed_and_madmom_is_not_ready_without_assets(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(Exception):
                app._auth(type("Request", (), {"headers": {}})())
        with patch.dict(os.environ, {"MIR_WORKER_TOKEN": "test"}, clear=True):
            result = app.health("MADMOM")
        self.assertFalse(result["ready"])

    def test_request_requires_one_source(self):
        with self.assertRaises(ValueError):
            app.AnalysisRequest(provider="PYLOUDNORM")

    def test_decodes_real_wav_and_rejects_silence(self):
        stream = io.BytesIO()
        sf.write(stream, np.zeros((800, 1), dtype=np.float32), 8000, format="WAV")
        request = app.AnalysisRequest(provider="PYLOUDNORM",
            audioBase64=base64.b64encode(stream.getvalue()).decode())
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(Exception):
                app._decode(request, Path(directory))