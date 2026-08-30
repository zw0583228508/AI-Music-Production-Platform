import base64
import asyncio
import io
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).parents[1]))
import app


def wav64():
    stream = io.BytesIO()
    sf.write(stream, np.zeros((160, 1), dtype=np.float32), 8000, format="WAV")
    return base64.b64encode(stream.getvalue()).decode()


class WorkerTests(unittest.TestCase):
    def test_health_has_pinned_checksum(self):
        response = app.health("BASIC_PITCH")
        self.assertEqual(response["status"], "ok")
        self.assertEqual(len(response["checksum"]), 64)
        self.assertTrue(response["packageReady"])

    def test_package_readiness_uses_installed_distribution_version(self):
        details = {"package": "example-package", "version": "1.2.3"}
        with unittest.mock.patch.object(app, "installed_version", return_value="1.2.4"):
            self.assertFalse(app._package_is_pinned(details))
        with unittest.mock.patch.object(app, "installed_version", return_value="1.2.3"):
            self.assertTrue(app._package_is_pinned(details))

    def test_process_returns_pcm_wav(self):
        response = app.process(app.ProcessRequest(provider="PEDALBOARD_BUILTIN", audio_base64=wav64()))
        self.assertEqual(base64.b64decode(response["audio_base64"])[:4], b"RIFF")

    def test_render_never_fabricates_plugin_result(self):
        with unittest.mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(HTTPException) as error:
                app.render(app.RenderRequest(provider="VST3", audio_base64=wav64()))
        self.assertEqual(error.exception.status_code, 503)

    def test_source_resolution_rejects_private_and_reserved_addresses(self):
        for address in ("10.0.0.1", "127.0.0.1", "192.0.2.1", "169.254.1.1"):
            with self.subTest(address=address), unittest.mock.patch.object(
                app.socket, "getaddrinfo",
                return_value=[(app.socket.AF_INET, app.socket.SOCK_STREAM, 6, "", (address, 443))],
            ):
                with self.assertRaises(HTTPException) as error:
                    app._resolve_public_addresses("source.example", 443)
                self.assertEqual(error.exception.status_code, 400)

    def test_vetted_connection_connects_to_resolved_ip_not_hostname(self):
        connected_to = []

        class FakeSocket:
            def settimeout(self, timeout):
                self.timeout = timeout

            def connect(self, address):
                connected_to.append(address)

            def close(self):
                pass

        with unittest.mock.patch.object(app.socket, "socket", return_value=FakeSocket()):
            connection = app.VettedHTTPConnection(
                "public.example", 80, (app.socket.AF_INET, ("8.8.8.8", 80)), 1
            )
            connection.connect()
            connection.close()
        self.assertEqual(connected_to, [("8.8.8.8", 80)])

    def test_stem_artifacts_are_bounded_files_not_json_base64(self):
        with tempfile.TemporaryDirectory() as tmp, unittest.mock.patch.object(
            app, "ARTIFACTS", Path(tmp) / "artifacts"
        ):
            vocal = Path(tmp) / "vocals.flac"
            accompaniment = Path(tmp) / "instrumental.flac"
            vocal.write_bytes(b"vocal")
            accompaniment.write_bytes(b"music")
            artifact_id, stems = app._store_stems(vocal, accompaniment)
            self.assertRegex(artifact_id, app.ARTIFACT_ID)
            self.assertEqual({stem["name"] for stem in stems}, {"vocals.flac", "instrumental.flac"})
            self.assertTrue((app.ARTIFACTS / artifact_id / "vocals.flac").is_file())

    def test_both_stem_artifacts_can_be_downloaded_sequentially(self):
        with tempfile.TemporaryDirectory() as tmp, unittest.mock.patch.object(
            app, "ARTIFACTS", Path(tmp) / "artifacts"
        ):
            vocal = Path(tmp) / "vocals.flac"
            accompaniment = Path(tmp) / "instrumental.flac"
            vocal.write_bytes(b"vocal-stem")
            accompaniment.write_bytes(b"instrumental-stem")
            artifact_id, _ = app._store_stems(vocal, accompaniment)

            first = app.download_artifact(artifact_id, "vocals.flac")
            self.assertEqual(Path(first.path).read_bytes(), b"vocal-stem")
            asyncio.run(first.background())
            self.assertTrue(
                (app.ARTIFACTS / artifact_id / "instrumental.flac").is_file()
            )

            second = app.download_artifact(artifact_id, "instrumental.flac")
            self.assertEqual(Path(second.path).read_bytes(), b"instrumental-stem")
            asyncio.run(second.background())
            self.assertFalse((app.ARTIFACTS / artifact_id).exists())


if __name__ == "__main__":
    unittest.main()