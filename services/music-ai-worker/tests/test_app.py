import base64
import asyncio
import copy
import io
import json
import hashlib
import sys
import tempfile
import types
import unittest
import unittest.mock
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import soundfile as sf
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).parents[1]))
import app

from capability_boundary import (
    require_symbolic_packages,
    smoke_midi_round_trip,
    smoke_pedalboard_builtins,
)


def wav64():
    stream = io.BytesIO()
    sf.write(stream, np.zeros((160, 1), dtype=np.float32), 8000, format="WAV")
    return base64.b64encode(stream.getvalue()).decode()


def protected_route_status(
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    payload: dict | None = None,
) -> int:
    """Exercise the ASGI route/dependency stack without an httpx test client."""
    body = json.dumps(payload).encode() if payload is not None else b""
    target = urlsplit(path)
    request_headers = [(key.lower().encode(), value.encode()) for key, value in (headers or {}).items()]
    if body:
        request_headers.extend([
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ])
    sent = False
    response_status = None

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        nonlocal response_status
        if message["type"] == "http.response.start":
            response_status = message["status"]

    asyncio.run(app.app({
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": target.path,
        "raw_path": target.path.encode(),
        "query_string": target.query.encode(),
        "headers": request_headers,
        "client": ("127.0.0.1", 12345),
        "server": ("worker.test", 80),
    }, receive, send))
    assert response_status is not None
    return response_status


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
    def test_provider_endpoints_fail_closed_without_a_configured_token(self):
        for environment in ({}, {"MUSIC_AI_WORKER_TOKEN": "   "}):
            with self.subTest(blank=bool(environment)), unittest.mock.patch.dict(
                app.os.environ, environment, clear=True
            ):
                for provider in (
                    "BASIC_PITCH",
                    "DEMUCS",
                    "PEDALBOARD_BUILTIN",
                    "VST3",
                    "SFIZZ_VSCO2_CE",
                ):
                    with self.subTest(provider=provider):
                        self.assertEqual(
                            protected_route_status("GET", f"/health?provider={provider}"),
                            401,
                        )
                self.assertEqual(
                    protected_route_status(
                        "POST",
                        "/process",
                        payload={"provider": "PEDALBOARD_BUILTIN", "audio_base64": wav64()},
                    ),
                    401,
                )

    def test_provider_endpoints_reject_missing_or_wrong_bearer_tokens(self):
        with unittest.mock.patch.dict(
            app.os.environ, {"MUSIC_AI_WORKER_TOKEN": "worker-test-token"}, clear=True
        ):
            for headers in ({}, {"Authorization": "Bearer wrong-token"}):
                for provider in (
                    "BASIC_PITCH",
                    "DEMUCS",
                    "PEDALBOARD_BUILTIN",
                    "VST3",
                    "SFIZZ_VSCO2_CE",
                ):
                    with self.subTest(headers=bool(headers), provider=provider):
                        self.assertEqual(
                            protected_route_status(
                                "GET", f"/health?provider={provider}", headers=headers
                            ),
                            401,
                        )
                self.assertEqual(
                    protected_route_status(
                        "POST",
                        "/process",
                        headers=headers,
                        payload={"provider": "PEDALBOARD_BUILTIN", "audio_base64": wav64()},
                    ),
                    401,
                )

    def test_provider_endpoints_accept_the_configured_bearer_token(self):
        with unittest.mock.patch.dict(
            app.os.environ, {"MUSIC_AI_WORKER_TOKEN": "worker-test-token"}, clear=True
        ):
            headers = {"Authorization": "Bearer worker-test-token"}
            for provider in (
                "BASIC_PITCH",
                "DEMUCS",
                "PEDALBOARD_BUILTIN",
                "VST3",
                "SFIZZ_VSCO2_CE",
            ):
                with self.subTest(provider=provider):
                    self.assertEqual(
                            protected_route_status(
                                "GET", f"/health?provider={provider}", headers=headers
                            ),
                        200,
                    )
            self.assertEqual(
                protected_route_status(
                    "POST",
                    "/process",
                    headers=headers,
                    payload={"provider": "PEDALBOARD_BUILTIN", "audio_base64": wav64()},
                ),
                200,
            )

    def test_symbolic_python_capability_imports(self):
        require_symbolic_packages()

    def test_minimal_midi_round_trip_serializes_across_supported_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            evidence = smoke_midi_round_trip(Path(tmp))
        self.assertGreaterEqual(evidence["noteOnEvents"], 1)
        self.assertGreaterEqual(evidence["tracks"], 1)

    def test_pedalboard_builtin_processing_is_non_silent_and_finite(self):
        evidence = smoke_pedalboard_builtins()
        self.assertEqual(evidence["channels"], 1)
        self.assertEqual(evidence["frames"], 128)
        self.assertGreater(evidence["peak"], 0)
        self.assertLess(evidence["peak"], 1)

    def test_native_adapters_are_explicitly_unavailable_without_attestation(self):
        with unittest.mock.patch.dict("os.environ", {}, clear=True):
            for provider in ("VST3", "SFIZZ_VSCO2_CE"):
                with self.subTest(provider=provider):
                    health = app.renderer_health(provider)
                    self.assertEqual(health["status"], "unavailable")
                    self.assertFalse(health["healthy"])
                    self.assertTrue(health["optionalAdapter"])
                    self.assertTrue(health["reason"])
                    self.assertEqual(
                        health["requirements"],
                        app.NATIVE_ADAPTER_REQUIREMENTS[provider],
                    )

    def test_file_checksum_is_streamed_in_bounded_chunks(self):
        payload = (b"licensed-large-pack" * (2 * 1024 * 1024 // 19 + 1))[:2 * 1024 * 1024]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "large.vst3"
            path.write_bytes(payload)
            with unittest.mock.patch.object(
                Path,
                "read_bytes",
                side_effect=AssertionError("large asset hashing must not read all bytes"),
            ):
                checksum = app._sha256(path)
        self.assertEqual(checksum, hashlib.sha256(payload).hexdigest())

    def test_asset_upload_uses_its_own_large_request_limit(self):
        async def run_request(path: str, size: int):
            request = app.FastAPIRequest(
                {
                    "type": "http",
                    "method": "POST",
                    "path": path,
                    "headers": [(b"content-length", str(size).encode())],
                }
            )

            async def call_next(_request):
                return app.JSONResponse({"accepted": True})

            return await app.request_size_limit(request, call_next)

        large_pack = app.MAX_INPUT_BYTES * 2 + 1
        upload_response = asyncio.run(run_request("/admin/assets/stage", large_pack))
        json_response = asyncio.run(run_request("/analyze", large_pack))
        self.assertEqual(upload_response.status_code, 200)
        self.assertEqual(json_response.status_code, 413)

    def test_asset_admin_authentication_fails_closed_without_worker_token(self):
        request = app.FastAPIRequest(
            {
                "type": "http",
                "method": "GET",
                "path": "/admin/assets",
                "headers": [],
            }
        )
        with (
            unittest.mock.patch.dict(app.os.environ, {}, clear=True),
            self.assertRaises(HTTPException) as error,
        ):
            app._require_admin_auth(request)
        self.assertEqual(error.exception.status_code, 401)

    def test_uploaded_native_host_must_match_approved_registry(self):
        approved = json.dumps(
            [{"kind": "sfz", "identity": "Approved Host", "sha256": "a" * 64}]
        )
        with unittest.mock.patch.dict(
            app.os.environ, {"MUSIC_AI_APPROVED_NATIVE_HOSTS": approved}
        ):
            app._require_approved_native_host("sfz", "Approved Host", "a" * 64)
            with self.assertRaises(HTTPException) as error:
                app._require_approved_native_host("sfz", "Approved Host", "b" * 64)
        self.assertEqual(error.exception.status_code, 403)

    def test_unapproved_vst3_never_reaches_smoke_renderer(self):
        plugin_bytes = b"unapproved-native-plugin"
        host_bytes = b"#!/bin/sh\nexit 0\n"
        host_checksum = hashlib.sha256(host_bytes).hexdigest()
        host_registry = json.dumps(
            [
                {
                    "kind": "vst3",
                    "identity": "Approved MIDI Host",
                    "sha256": host_checksum,
                }
            ]
        )

        async def stage():
            return await app._stage_asset_candidate(
                "vst3",
                "licensed-piano",
                "Licensed Piano / 1.0",
                "Test Studio",
                "license-vst",
                "Approved MIDI Host",
                [app.UploadFile(filename="piano.vst3", file=io.BytesIO(plugin_bytes))],
                app.UploadFile(filename="host", file=io.BytesIO(host_bytes)),
            )

        with tempfile.TemporaryDirectory() as tmp:
            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", Path(tmp)),
                unittest.mock.patch.dict(
                    app.os.environ,
                    {
                        "MUSIC_AI_APPROVED_NATIVE_HOSTS": host_registry,
                        "MUSIC_AI_APPROVED_VST3_ASSETS": "[]",
                    },
                ),
                unittest.mock.patch.object(app, "run_renderer_smoke") as smoke,
                self.assertRaises(HTTPException) as error,
            ):
                asyncio.run(stage())

        self.assertEqual(error.exception.status_code, 403)
        smoke.assert_not_called()

    def test_approved_vst3_can_reach_smoke_verification(self):
        plugin_bytes = b"approved-native-plugin"
        host_bytes = b"#!/bin/sh\nexit 0\n"
        plugin_checksum = hashlib.sha256(plugin_bytes).hexdigest()
        host_checksum = hashlib.sha256(host_bytes).hexdigest()
        registries = {
            "MUSIC_AI_APPROVED_NATIVE_HOSTS": json.dumps(
                [
                    {
                        "kind": "vst3",
                        "identity": "Approved MIDI Host",
                        "sha256": host_checksum,
                    }
                ]
            ),
            "MUSIC_AI_APPROVED_VST3_ASSETS": json.dumps(
                [
                    {
                        "assetId": "licensed-piano",
                        "identity": "Licensed Piano / 1.0",
                        "sha256": plugin_checksum,
                    }
                ]
            ),
        }
        evidence = {
            "audible": True,
            "canonicalSensitivity": True,
            "nativeHostAttested": True,
        }

        async def stage():
            return await app._stage_asset_candidate(
                "vst3",
                "licensed-piano",
                "Licensed Piano / 1.0",
                "Test Studio",
                "license-vst",
                "Approved MIDI Host",
                [app.UploadFile(filename="piano.vst3", file=io.BytesIO(plugin_bytes))],
                app.UploadFile(filename="host", file=io.BytesIO(host_bytes)),
            )

        with tempfile.TemporaryDirectory() as tmp:
            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", Path(tmp)),
                unittest.mock.patch.dict(app.os.environ, registries),
                unittest.mock.patch.object(
                    app, "run_renderer_smoke", return_value=evidence
                ) as smoke,
            ):
                candidate = asyncio.run(stage())

        self.assertEqual(candidate["status"], "verified")
        self.assertEqual(candidate["sha256"], plugin_checksum)
        smoke.assert_called_once()

    def test_timed_out_pack_verification_preserves_active_manifest(self):
        plugin_bytes = b"approved-large-plugin"
        host_bytes = b"#!/bin/sh\nexit 0\n"
        plugin_checksum = hashlib.sha256(plugin_bytes).hexdigest()
        host_checksum = hashlib.sha256(host_bytes).hexdigest()
        registries = {
            "MUSIC_AI_APPROVED_NATIVE_HOSTS": json.dumps(
                [{"kind": "vst3", "identity": "Approved MIDI Host", "sha256": host_checksum}]
            ),
            "MUSIC_AI_APPROVED_VST3_ASSETS": json.dumps(
                [{"assetId": "timed-out-pack", "identity": "Timed Out Pack", "sha256": plugin_checksum}]
            ),
        }

        async def stage():
            return await app._stage_asset_candidate(
                "vst3",
                "timed-out-pack",
                "Timed Out Pack",
                "Test Studio",
                "license-timeout",
                "Approved MIDI Host",
                [app.UploadFile(filename="pack.vst3", file=io.BytesIO(plugin_bytes))],
                app.UploadFile(filename="host", file=io.BytesIO(host_bytes)),
            )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = root / "licensed_assets.json"
            active_manifest = {"vst3": {"id": "active-pack", "sha256": "a" * 64}}
            manifest_path.write_text(json.dumps(active_manifest))
            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", root),
                unittest.mock.patch.object(app, "ASSET_MANIFEST_PATH", manifest_path),
                unittest.mock.patch.dict(app.os.environ, registries),
                unittest.mock.patch.object(
                    app,
                    "run_renderer_smoke",
                    side_effect=HTTPException(
                        504,
                        "configured VST3 renderer timed out after 0.01 seconds",
                    ),
                ),
                self.assertRaises(HTTPException) as error,
            ):
                asyncio.run(stage())

            self.assertEqual(error.exception.status_code, 504)
            self.assertIn("timed out", error.exception.detail)
            self.assertEqual(json.loads(manifest_path.read_text()), active_manifest)

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
            rendered_audio = base64.b64decode(response["audio_base64"])
            self.assertEqual(rendered_audio[:4], b"RIFF")
            self.assertEqual(
                response["outputSha256"],
                hashlib.sha256(rendered_audio).hexdigest(),
            )
            self.assertEqual(
                response["trackModelSha256"],
                hashlib.sha256(json.dumps(
                    app.canonical_render_smoke_track(),
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")).hexdigest(),
            )

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

    def test_tampered_verified_candidate_does_not_replace_active_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            active_library = root / "active-library"
            active_library.mkdir()
            (active_library / "instrument.sfz").write_text("active")
            active_renderer = root / "active-host"
            active_renderer.write_text("#!/bin/sh\n")
            active_renderer.chmod(0o755)
            active_entry = {
                "id": "active-pack",
                "identity": "Active Pack 1.0",
                "libraryPath": str(active_library),
                "rendererPath": str(active_renderer),
                "rendererIdentity": "Approved Host 1.0",
                "rendererSha256": app._sha256_tree(active_renderer),
                "sha256": app._sha256_tree(active_library),
                "licenseOwner": "Test Studio",
                "licenseReference": "license-active",
            }
            manifest_path = root / "licensed_assets.json"
            manifest_path.write_text(json.dumps({"sfz": active_entry}))

            candidate_library = root / ".staged" / "candidate-safe-id-123456789" / "asset"
            candidate_library.mkdir(parents=True)
            (candidate_library / "instrument.sfz").write_text("candidate")
            candidate_renderer = candidate_library.parent / "renderer" / "native-host"
            candidate_renderer.parent.mkdir()
            candidate_renderer.write_text("#!/bin/sh\n")
            candidate_renderer.chmod(0o755)
            candidate = {
                "candidateId": "candidate-safe-id-123456789",
                "kind": "sfz",
                "assetId": "candidate-pack",
                "identity": "Candidate Pack 2.0",
                "licenseOwner": "Test Studio",
                "licenseReference": "license-candidate",
                "rendererIdentity": "Approved Host 2.0",
                "sha256": app._sha256_tree(candidate_library),
                "rendererSha256": app._sha256_tree(candidate_renderer),
                "path": str(candidate_library),
                "libraryPath": str(candidate_library),
                "rendererPath": str(candidate_renderer),
                "status": "verified",
                "smokeEvidence": {
                    "assetId": "candidate-pack",
                    "sha256": app._sha256_tree(candidate_library),
                    "rendererSha256": app._sha256_tree(candidate_renderer),
                    "nativeHostAttested": True,
                    "canonicalSensitivity": True,
                    "audible": True,
                },
            }
            (root / app.ASSET_STATE_FILENAME).write_text(
                json.dumps({"candidates": {candidate["candidateId"]: candidate}})
            )
            (candidate_library / "instrument.sfz").write_text("tampered")

            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", root),
                unittest.mock.patch.object(app, "ASSET_MANIFEST_PATH", manifest_path),
                self.assertRaises(HTTPException) as error,
            ):
                app._activate_asset_candidate(candidate["candidateId"])

            self.assertEqual(error.exception.status_code, 409)
            self.assertEqual(json.loads(manifest_path.read_text()), {"sfz": active_entry})

    def test_verified_candidate_activation_preserves_other_active_kind(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plugin = root / "existing.vst3"
            plugin.write_bytes(b"existing-vst")
            existing_host = root / "existing-host"
            existing_host.write_text("#!/bin/sh\n")
            existing_host.chmod(0o755)
            existing_vst = {
                "id": "existing-vst",
                "identity": "Existing VST",
                "path": str(plugin),
                "rendererPath": str(existing_host),
                "rendererIdentity": "Existing Host",
                "rendererSha256": app._sha256_tree(existing_host),
                "sha256": app._sha256_tree(plugin),
                "licenseOwner": "Test Studio",
                "licenseReference": "license-vst",
            }
            manifest_path = root / "licensed_assets.json"
            manifest_path.write_text(json.dumps({"vst3": existing_vst}))

            library = root / ".staged" / "candidate-safe-id-987654321" / "asset"
            library.mkdir(parents=True)
            (library / "instrument.sfz").write_text("candidate")
            renderer = library.parent / "renderer" / "native-host"
            renderer.parent.mkdir()
            renderer.write_text("#!/bin/sh\n")
            renderer.chmod(0o755)
            evidence = {
                "assetId": "new-sfz",
                "sha256": app._sha256_tree(library),
                "rendererSha256": app._sha256_tree(renderer),
                "nativeHostAttested": True,
                "canonicalSensitivity": True,
                "audible": True,
            }
            candidate = {
                "candidateId": "candidate-safe-id-987654321",
                "kind": "sfz",
                "assetId": "new-sfz",
                "identity": "New SFZ",
                "licenseOwner": "Test Studio",
                "licenseReference": "license-sfz",
                "rendererIdentity": "New Host",
                "sha256": app._sha256_tree(library),
                "rendererSha256": app._sha256_tree(renderer),
                "path": str(library),
                "libraryPath": str(library),
                "rendererPath": str(renderer),
                "status": "verified",
                "smokeEvidence": evidence,
            }
            (root / app.ASSET_STATE_FILENAME).write_text(
                json.dumps({"candidates": {candidate["candidateId"]: candidate}})
            )

            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", root),
                unittest.mock.patch.object(app, "ASSET_MANIFEST_PATH", manifest_path),
            ):
                activated = app._activate_asset_candidate(candidate["candidateId"])

            manifest = json.loads(manifest_path.read_text())
            self.assertEqual(activated["status"], "active")
            self.assertEqual(manifest["vst3"], existing_vst)
            self.assertEqual(manifest["sfz"]["id"], "new-sfz")
            self.assertEqual(manifest["sfz"]["smokeEvidence"], evidence)

    def test_verified_rotation_history_reactivates_and_rejects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = root / "licensed_assets.json"

            def pack(candidate_id: str, asset_id: str, content: str, status: str):
                candidate_root = root / ".staged" / candidate_id
                library = candidate_root / "asset"
                library.mkdir(parents=True)
                (library / "instrument.sfz").write_text(content)
                renderer = candidate_root / "renderer" / "native-host"
                renderer.parent.mkdir()
                renderer.write_text("#!/bin/sh\n")
                renderer.chmod(0o755)
                evidence = {
                    "assetId": asset_id,
                    "sha256": app._sha256_tree(library),
                    "rendererSha256": app._sha256_tree(renderer),
                    "nativeHostAttested": True,
                    "canonicalSensitivity": True,
                    "audible": True,
                }
                return {
                    "candidateId": candidate_id,
                    "kind": "sfz",
                    "assetId": asset_id,
                    "identity": f"{asset_id} identity",
                    "licenseOwner": "Test Studio",
                    "licenseReference": f"license-{asset_id}",
                    "rendererIdentity": "Approved Host",
                    "sha256": evidence["sha256"],
                    "rendererSha256": evidence["rendererSha256"],
                    "path": str(library),
                    "libraryPath": str(library),
                    "rendererPath": str(renderer),
                    "status": status,
                    "smokeEvidence": evidence,
                    "createdAt": "2026-08-30T10:00:00Z",
                    "activatedAt": "2026-08-30T10:05:00Z" if status == "active" else None,
                }

            previous = pack(
                "previous-pack-candidate-123456",
                "previous-pack",
                "previous",
                "active",
            )
            replacement = pack(
                "replacement-candidate-1234567",
                "replacement-pack",
                "replacement",
                "verified",
            )
            manifest_path.write_text(json.dumps({
                "sfz": app._candidate_entry(previous),
            }))
            (root / app.ASSET_STATE_FILENAME).write_text(json.dumps({
                "candidates": {
                    previous["candidateId"]: previous,
                    replacement["candidateId"]: replacement,
                },
            }))

            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", root),
                unittest.mock.patch.object(app, "ASSET_MANIFEST_PATH", manifest_path),
            ):
                with unittest.mock.patch.object(
                    app,
                    "_write_asset_state",
                    side_effect=OSError("simulated state mirror failure"),
                ):
                    app._activate_asset_candidate(replacement["candidateId"])
                catalog = app.list_asset_candidates()
                self.assertEqual(
                    [item["assetId"] for item in catalog["history"]["sfz"]],
                    ["previous-pack"],
                )
                self.assertEqual(catalog["history"]["sfz"][0]["status"], "verified")
                history_id = catalog["history"]["sfz"][0]["historyId"]

                app._reactivate_asset_history(history_id)
                self.assertEqual(
                    json.loads(manifest_path.read_text())["sfz"]["id"],
                    "previous-pack",
                )

                replacement_library = Path(replacement["libraryPath"])
                (replacement_library / "instrument.sfz").write_text("tampered")
                catalog = app.list_asset_candidates()
                self.assertEqual(catalog["history"]["sfz"][0]["status"], "unavailable")
                with self.assertRaises(HTTPException) as error:
                    app._reactivate_asset_history(
                        catalog["history"]["sfz"][0]["historyId"]
                    )
                self.assertEqual(error.exception.status_code, 409)
                self.assertEqual(
                    json.loads(manifest_path.read_text())["sfz"]["id"],
                    "previous-pack",
                )

    def test_corrupt_manifest_blocks_activation_and_reactivation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            library = root / ".staged" / "candidate-corrupt-test-12345" / "asset"
            library.mkdir(parents=True)
            (library / "instrument.sfz").write_text("candidate")
            renderer = library.parent / "renderer" / "native-host"
            renderer.parent.mkdir()
            renderer.write_text("#!/bin/sh\n")
            renderer.chmod(0o755)
            evidence = {
                "assetId": "candidate-pack",
                "sha256": app._sha256_tree(library),
                "rendererSha256": app._sha256_tree(renderer),
                "nativeHostAttested": True,
                "canonicalSensitivity": True,
                "audible": True,
            }
            candidate = {
                "candidateId": "candidate-corrupt-test-12345",
                "kind": "sfz",
                "assetId": "candidate-pack",
                "identity": "Candidate Pack",
                "licenseOwner": "Test Studio",
                "licenseReference": "license-candidate",
                "rendererIdentity": "Approved Host",
                "sha256": evidence["sha256"],
                "rendererSha256": evidence["rendererSha256"],
                "path": str(library),
                "libraryPath": str(library),
                "rendererPath": str(renderer),
                "status": "verified",
                "smokeEvidence": evidence,
            }
            history = {
                **app._candidate_entry(candidate),
                "historyId": "history-corrupt-test-123456",
                "candidateId": candidate["candidateId"],
                "assetId": candidate["assetId"],
                "kind": "sfz",
                "status": "verified",
            }
            (root / app.ASSET_STATE_FILENAME).write_text(json.dumps({
                "candidates": {candidate["candidateId"]: candidate},
                "history": {"vst3": [], "sfz": [history]},
            }))
            manifest_path = root / "licensed_assets.json"
            corrupt_manifest = "{this-is-not-json"
            manifest_path.write_text(corrupt_manifest)

            with (
                unittest.mock.patch.object(app, "ASSET_ROOT", root),
                unittest.mock.patch.object(app, "ASSET_MANIFEST_PATH", manifest_path),
            ):
                with self.assertRaises(HTTPException) as activation_error:
                    app._activate_asset_candidate(candidate["candidateId"])
                self.assertEqual(activation_error.exception.status_code, 503)
                self.assertEqual(manifest_path.read_text(), corrupt_manifest)

                with self.assertRaises(HTTPException) as reactivation_error:
                    app._reactivate_asset_history(history["historyId"])
                self.assertEqual(reactivation_error.exception.status_code, 503)
                self.assertEqual(manifest_path.read_text(), corrupt_manifest)

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

    def test_demucs_non_python_package_data_drift_blocks_health_and_inference(self):
        with tempfile.TemporaryDirectory() as tmp:
            package_root = Path(tmp) / "demucs"
            (package_root / "remote").mkdir(parents=True)
            package_file = package_root / "__init__.py"
            package_file.write_text("__version__ = '4.0.1'\n")
            runtime_data = package_root / "remote" / "files.txt"
            runtime_data.write_text("htdemucs=955717e8-8726e21a.th\n")
            fake_module = types.SimpleNamespace(__file__=str(package_file))
            fake_torch = types.SimpleNamespace(
                hub=types.SimpleNamespace(get_dir=lambda: str(Path.home() / ".cache" / "torch" / "hub")),
            )
            with unittest.mock.patch.dict(
                sys.modules,
                {"demucs": fake_module, "torch": fake_torch},
            ):
                expected = app._installed_package_tree_sha256("demucs")
                self.assertIsNotNone(expected)
                details = copy.deepcopy(app.MANIFEST["demucs"])
                details["package_tree_sha256"] = expected
                with unittest.mock.patch.dict(app.MANIFEST, {"demucs": details}):
                    self.assertTrue(app.health("DEMUCS")["packageReady"])
                    runtime_data.write_text("htdemucs=substituted-checkpoint.th\n")
                    drifted = app.health("DEMUCS")
                    self.assertFalse(drifted["packageReady"])
                    self.assertFalse(drifted["healthy"])
                    payload = app.SourceRequest(
                        provider="DEMUCS",
                        sourceUrl="https://example.com/song.wav",
                    )
                    with self.assertRaises(HTTPException) as error:
                        app.separate(payload, None)
                    self.assertEqual(error.exception.status_code, 503)

    def test_basic_pitch_checkpoint_drift_blocks_health_and_inference(self):
        with tempfile.TemporaryDirectory() as tmp:
            package_root = Path(tmp) / "basic_pitch"
            checkpoint = package_root / "saved_models" / "icassp_2022" / "nmp"
            checkpoint.mkdir(parents=True)
            package_file = package_root / "__init__.py"
            package_file.write_text("__version__ = '0.4.0'\n")
            model_file = checkpoint / "saved_model.pb"
            model_file.write_bytes(b"verified-basic-pitch-model")
            fake_module = types.SimpleNamespace(__file__=str(package_file))
            details = copy.deepcopy(app.MANIFEST["basic_pitch"])
            with unittest.mock.patch.dict(sys.modules, {"basic_pitch": fake_module}):
                details["package_tree_sha256"] = app._installed_package_tree_sha256(
                    "basic_pitch"
                )
                details["checkpoint_tree_sha256"] = app._sha256_tree(checkpoint)
                marker = {
                    "basic_pitch": True,
                    "basic_pitch_backend": details["inference_backend"],
                    "basic_pitch_checkpoint_sha256": details["checkpoint_tree_sha256"],
                }
                with (
                    unittest.mock.patch.dict(app.MANIFEST, {"basic_pitch": details}),
                    unittest.mock.patch.object(app, "_readiness_marker", return_value=marker),
                ):
                    self.assertTrue(app.health("BASIC_PITCH")["healthy"])
                    model_file.write_bytes(b"substituted-basic-pitch-model")
                    drifted = app.health("BASIC_PITCH")
                    self.assertFalse(drifted["packageReady"])
                    self.assertFalse(drifted["checkpointReady"])
                    self.assertFalse(drifted["healthy"])
                    payload = app.SourceRequest(
                        provider="BASIC_PITCH",
                        sourceUrl="https://example.com/song.wav",
                    )
                    with self.assertRaises(HTTPException) as error:
                        app.analyze(payload)
                    self.assertEqual(error.exception.status_code, 503)

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
