"""Bounded, CPU-only music model worker. Run with `uv run uvicorn app:app`."""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
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
    provider: Literal["VST3"]
    audio_base64: str = Field(min_length=4, max_length=MAX_INPUT_BYTES * 2)


def _sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
    providers = {"BASIC_PITCH", "DEMUCS", "PEDALBOARD_BUILTIN", "VST3"}
    if provider and provider not in providers:
        raise HTTPException(404, "unknown provider")
    selected = provider or "BASIC_PITCH"
    manifest_key = {"BASIC_PITCH": "basic_pitch", "DEMUCS": "demucs",
                    "PEDALBOARD_BUILTIN": "pedalboard", "VST3": "pedalboard"}[selected]
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
    else:
        plugin_path = os.getenv("MUSIC_AI_VST3_PATH")
        checksum = _sha256(Path(plugin_path)) if plugin_path else None
        checkpoint_ready = bool(checksum)
        smoke_tested = marker.get("vst3") is True
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
    plugin_path = os.getenv("MUSIC_AI_VST3_PATH")
    if not plugin_path or not Path(plugin_path).is_file():
        raise HTTPException(503, "no configured VST3 plugin is available")
    try:
        from pedalboard import load_plugin
        plugin = load_plugin(plugin_path)
    except Exception as exc:
        raise HTTPException(503, f"configured VST3 plugin could not be loaded: {exc}") from exc
    with tempfile.TemporaryDirectory(prefix="music-ai-") as tmp:
        audio_path = decode_audio(payload.audio_base64, Path(tmp))
        audio, rate = sf.read(audio_path, always_2d=True, dtype="float32")
        encoded = wav_b64(plugin(audio.T, rate).T, rate)
    return {"provider": payload.provider, "audio_base64": encoded, "format": "wav", "encoding": "pcm_s16le"}


@app.exception_handler(HTTPException)
async def errors(_, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)