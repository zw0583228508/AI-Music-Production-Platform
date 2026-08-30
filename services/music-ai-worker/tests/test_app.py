import base64
import asyncio
import io
import json
import hashlib
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


def write_track_sensitive_renderer(path: Path):
    path.write_text("""#!/usr/bin/env python3
import argparse, hashlib, json, math, struct, wave
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--track-model")
p.add_argument("--sample-rate", type=int)
p.add_argument("--duration-seconds", type=float)
p.add_argument("--output")
p.add_argument("--attestation")
p.add_argument("--asset-identity")
p.add_argument("--library")
p.add_argument("--plugin")
a = p.parse_args()
track = json.loads(open(a.track_model).read())["trackModel"]
note = track["notes"][0]
cc = track.get("cc", [{"value": 127}])[0]["value"]
articulation = track.get("articulations", [{"name": "sustain"}])[0]["name"]
frequency = 440 * (2 ** ((note["pitch"] - 69) / 12))
gain = 0.05 + (cc / 127) * 0.2
with wave.open(a.output, "wb") as out:
    out.setnchannels(2)
    out.setsampwidth(2)
    out.setframerate(a.sample_rate)
    frames = int(a.sample_rate * a.duration_seconds)
    for i in range(frames):
        envelope = math.exp(-i / (a.sample_rate * 0.12)) if articulation == "staccato" else 1
        value = int(math.sin(2 * math.pi * frequency * i / a.sample_rate) * gain * envelope * 32767)
        out.writeframesraw(struct.pack("<hh", value, value))
def sha_tree(value):
    path = Path(value)
    digest = hashlib.sha256()
    if path.is_file():
        digest.update(path.read_bytes())
        return digest.hexdigest()
    for candidate in sorted(item for item in path.rglob("*") if item.is_file()):
        digest.update(str(candidate.relative_to(path)).encode())
        digest.update(b"\\0")
        digest.update(candidate.read_bytes())
    return digest.hexdigest()
asset_path = a.plugin or a.library
Path(a.attestation).write_text(json.dumps({
    "provider": "vst3" if a.plugin else "sfz",
    "assetIdentity": a.asset_identity,
    "assetSha256": sha_tree(asset_path),
    "rendererSha256": sha_tree(Path(__file__)),
    "trackModelSha256": sha_tree(a.track_model),
    "eventCounts": {
        "notes": len(track["notes"]),
        "cc": len(track["cc"]),
        "articulations": len(track["articulations"]),
        "automation": len(track["automation"]),
    },
    "outputSha256": sha_tree(a.output),
}))
""")
    path.chmod(0o700)


def write_fixed_tone_renderer(path: Path):
    path.write_text("""#!/usr/bin/env python3
import argparse, hashlib, json, math, struct, wave
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--track-model")
p.add_argument("--sample-rate", type=int)
p.add_argument("--duration-seconds", type=float)
p.add_argument("--output")
p.add_argument("--attestation")
p.add_argument("--asset-identity")
p.add_argument("--library")
a = p.parse_args()
with wave.open(a.output, "wb") as out:
    out.setnchannels(2)
    out.setsampwidth(2)
    out.setframerate(a.sample_rate)
    for i in range(int(a.sample_rate * a.duration_seconds)):
        value = int(math.sin(2 * math.pi * 220 * i / a.sample_rate) * 5000)
        out.writeframesraw(struct.pack("<hh", value, value))
def sha_tree(value):
    path = Path(value)
    digest = hashlib.sha256()
    if path.is_file():
        digest.update(path.read_bytes())
        return digest.hexdigest()
    for candidate in sorted(item for item in path.rglob("*") if item.is_file()):
        digest.update(str(candidate.relative_to(path)).encode())
        digest.update(b"\\0")
        digest.update(candidate.read_bytes())
    return digest.hexdigest()
track = json.loads(Path(a.track_model).read_text())["trackModel"]
Path(a.attestation).write_text(json.dumps({
    "provider": "sfz",
    "assetIdentity": a.asset_identity,
    "assetSha256": sha_tree(a.library),
    "rendererSha256": sha_tree(Path(__file__)),
    "trackModelSha256": sha_tree(a.track_model),
    "eventCounts": {
        "notes": len(track["notes"]),
        "cc": len(track["cc"]),
        "articulations": len(track["articulations"]),
        "automation": len(track["automation"]),
    },
    "outputSha256": sha_tree(a.output),
}))
""")
    path.chmod(0o700)


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

    def test_vst3_health_names_attested_asset_and_real_track_smoke(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plugin_path = root / "orchestra.vst3"
            plugin_path.write_bytes(b"licensed-vst3-test")
            renderer = root / "vst3-midi-host"
            write_track_sensitive_renderer(renderer)
            checksum = hashlib.sha256(plugin_path.read_bytes()).hexdigest()
            renderer_checksum = hashlib.sha256(renderer.read_bytes()).hexdigest()
            manifest_path = root / "licensed_assets.json"
            manifest_path.write_text(json.dumps({
                "vst3": {
                    "id": "orchestra-vst3",
                    "identity": "Test Vendor / Orchestra / 1.0",
                    "path": str(plugin_path),
                    "rendererPath": str(renderer),
                    "rendererIdentity": "Test VST3 MIDI Host / 1.0",
                    "rendererSha256": renderer_checksum,
                    "sha256": checksum,
                    "licenseOwner": "Test Organization",
                    "licenseReference": "test-license-record",
                }
            }))

            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", root),
                unittest.mock.patch.object(app, "ASSET_MANIFEST_PATH", manifest_path),
                unittest.mock.patch("pedalboard.load_plugin", return_value=object()),
            ):
                evidence = app.run_renderer_smoke("VST3")
                with unittest.mock.patch.object(
                    app, "_readiness_marker", return_value={"vst3": evidence}
                ):
                    health = app.renderer_health("VST3")
                    response = app.render(app.RenderRequest(
                        provider="VST3",
                        trackModel=app.canonical_render_smoke_track(),
                        sampleRate=22050,
                        durationSeconds=1,
                    ))

            self.assertTrue(health["healthy"])
            self.assertEqual(health["asset"]["identity"], "Test Vendor / Orchestra / 1.0")
            self.assertEqual(health["smokeEvidence"]["assetId"], "orchestra-vst3")
            self.assertEqual(response["trackModelId"], "renderer-smoke")
            self.assertEqual(base64.b64decode(response["audio_base64"])[:4], b"RIFF")

    def test_sfizz_renderer_executes_attested_native_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            library = root / "vsco2"
            library.mkdir()
            (library / "violin.sfz").write_text("<region> sample=violin.wav")
            (library / "violin.wav").write_bytes(b"licensed-sample-test")
            renderer = root / "sfizz-render-host"
            write_track_sensitive_renderer(renderer)
            renderer_checksum = hashlib.sha256(renderer.read_bytes()).hexdigest()
            checksum = app._sha256_tree(library)
            manifest_path = root / "licensed_assets.json"
            manifest_path.write_text(json.dumps({
                "sfz": {
                    "id": "vsco2-ce",
                    "identity": "Versilian Studios / VSCO 2 CE / Test",
                    "libraryPath": str(library),
                    "rendererPath": str(renderer),
                    "rendererIdentity": "Test sfizz Host / 1.0",
                    "rendererSha256": renderer_checksum,
                    "sha256": checksum,
                    "licenseOwner": "Test Organization",
                    "licenseReference": "VSCO 2 CE test license",
                }
            }))

            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", root),
                unittest.mock.patch.object(app, "ASSET_MANIFEST_PATH", manifest_path),
            ):
                evidence = app.run_renderer_smoke("SFIZZ_VSCO2_CE")
                with unittest.mock.patch.object(
                    app, "_readiness_marker", return_value={"sfizz": evidence}
                ):
                    health = app.renderer_health("SFIZZ_VSCO2_CE")

            self.assertTrue(health["healthy"])
            self.assertTrue(evidence["trackModelRendered"])
            self.assertTrue(evidence["canonicalSensitivity"])
            self.assertGreater(evidence["peak"], 0)

    def test_unlicensed_asset_stays_unhealthy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plugin_path = root / "unknown.vst3"
            plugin_path.write_bytes(b"unknown")
            manifest_path = root / "licensed_assets.json"
            manifest_path.write_text(json.dumps({
                "vst3": {
                    "id": "unknown",
                    "identity": "Unknown plugin",
                    "path": str(plugin_path),
                    "sha256": hashlib.sha256(plugin_path.read_bytes()).hexdigest(),
                }
            }))
            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", root),
                unittest.mock.patch.object(app, "ASSET_MANIFEST_PATH", manifest_path),
            ):
                health = app.renderer_health("VST3")
            self.assertFalse(health["healthy"])
            self.assertIn("licenseOwner", health["error"])

    def test_fixed_tone_native_host_cannot_pass_track_model_smoke(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            library = root / "library"
            library.mkdir()
            (library / "instrument.sfz").write_text("<region> sample=sample.wav")
            (library / "sample.wav").write_bytes(b"licensed-sample")
            renderer = root / "fixed-host"
            write_fixed_tone_renderer(renderer)
            manifest_path = root / "licensed_assets.json"
            manifest_path.write_text(json.dumps({
                "sfz": {
                    "id": "fixed-tone",
                    "identity": "Test fixed-tone library",
                    "libraryPath": str(library),
                    "rendererPath": str(renderer),
                    "rendererIdentity": "Rejected fixed host",
                    "rendererSha256": hashlib.sha256(renderer.read_bytes()).hexdigest(),
                    "sha256": app._sha256_tree(library),
                    "licenseOwner": "Test Organization",
                    "licenseReference": "test-license-record",
                }
            }))
            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", root),
                unittest.mock.patch.object(app, "ASSET_MANIFEST_PATH", manifest_path),
                self.assertRaises(HTTPException) as error,
            ):
                app.run_renderer_smoke("SFIZZ_VSCO2_CE")
            self.assertIn("did not respond to TrackModel", str(error.exception.detail))

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