"""Bounded, CPU-only music model worker. Run with `uv run uvicorn app:app`."""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import copy
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from importlib.metadata import PackageNotFoundError, version as installed_version
from pathlib import Path
from typing import Literal
from http.client import HTTPConnection, HTTPSConnection
from urllib.parse import urlparse

import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, HTTPException, Request as FastAPIRequest
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field, HttpUrl

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())
MAX_DOWNLOAD_BYTES = int(os.getenv("MUSIC_AI_MAX_SOURCE_BYTES", 25 * 1024 * 1024))
MAX_INPUT_BYTES = int(os.getenv("MUSIC_AI_MAX_INPUT_BYTES", 25 * 1024 * 1024))
MAX_DURATION_SECONDS = float(os.getenv("MUSIC_AI_MAX_DURATION_SECONDS", "300"))
DOWNLOAD_TIMEOUT = float(os.getenv("MUSIC_AI_DOWNLOAD_TIMEOUT_SECONDS", "20"))
INFERENCE_TIMEOUT = float(os.getenv("MUSIC_AI_INFERENCE_TIMEOUT_SECONDS", "540"))
MAX_STEM_BYTES = min(int(os.getenv("MUSIC_AI_MAX_STEM_BYTES", 250 * 1024 * 1024)), 511 * 1024 * 1024)
MAX_SEPARATION_OUTPUT_BYTES = min(
    int(os.getenv("MUSIC_AI_MAX_SEPARATION_OUTPUT_BYTES", 500 * 1024 * 1024)),
    511 * 1024 * 1024,
)
MAX_SEPARATION_JSON_BYTES = 32 * 1024 * 1024
ARTIFACT_TTL_SECONDS = float(os.getenv("MUSIC_AI_ARTIFACT_TTL_SECONDS", "900"))
ARTIFACTS = ROOT / ".artifacts"
ARTIFACT_ID = re.compile(r"^[A-Za-z0-9_-]{32,}$")
ASSET_ROOT = Path(os.getenv("MUSIC_AI_ASSET_ROOT", "/var/lib/music-ai/assets")).resolve()
ASSET_MANIFEST_PATH = Path(
    os.getenv("MUSIC_AI_ASSET_MANIFEST", str(ASSET_ROOT / "licensed_assets.json"))
).resolve()
MAX_RENDER_SECONDS = float(os.getenv("MUSIC_AI_MAX_RENDER_SECONDS", "300"))

app = FastAPI(title="Music AI Worker", version="1.0.0")


@app.middleware("http")
async def request_size_limit(request: FastAPIRequest, call_next):
    """Reject declared oversized JSON before FastAPI buffers and parses it."""
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > MAX_INPUT_BYTES * 2:
                return JSONResponse({"detail": "request exceeds size limit"}, status_code=413)
        except ValueError:
            return JSONResponse({"detail": "invalid content-length"}, status_code=400)
    return await call_next(request)


def _require_auth(request: FastAPIRequest) -> None:
    token = os.getenv("MUSIC_AI_WORKER_TOKEN")
    if token and request.headers.get("Authorization") != f"Bearer {token}":
        raise HTTPException(401, "invalid bearer token")


def _resolve_public_addresses(host: str, port: int) -> list[tuple[int, tuple]]:
    """Resolve once and retain only addresses safe to connect to.

    Rejecting the entire result if even one answer is non-global prevents a
    round-robin DNS record from bypassing the check.  The resulting sockaddr is
    passed to connect directly, so no later name resolution can be rebound.
    """
    try:
        answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(400, "source_url host could not be resolved") from exc
    vetted: list[tuple[int, tuple]] = []
    for family, _, _, _, sockaddr in answers:
        try:
            if not ipaddress.ip_address(sockaddr[0]).is_global:
                raise HTTPException(400, "source_url must resolve only to global addresses")
        except ValueError as exc:
            raise HTTPException(400, "source_url resolution returned an invalid address") from exc
        vetted.append((family, sockaddr))
    if not vetted:
        raise HTTPException(400, "source_url host could not be resolved")
    return vetted


class _VettedConnectionMixin:
    def __init__(self, host: str, port: int, vetted: tuple[int, tuple], timeout: float):
        self._vetted_family, self._vetted_sockaddr = vetted
        super().__init__(host, port=port, timeout=timeout)

    def _connect_vetted(self):
        sock = socket.socket(self._vetted_family, socket.SOCK_STREAM)
        try:
            sock.settimeout(self.timeout)
            sock.connect(self._vetted_sockaddr)
            self.sock = sock
        except Exception:
            sock.close()
            raise

    def connect(self):
        self._connect_vetted()


class VettedHTTPConnection(_VettedConnectionMixin, HTTPConnection):
    """HTTP connection whose peer is already DNS-vetted."""


class VettedHTTPSConnection(_VettedConnectionMixin, HTTPSConnection):
    """HTTPS connection retaining certificate validation and SNI for hostname."""

    def connect(self):
        self._connect_vetted()
        # HTTPSConnection.host remains the original URL hostname, never the IP.
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise HTTPException(408, "source download timed out")
    return remaining


def download_source(url: str, directory: Path) -> Path:
    parsed = urlparse(url)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or
            parsed.username is not None or parsed.password is not None):
        raise HTTPException(400, "source_url must be a public http(s) URL")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise HTTPException(400, "source_url has an invalid port") from exc
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT
    vetted = _resolve_public_addresses(parsed.hostname, port)
    connection_type = VettedHTTPSConnection if parsed.scheme == "https" else VettedHTTPConnection
    connection = connection_type(parsed.hostname, port, vetted[0], _remaining(deadline))
    try:
        target_path = parsed.path or "/"
        if parsed.query:
            target_path += f"?{parsed.query}"
        connection.request("GET", target_path, headers={"User-Agent": "music-ai-worker/1.0"})
        connection.sock.settimeout(_remaining(deadline))
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise HTTPException(400, "redirects are not permitted for source_url")
        if response.status < 200 or response.status >= 300:
            raise HTTPException(400, "source server returned an unsuccessful response")
        length = response.headers.get("Content-Length")
        if length and int(length) > MAX_DOWNLOAD_BYTES:
            raise HTTPException(413, "source exceeds download size limit")
        content_type = response.headers.get_content_type().lower()
        suffix = {
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/flac": ".flac",
            "audio/mpeg": ".mp3",
            "audio/mp4": ".m4a",
            "audio/ogg": ".ogg",
        }.get(content_type, Path(parsed.path).suffix.lower())
        if suffix not in {".wav", ".flac", ".mp3", ".m4a", ".ogg", ".aif", ".aiff"}:
            suffix = ".wav"
        target = directory / f"source{suffix}"
        total = 0
        with response, target.open("wb") as output:
            while True:
                connection.sock.settimeout(_remaining(deadline))
                block = response.read(64 * 1024)
                if not block:
                    break
                total += len(block)
                if total > MAX_DOWNLOAD_BYTES:
                    raise HTTPException(413, "source exceeds download size limit")
                output.write(block)
        return target
    except HTTPException:
        raise
    except (OSError, ValueError, TimeoutError) as exc:
        raise HTTPException(400, "unable to download source") from exc
    finally:
        connection.close()


def validate_audio(path: Path) -> None:
    try:
        info = sf.info(path)
    except RuntimeError as exc:
        raise HTTPException(415, "source is not decodable audio") from exc
    if not info.samplerate or info.duration <= 0 or info.duration > MAX_DURATION_SECONDS:
        raise HTTPException(413, "audio duration is outside permitted bounds")


def decode_audio(value: str, directory: Path) -> Path:
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise HTTPException(422, "audio_base64 is invalid") from exc
    if not raw or len(raw) > MAX_INPUT_BYTES:
        raise HTTPException(413, "audio_base64 exceeds size limit")
    target = directory / "input.wav"
    target.write_bytes(raw)
    validate_audio(target)
    return target


def wav_b64(audio: np.ndarray, sample_rate: int) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav") as handle:
        sf.write(handle.name, audio, sample_rate, subtype="PCM_16")
        return base64.b64encode(Path(handle.name).read_bytes()).decode("ascii")


class SourceRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    provider: Literal["BASIC_PITCH", "DEMUCS"]
    source_url: HttpUrl = Field(alias="sourceUrl")
    source_type: str | None = Field(default=None, alias="sourceType")
    duration_seconds: float | None = Field(default=None, alias="durationSeconds", gt=0)


class ProcessRequest(BaseModel):
    provider: Literal["PEDALBOARD_BUILTIN"]
    audio_base64: str = Field(min_length=4, max_length=MAX_INPUT_BYTES * 2)
    gain_db: float = Field(default=0, ge=-36, le=36)
    threshold_db: float = Field(default=-12, ge=-60, le=0)


class RenderRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    provider: Literal["VST3", "SFIZZ_VSCO2_CE"]
    track_model: dict | None = Field(default=None, alias="trackModel")
    sample_rate: int = Field(default=44100, alias="sampleRate", ge=8000, le=192000)
    duration_seconds: float = Field(default=8, alias="durationSeconds", gt=0, le=MAX_RENDER_SECONDS)
    # Kept only for old effect-render clients. Instrument rendering requires a
    # canonical TrackModel and never treats arbitrary audio as musical evidence.
    audio_base64: str | None = Field(default=None, min_length=4, max_length=MAX_INPUT_BYTES * 2)


def _sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_tree(path: Path) -> str | None:
    """Hash a file or directory without exposing a private storage path."""
    if path.is_file():
        return _sha256(path)
    if not path.is_dir():
        return None
    digest = hashlib.sha256()
    files = sorted(candidate for candidate in path.rglob("*") if candidate.is_file())
    if not files:
        return None
    for candidate in files:
        digest.update(str(candidate.relative_to(path)).encode("utf-8"))
        digest.update(b"\0")
        with candidate.open("rb") as handle:
            while block := handle.read(1024 * 1024):
                digest.update(block)
    return digest.hexdigest()


def _safe_asset_path(value: object, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} path is missing")
    path = Path(value).expanduser().resolve()
    try:
        path.relative_to(ASSET_ROOT)
    except ValueError as exc:
        raise ValueError(f"{label} must be inside MUSIC_AI_ASSET_ROOT") from exc
    return path


def _licensed_asset(kind: Literal["vst3", "sfz"]) -> dict:
    """Return an attested asset, never a path supplied by a render request."""
    try:
        ASSET_MANIFEST_PATH.relative_to(ASSET_ROOT)
    except ValueError as exc:
        raise ValueError("licensed asset manifest must be inside MUSIC_AI_ASSET_ROOT") from exc
    try:
        manifest = json.loads(ASSET_MANIFEST_PATH.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("licensed asset manifest is missing or invalid") from exc
    if not isinstance(manifest, dict):
        raise ValueError("licensed asset manifest must be a JSON object")
    entry = manifest.get(kind)
    if not isinstance(entry, dict):
        raise ValueError(f"licensed {kind} asset is not selected")
    for required in ("id", "identity", "licenseOwner", "licenseReference", "sha256"):
        if not isinstance(entry.get(required), str) or not entry[required].strip():
            raise ValueError(f"licensed {kind} asset is missing {required}")
    path_key = "path" if kind == "vst3" else "libraryPath"
    path = _safe_asset_path(entry.get(path_key), kind)
    if (kind == "vst3" and not (path.is_file() or path.is_dir())) or (kind == "sfz" and not path.is_dir()):
        raise ValueError(f"licensed {kind} asset is not present at the selected path")
    checksum = _sha256_tree(path)
    if not checksum or checksum != entry["sha256"].lower():
        raise ValueError(f"licensed {kind} asset checksum does not match its manifest")
    asset = {
        "id": entry["id"].strip(),
        "identity": entry["identity"].strip(),
        "licenseOwner": entry["licenseOwner"].strip(),
        "licenseReference": entry["licenseReference"].strip(),
        "sha256": checksum,
        "path": path,
    }
    renderer_label = "VST3 MIDI host" if kind == "vst3" else "sfizz renderer"
    renderer = _safe_asset_path(entry.get("rendererPath"), renderer_label)
    if not renderer.is_file() or not os.access(renderer, os.X_OK):
        raise ValueError(f"native {renderer_label} is missing or not executable")
    for required in ("rendererIdentity", "rendererSha256"):
        if not isinstance(entry.get(required), str) or not entry[required].strip():
            raise ValueError(f"licensed {kind} asset is missing {required}")
    renderer_checksum = _sha256_tree(renderer)
    if renderer_checksum != entry["rendererSha256"].lower():
        raise ValueError(f"native {renderer_label} checksum does not match its manifest")
    asset["rendererPath"] = renderer
    asset["rendererIdentity"] = entry["rendererIdentity"].strip()
    asset["rendererSha256"] = renderer_checksum
    if kind == "sfz":
        asset["libraryPath"] = path
    return asset


def _canonical_track_model(value: object) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(422, "trackModel must be a canonical TrackModel object")
    required = ("id", "instrument", "role", "notes", "cc", "articulations", "automation")
    if any(not value.get(key) and key in ("id", "instrument", "role") for key in required):
        raise HTTPException(422, "trackModel is missing identity fields")
    if any(not isinstance(value.get(key), list) for key in required[3:]):
        raise HTTPException(422, "trackModel event collections are invalid")
    notes = value["notes"]
    for note in notes:
        if not isinstance(note, dict):
            raise HTTPException(422, "trackModel contains an invalid note")
        if not all(isinstance(note.get(key), (int, float)) for key in ("start", "duration", "pitch", "velocity")):
            raise HTTPException(422, "trackModel note is missing numeric timing or pitch")
        if note["start"] < 0 or note["duration"] <= 0 or not 0 <= note["pitch"] <= 127:
            raise HTTPException(422, "trackModel contains an unplayable note")
    return value


def _validate_render_audio(audio: np.ndarray, sample_rate: int, duration_seconds: float) -> None:
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]
    if audio.ndim != 2 or audio.shape[0] not in (1, 2):
        raise HTTPException(503, "native renderer returned an invalid channel layout")
    expected = int(round(sample_rate * duration_seconds))
    if abs(audio.shape[1] - expected) > max(1, sample_rate // 100):
        raise HTTPException(503, "native renderer returned an invalid duration")
    if not np.isfinite(audio).all():
        raise HTTPException(503, "native renderer returned non-finite audio")
    if float(np.max(np.abs(audio))) < 0.0005:
        raise HTTPException(503, "native renderer returned silent audio")


def _render_native_track(
    kind: Literal["vst3", "sfz"],
    track: dict,
    sample_rate: int,
    duration_seconds: float,
) -> tuple[np.ndarray, dict]:
    try:
        asset = _licensed_asset(kind)
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc
    if kind == "vst3":
        try:
            from pedalboard import load_plugin
            plugin_name = os.getenv("MUSIC_AI_VST3_PLUGIN_NAME") or None
            load_plugin(str(asset["path"]), plugin_name=plugin_name)
        except Exception as exc:
            raise HTTPException(503, f"configured VST3 plugin could not be loaded: {exc}") from exc
    with tempfile.TemporaryDirectory(prefix=f"music-ai-{kind}-") as tmp:
        request_path = Path(tmp) / "track-model.json"
        output_path = Path(tmp) / "render.wav"
        attestation_path = Path(tmp) / "render-attestation.json"
        request_path.write_text(json.dumps({
            "trackModel": track,
            "sampleRate": sample_rate,
            "durationSeconds": duration_seconds,
            "assetPath": str(asset["path"]),
            "outputPath": str(output_path),
        }, sort_keys=True, separators=(",", ":")))
        track_model_sha256 = _sha256_tree(request_path)
        command = [
            str(asset["rendererPath"]),
            "--track-model", str(request_path),
            "--sample-rate", str(sample_rate),
            "--duration-seconds", str(duration_seconds),
            "--output", str(output_path),
            "--attestation", str(attestation_path),
            "--asset-identity", asset["identity"],
        ]
        command.extend(
            ["--plugin", str(asset["path"])]
            if kind == "vst3"
            else ["--library", str(asset["path"])]
        )
        try:
            subprocess.run(
                command,
                check=True,
                capture_output=True,
                timeout=INFERENCE_TIMEOUT,
            )
        except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
            raise HTTPException(503, f"configured {kind} renderer could not render TrackModel") from exc
        if not output_path.is_file():
            raise HTTPException(503, f"native {kind} renderer did not produce a WAV")
        try:
            host_attestation = json.loads(attestation_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise HTTPException(
                503, f"native {kind} renderer did not attest the selected asset"
            ) from exc
        expected_event_counts = {
            "notes": len(track["notes"]),
            "cc": len(track["cc"]),
            "articulations": len(track["articulations"]),
            "automation": len(track["automation"]),
        }
        expected_host_attestation = {
            "provider": kind,
            "assetIdentity": asset["identity"],
            "assetSha256": asset["sha256"],
            "rendererSha256": asset["rendererSha256"],
            "trackModelSha256": track_model_sha256,
            "eventCounts": expected_event_counts,
            "outputSha256": _sha256_tree(output_path),
        }
        if host_attestation != expected_host_attestation:
            raise HTTPException(
                503, f"native {kind} renderer returned invalid asset/render attestation"
            )
        max_wav_bytes = int(sample_rate * duration_seconds * 2 * 4) + 1024 * 1024
        if output_path.stat().st_size > max_wav_bytes:
            raise HTTPException(503, f"native {kind} renderer produced an oversized WAV")
        try:
            audio, output_rate = sf.read(output_path, always_2d=True, dtype="float32")
        except RuntimeError as exc:
            raise HTTPException(503, f"native {kind} renderer returned an undecodable WAV") from exc
    if output_rate != sample_rate:
        raise HTTPException(503, f"native {kind} renderer returned the wrong sample rate")
    audio = np.asarray(audio, dtype=np.float32).T
    _validate_render_audio(audio, sample_rate, duration_seconds)
    return audio, {
        key: value
        for key, value in asset.items()
        if key not in ("path", "libraryPath", "rendererPath")
    }


def _render_vst3_track(track: dict, sample_rate: int, duration_seconds: float) -> tuple[np.ndarray, dict]:
    return _render_native_track("vst3", track, sample_rate, duration_seconds)


def _render_sfizz_track(track: dict, sample_rate: int, duration_seconds: float) -> tuple[np.ndarray, dict]:
    return _render_native_track("sfz", track, sample_rate, duration_seconds)


def renderer_health(provider: str) -> dict:
    """Attest the selected licensed asset and native smoke evidence."""
    kind = "vst3" if provider == "VST3" else "sfz"
    try:
        asset = _licensed_asset(kind)
        if provider == "VST3":
            # Loading is deliberately part of health; package presence alone is
            # not proof that this plugin can be instantiated.
            from pedalboard import load_plugin
            plugin_name = os.getenv("MUSIC_AI_VST3_PLUGIN_NAME") or None
            load_plugin(str(asset["path"]), plugin_name=plugin_name)
            package_version = installed_version("pedalboard")
        else:
            package_version = "native-command"
        marker = _readiness_marker().get("vst3" if provider == "VST3" else "sfizz")
        smoke_tested = (
            isinstance(marker, dict)
            and marker.get("assetId") == asset["id"]
            and marker.get("sha256") == asset["sha256"]
            and marker.get("rendererSha256") == asset["rendererSha256"]
            and marker.get("audible") is True
            and marker.get("trackModelRendered") is True
            and marker.get("canonicalSensitivity") is True
            and marker.get("nativeHostAttested") is True
        )
        return {
            "status": "ok" if smoke_tested else "unhealthy",
            "healthy": smoke_tested,
            "provider": provider,
            "runtimeReady": smoke_tested,
            "checkpointReady": True,
            "packageReady": True,
            "modelVersion": package_version,
            "checksum": asset["sha256"],
            "smokeTested": smoke_tested,
            "asset": {
                "id": asset["id"],
                "identity": asset["identity"],
                "licenseOwner": asset["licenseOwner"],
                "licenseReference": asset["licenseReference"],
                "sha256": asset["sha256"],
                "rendererIdentity": asset["rendererIdentity"],
                "rendererSha256": asset["rendererSha256"],
            },
            "smokeEvidence": marker if isinstance(marker, dict) else None,
            "runtime": {"ready": smoke_tested, "python": "3.11", "device": "cpu"},
        }
    except Exception as exc:
        return {
            "status": "unhealthy",
            "healthy": False,
            "provider": provider,
            "runtimeReady": False,
            "checkpointReady": False,
            "packageReady": False,
            "modelVersion": None,
            "checksum": None,
            "smokeTested": False,
            "error": str(exc),
            "asset": None,
            "smokeEvidence": None,
            "runtime": {"ready": False, "python": "3.11", "device": "cpu"},
        }


def canonical_render_smoke_track() -> dict:
    """Small but genuine TrackModel used for native renderer attestation."""
    return {
        "id": "renderer-smoke",
        "instrument": "strings",
        "role": "harmony",
        "instrumentDefinition": {"id": "strings"},
        "notes": [{
            "id": "renderer-smoke-note",
            "start": 0.05,
            "duration": 0.7,
            "pitch": 60,
            "velocity": 96,
            "voice": "harmony",
        }],
        "cc": [{"controller": 11, "time": 0, "value": 100}],
        "articulations": [{"time": 0.05, "name": "sustain", "intensity": 0.75}],
        "automation": [],
    }


def run_renderer_smoke(provider: Literal["VST3", "SFIZZ_VSCO2_CE"]) -> dict:
    track = _canonical_track_model(canonical_render_smoke_track())
    sample_rate = 22050
    duration_seconds = 1.0
    render = _render_vst3_track if provider == "VST3" else _render_sfizz_track
    audio, asset = render(track, sample_rate, duration_seconds)
    pitch_variant = copy.deepcopy(track)
    pitch_variant["notes"][0]["pitch"] += 7
    pitch_audio, pitch_asset = render(pitch_variant, sample_rate, duration_seconds)
    expression_variant = copy.deepcopy(track)
    expression_variant["cc"][0]["value"] = 24
    expression_variant["articulations"][0]["name"] = "staccato"
    expression_audio, expression_asset = render(
        expression_variant, sample_rate, duration_seconds
    )
    if asset["id"] != pitch_asset["id"] or asset["id"] != expression_asset["id"]:
        raise HTTPException(503, "native renderer changed assets during smoke test")
    audio_hash = hashlib.sha256(audio.tobytes()).hexdigest()
    pitch_hash = hashlib.sha256(pitch_audio.tobytes()).hexdigest()
    expression_hash = hashlib.sha256(expression_audio.tobytes()).hexdigest()
    canonical_sensitivity = len({audio_hash, pitch_hash, expression_hash}) == 3
    if not canonical_sensitivity:
        raise HTTPException(
            503,
            "native renderer did not respond to TrackModel pitch and expression changes",
        )
    peak = float(np.max(np.abs(audio)))
    return {
        "assetId": asset["id"],
        "sha256": asset["sha256"],
        "rendererIdentity": asset["rendererIdentity"],
        "rendererSha256": asset["rendererSha256"],
        "trackModelRendered": True,
        "audible": peak >= 0.0005,
        "canonicalSensitivity": canonical_sensitivity,
        "nativeHostAttested": True,
        "outputSha256": audio_hash,
        "pitchVariantSha256": pitch_hash,
        "expressionVariantSha256": expression_hash,
        "peak": round(peak, 6),
        "sampleRate": sample_rate,
        "durationSeconds": duration_seconds,
        "format": "wav/pcm_s16le",
    }


def _readiness_marker() -> dict:
    marker = ROOT / ".readiness" / f"{MANIFEST['readiness_key']}.json"
    try:
        return json.loads(marker.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _package_is_pinned(details: dict) -> bool:
    """Check the installed distribution, rather than trusting manifest text."""
    try:
        return installed_version(details["package"]) == details["version"]
    except PackageNotFoundError:
        return False


def _clean_expired_artifacts() -> None:
    """Best-effort cleanup; artifacts are never required to outlive their TTL."""
    if not ARTIFACTS.is_dir():
        return
    cutoff = time.time() - ARTIFACT_TTL_SECONDS
    for candidate in ARTIFACTS.iterdir():
        try:
            if candidate.is_dir() and candidate.stat().st_mtime < cutoff:
                for child in candidate.iterdir():
                    child.unlink()
                candidate.rmdir()
        except OSError:
            # A concurrent one-time download may be deleting this directory.
            continue


def _delete_served_artifact(path: Path, directory: Path) -> None:
    """Consume one stem without invalidating its sibling capability URL."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        return
    try:
        if not any(directory.iterdir()):
            directory.rmdir()
    except OSError:
        # Concurrent downloads may both try to remove the now-empty directory.
        pass


def _store_stems(vocal: Path, accompaniment: Path) -> tuple[str, list[dict]]:
    sizes = [vocal.stat().st_size, accompaniment.stat().st_size]
    if any(size > MAX_STEM_BYTES for size in sizes) or sum(sizes) > MAX_SEPARATION_OUTPUT_BYTES:
        raise HTTPException(413, "Demucs output exceeds artifact size limit")
    _clean_expired_artifacts()
    ARTIFACTS.mkdir(mode=0o700, parents=True, exist_ok=True)
    artifact_id = secrets.token_urlsafe(32)
    directory = ARTIFACTS / artifact_id
    directory.mkdir(mode=0o700)
    result = []
    for source, name, role in (
        (vocal, "vocals.flac", "lead_vocal"),
        (accompaniment, "instrumental.flac", "instrumental"),
    ):
        target = directory / name
        # Same filesystem, and the directory mode prevents unrelated local users
        # from reading a capability URL's backing file.
        shutil.copyfile(source, target)
        target.chmod(0o600)
        result.append({
            "role": role,
            "confidence": 0.0,
            "contentType": "audio/flac",
            "extension": "flac",
            "name": name,
        })
    return artifact_id, result


@app.get("/health", dependencies=[Depends(_require_auth)])
def health(provider: str | None = None) -> dict:
    providers = {
        "BASIC_PITCH",
        "DEMUCS",
        "PEDALBOARD_BUILTIN",
        "VST3",
        "SFIZZ_VSCO2_CE",
    }
    if provider and provider not in providers:
        raise HTTPException(404, "unknown provider")
    selected = provider or "BASIC_PITCH"
    if selected in {"VST3", "SFIZZ_VSCO2_CE"}:
        return renderer_health(selected)
    manifest_key = {"BASIC_PITCH": "basic_pitch", "DEMUCS": "demucs",
                    "PEDALBOARD_BUILTIN": "pedalboard"}[selected]
    details = MANIFEST[manifest_key]
    marker = _readiness_marker()
    package_ready = _package_is_pinned(details)
    if selected == "BASIC_PITCH":
        checkpoint = Path(__import__("basic_pitch").__file__).resolve().parent / details["checkpoint"]
        checksum = _sha256(checkpoint)
        checkpoint_ready = checksum == details["onnx_sha256"]
        smoke_tested = marker.get("basic_pitch") is True and marker.get("onnx") is True
    elif selected == "DEMUCS":
        import torch
        checkpoint = Path(torch.hub.get_dir()) / "checkpoints" / details["checkpoint_file"]
        checksum = _sha256(checkpoint)
        checkpoint_ready = checksum == details["checkpoint_sha256"]
        smoke_tested = marker.get("demucs") is True
    elif selected == "PEDALBOARD_BUILTIN":
        checksum = f"builtin:{details['package']}:{details['version']}"
        checkpoint_ready = True
        smoke_tested = marker.get("pedalboard") is True
    ready = package_ready and checkpoint_ready and smoke_tested
    return {
        "status": "ok" if ready else "unhealthy",
        "healthy": ready,
        "provider": selected,
        "runtimeReady": ready,
        "checkpointReady": checkpoint_ready,
        "packageReady": package_ready,
        "modelVersion": details["version"],
        "checksum": checksum,
        "smokeTested": smoke_tested,
        "runtime": {"ready": ready, "python": "3.11", "device": "cpu"},
        "checkpoint": {
            "ready": checkpoint_ready,
            "name": details.get("checkpoint", "builtin"),
            "checksum": checksum,
        },
    }


@app.post("/analyze", dependencies=[Depends(_require_auth)])
def analyze(payload: SourceRequest) -> dict:
    if payload.provider != "BASIC_PITCH":
        raise HTTPException(422, "analyze supports BASIC_PITCH only")
    from basic_pitch.inference import ICASSP_2022_MODEL_PATH, predict
    with tempfile.TemporaryDirectory(prefix="music-ai-") as tmp:
        source = download_source(str(payload.source_url), Path(tmp))
        validate_audio(source)
        _, _, events = predict(source, ICASSP_2022_MODEL_PATH)
    notes = []
    for start, end, pitch, amplitude, _ in events:
        item_confidence = float(max(0, min(1, amplitude)))
        notes.append({
            "start": float(start),
            "end": float(end),
            "pitch": int(pitch),
            "velocity": max(1, int(round(item_confidence * 127))),
            "confidence": item_confidence,
        })
    notes.sort(key=lambda note: (note["start"], note["end"], note["pitch"]))
    overall = float(np.mean([note["confidence"] for note in notes])) if notes else 0.0
    return {
        "provider": payload.provider,
        "version": MANIFEST["basic_pitch"]["version"],
        "confidence": overall,
        "notes": notes,
    }


@app.post("/separate", dependencies=[Depends(_require_auth)])
def separate(payload: SourceRequest, request: FastAPIRequest) -> dict:
    if payload.provider != "DEMUCS":
        raise HTTPException(422, "separate supports DEMUCS only")
    with tempfile.TemporaryDirectory(prefix="music-ai-") as tmp:
        root = Path(tmp)
        source = download_source(str(payload.source_url), root)
        validate_audio(source)
        output = root / "output"
        # Argument vector only: no shell invocation or interpolation.
        try:
            subprocess.run(
                [
                    sys.executable, "-m", "demucs", "-n", "htdemucs", "-d", "cpu",
                    "--two-stems", "vocals", "--flac", "--shifts", "1",
                    "-o", str(output), str(source),
                ],
                check=True,
                capture_output=True,
                timeout=INFERENCE_TIMEOUT,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(504, "Demucs inference timed out") from exc
        except subprocess.CalledProcessError as exc:
            raise HTTPException(503, "Demucs inference failed") from exc
        stems = output / "htdemucs" / source.stem
        vocal, accompaniment = stems / "vocals.flac", stems / "no_vocals.flac"
        if not vocal.is_file() or not accompaniment.is_file():
            raise HTTPException(503, "Demucs did not produce expected two stems")
        artifact_id, result = _store_stems(vocal, accompaniment)
    base_url = str(request.base_url).rstrip("/")
    for stem in result:
        stem["downloadUrl"] = f"{base_url}/artifacts/{artifact_id}/{stem.pop('name')}"
    response = {
        "provider": payload.provider,
        "version": MANIFEST["demucs"]["version"],
        "confidence": 0.0,
        "stems": result,
    }
    if len(json.dumps(response, separators=(",", ":")).encode()) >= MAX_SEPARATION_JSON_BYTES:
        # URLs should make this unreachable, but retain the contract even with
        # an unexpectedly large externally supplied base URL.
        raise HTTPException(500, "separation response exceeds JSON size limit")
    return response


@app.get("/artifacts/{artifact_id}/{name}")
def download_artifact(artifact_id: str, name: str):
    """Download a capability artifact once, then remove it.

    This intentionally does not require MUSIC_AI_WORKER_TOKEN: existing Node
    clients do not attach bearer credentials when dereferencing stem URLs.
    Security is provided by a 256-bit unguessable, short-lived, one-use URL.
    """
    _clean_expired_artifacts()
    if not ARTIFACT_ID.fullmatch(artifact_id) or name not in {"vocals.flac", "instrumental.flac"}:
        raise HTTPException(404, "artifact not found")
    directory = ARTIFACTS / artifact_id
    path = directory / name
    if not path.is_file():
        raise HTTPException(404, "artifact not found")
    return FileResponse(
        path,
        media_type="audio/flac",
        filename=name,
        background=BackgroundTask(_delete_served_artifact, path, directory),
    )


@app.post("/process", dependencies=[Depends(_require_auth)])
def process(payload: ProcessRequest) -> dict:
    from pedalboard import Compressor, Gain, Limiter, Pedalboard
    with tempfile.TemporaryDirectory(prefix="music-ai-") as tmp:
        audio_path = decode_audio(payload.audio_base64, Path(tmp))
        audio, rate = sf.read(audio_path, always_2d=True, dtype="float32")
        processed = Pedalboard([Compressor(threshold_db=payload.threshold_db), Gain(gain_db=payload.gain_db),
                               Limiter(threshold_db=-1)])(audio.T, rate).T
        encoded = wav_b64(processed, rate)
    return {"provider": payload.provider, "version": MANIFEST["pedalboard"]["version"],
            "audio_base64": encoded, "format": "wav", "encoding": "pcm_s16le"}


@app.post("/render", dependencies=[Depends(_require_auth)])
def render(payload: RenderRequest) -> dict:
    try:
        asset = _licensed_asset("vst3" if payload.provider == "VST3" else "sfz")
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc
    marker = _readiness_marker().get(
        "vst3" if payload.provider == "VST3" else "sfizz"
    )
    if not (
        isinstance(marker, dict)
        and marker.get("assetId") == asset["id"]
        and marker.get("sha256") == asset["sha256"]
        and marker.get("rendererSha256") == asset["rendererSha256"]
        and marker.get("trackModelRendered") is True
        and marker.get("audible") is True
        and marker.get("canonicalSensitivity") is True
        and marker.get("nativeHostAttested") is True
    ):
        raise HTTPException(503, "selected native asset has not passed its smoke attestation")
    if payload.track_model is None:
        raise HTTPException(422, "instrument rendering requires a canonical TrackModel")
    track = _canonical_track_model(payload.track_model)
    audio, asset = (
        _render_vst3_track(track, payload.sample_rate, payload.duration_seconds)
        if payload.provider == "VST3"
        else _render_sfizz_track(track, payload.sample_rate, payload.duration_seconds)
    )
    return {
        "provider": payload.provider,
        "version": asset["id"],
        "asset": asset,
        "audio_base64": wav_b64(audio.T, payload.sample_rate),
        "format": "wav",
        "encoding": "pcm_s16le",
        "trackModelId": track["id"],
    }


@app.exception_handler(HTTPException)
async def errors(_, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)