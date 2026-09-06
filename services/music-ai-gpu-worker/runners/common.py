"""Small, dependency-light safety boundary shared by GPU runners."""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import math
import os
import shutil
import socket
from importlib.metadata import PackageNotFoundError, version
import tempfile
import time
import urllib.parse
import uuid
from http.client import HTTPSConnection
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024 * 1024
MAX_DURATION_SECONDS = 30 * 60
ALLOWED_AUDIO_SUFFIXES = {".wav", ".flac", ".mp3", ".m4a", ".ogg"}


class RunnerError(RuntimeError):
    """A deliberate, safe-to-report runner failure."""


def finite_number(value: Any, label: str, low: float | None = None,
                  high: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RunnerError(f"{label} must be finite")
    value = float(value)
    if (low is not None and value < low) or (high is not None and value > high):
        raise RunnerError(f"{label} is out of bounds")
    return value


def validate_mt3_note_output(output: object) -> None:
    """Require bounded, terminated, canonical, hash-addressed MT3 note evidence."""
    if not isinstance(output, dict):
        raise ValueError("MT3 retained note evidence is missing")
    events = output.get("noteEvents")
    if (
        not isinstance(events, list)
        or not 1 <= len(events) <= 4096
        or output.get("notes") != len(events)
        or output.get("terminatedNotes") != len(events)
        or output.get("allNotesTerminated") is not True
    ):
        raise ValueError("MT3 retained note evidence count is invalid")
    previous = None
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("MT3 retained note evidence has an invalid event")
        start, end = event.get("start"), event.get("end")
        pitch, velocity = event.get("pitch"), event.get("velocity")
        confidence = event.get("confidence")
        if (
            isinstance(start, bool) or not isinstance(start, (int, float))
            or isinstance(end, bool) or not isinstance(end, (int, float))
            or not math.isfinite(start) or not math.isfinite(end)
            or start < 0 or end <= start
            or isinstance(pitch, bool) or not isinstance(pitch, int)
            or not 0 <= pitch <= 127
            or isinstance(velocity, bool) or not isinstance(velocity, int)
            or not 1 <= velocity <= 127
            or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(confidence) or not 0 <= confidence <= 1
        ):
            raise ValueError("MT3 retained note evidence has invalid bounds")
        ordering = (start, end, pitch)
        if previous is not None and ordering < previous:
            raise ValueError("MT3 retained note evidence is not canonical")
        previous = ordering
    expected = hashlib.sha256(json.dumps(
        events, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode()).hexdigest()
    if output.get("noteEventsSha256") != expected:
        raise ValueError("MT3 retained note evidence hash is invalid")


def require_distribution_version(distribution: str, expected: str) -> None:
    """Prevent a mutable/incorrect installed wheel from claiming pinned provenance."""
    try:
        actual = version(distribution)
    except PackageNotFoundError as exc:
        raise RunnerError(f"{distribution}=={expected} is not installed") from exc
    if actual != expected:
        raise RunnerError(f"{distribution} version {actual} does not match pinned {expected}")


def checkpoint_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    if path.is_file():
        files = [path]
    elif path.is_dir():
        files = sorted(item for item in path.rglob("*") if item.is_file())
        if not files:
            raise RunnerError("checkpoint directory is empty")
    else:
        raise RunnerError("checkpoint is missing from durable storage")
    for file in files:
        if path.is_dir():
            digest.update(file.relative_to(path).as_posix().encode())
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    return digest.hexdigest()


def attest_checkpoint(path: Path, provider: str) -> str:
    """Require the same explicit pin used by the worker health contract."""
    expected = os.environ.get(f"MUSIC_PROVIDER_{provider}_CHECKPOINT_SHA256", "").strip().lower()
    if len(expected) != 64 or any(char not in "0123456789abcdef" for char in expected):
        raise RunnerError(
            f"MUSIC_PROVIDER_{provider}_CHECKPOINT_SHA256 must be an exact SHA-256"
        )
    actual = checkpoint_sha256(path)
    if not hmac.compare_digest(actual, expected):
        raise RunnerError("mounted checkpoint SHA-256 does not match its pinned environment value")
    return actual


def require_cuda() -> Any:
    try:
        import torch
    except ImportError as exc:
        raise RunnerError("PyTorch is not installed in this runner image") from exc
    if not torch.cuda.is_available():
        raise RunnerError("CUDA GPU is not available; CPU inference is prohibited")
    try:
        torch.empty(1, device="cuda").zero_()
    except Exception as exc:
        raise RunnerError(f"CUDA allocation failed: {type(exc).__name__}") from exc
    return torch


def request_value(request: dict[str, Any], name: str, default: Any = None) -> Any:
    """Read a canonical top-level value or its canonical ``input`` counterpart."""
    if name in request:
        return request[name]
    input_value = request.get("input")
    if isinstance(input_value, dict):
        return input_value.get(name, default)
    return default


def durable_job_dir(request: dict[str, Any], provider: str) -> Path:
    root = Path(os.environ.get(
        "MUSIC_GPU_JOB_OUTPUT_ROOT", "/var/lib/music-ai-gpu/models/job-outputs"
    ))
    job_id = str(request.get("requestId") or request.get("jobId") or uuid.uuid4().hex)
    if not job_id or len(job_id) > 128 or any(c not in "-_." and not c.isalnum() for c in job_id):
        raise RunnerError("requestId is invalid")
    path = root / provider.lower() / job_id
    fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    try:
        path.mkdir(mode=0o750, parents=True, exist_ok=False)
        (path / ".request-sha256").write_text(fingerprint)
    except FileExistsError:
        try:
            if not hmac.compare_digest((path / ".request-sha256").read_text().strip(), fingerprint):
                raise RunnerError("durable job directory belongs to a different request")
        except OSError as exc:
            raise RunnerError("existing durable job directory has no request identity") from exc
    return path


def download_source(source_url: Any, destination: Path) -> Path:
    if not isinstance(source_url, str) or not source_url:
        raise RunnerError("canonical sourceUrl is required")
    parsed = urllib.parse.urlparse(source_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RunnerError("sourceUrl must be an absolute HTTPS URL")
    try:
        port = parsed.port or 443
        candidates = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as exc:
        raise RunnerError("source URL DNS lookup failed") from exc
    vetted = []
    for family, _, _, _, sockaddr in candidates:
        if not ipaddress.ip_address(sockaddr[0]).is_global:
            raise RunnerError("source URL resolves to a prohibited network address")
        vetted.append((family, sockaddr))
    if not vetted:
        raise RunnerError("source URL has no public address")

    class VettedHTTPSConnection(HTTPSConnection):
        def connect(self) -> None:
            family, sockaddr = vetted[0]
            sock = socket.socket(family, socket.SOCK_STREAM)
            try:
                sock.settimeout(self.timeout)
                sock.connect(sockaddr)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
            except Exception:
                sock.close()
                raise

    connection = VettedHTTPSConnection(parsed.hostname, port, timeout=30)
    try:
        target = parsed.path or "/"
        if parsed.query:
            target += f"?{parsed.query}"
        connection.request("GET", target, headers={"User-Agent": "music-ai-gpu-runner/1"})
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise RunnerError("source redirects are not permitted")
        if not 200 <= response.status < 300:
            raise RunnerError("source server returned an unsuccessful response")
        with response, destination.open("wb") as output:
            length = response.headers.get("Content-Length")
            if length and (not length.isdigit() or int(length) > MAX_INPUT_BYTES):
                raise RunnerError("source audio exceeds input size limit")
            total = 0
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > MAX_INPUT_BYTES:
                    raise RunnerError("source audio exceeds input size limit")
                output.write(block)
    except RunnerError:
        destination.unlink(missing_ok=True)
        raise
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise RunnerError(f"unable to fetch source audio: {type(exc).__name__}") from exc
    if not destination.exists() or not destination.stat().st_size:
        raise RunnerError("source audio is empty")
    validate_audio(destination)
    return destination


def smoke_input_path(checkpoint: Path, provider: str) -> Path | None:
    """Resolve a trusted mounted smoke fixture without permitting arbitrary files."""
    value = os.environ.get("MUSIC_GPU_SMOKE_INPUT_PATH", "").strip()
    if not value:
        return None
    candidate = Path(value).resolve()
    volume = Path(os.environ.get(
        "MUSIC_GPU_CHECKPOINT_ROOT", str(checkpoint.resolve().parent)
    )).resolve()
    if candidate != volume and volume not in candidate.parents:
        raise RunnerError("smoke input path must be inside MUSIC_GPU_CHECKPOINT_ROOT")
    validate_audio(candidate)
    pin_key = f"MUSIC_PROVIDER_{provider}_SMOKE_INPUT_SHA256"
    expected = os.environ.get(pin_key, "").strip().lower()
    if not expected:
        if provider in {"BS_ROFORMER", "YOUR_MT3"}:
            raise RunnerError(f"{pin_key} must be an exact SHA-256")
        return candidate
    if len(expected) != 64 or any(char not in "0123456789abcdef" for char in expected):
        raise RunnerError(f"{pin_key} must be an exact SHA-256")
    actual = checkpoint_sha256(candidate)
    if not hmac.compare_digest(actual, expected):
        raise RunnerError("mounted smoke input SHA-256 does not match its pinned environment value")
    return candidate


def materialize_source(request: dict[str, Any], destination: Path,
                       checkpoint: Path, provider: str, smoke: bool = False) -> Path:
    """Use a trusted local smoke fixture or the normal vetted HTTPS source path."""
    local = smoke_input_path(checkpoint, provider) if smoke else None
    if local is not None:
        shutil.copyfile(local, destination)
        validate_audio(destination)
        return destination
    url = (os.environ.get("MUSIC_GPU_SMOKE_INPUT_URL", "").strip()
           if smoke else request_value(request, "sourceUrl"))
    if smoke and not url:
        # Backward-compatible name, explicitly treated as a URL.
        url = os.environ.get("MUSIC_GPU_SMOKE_INPUT", "").strip()
    if not url:
        raise RunnerError(
            "MUSIC_GPU_SMOKE_INPUT_PATH or MUSIC_GPU_SMOKE_INPUT_URL is required"
            if smoke else "canonical sourceUrl is required"
        )
    return download_source(url, destination)


def validate_audio(path: Path) -> dict[str, Any]:
    """Require a bounded, finite, non-silent decodable audio artifact."""
    if not path.is_file() or path.stat().st_size <= 0 or path.stat().st_size > MAX_OUTPUT_BYTES:
        raise RunnerError("audio artifact is missing, empty, or exceeds output size limit")
    try:
        import soundfile as sf
        import numpy as np
        info = sf.info(str(path))
        if info.samplerate <= 0 or info.frames <= 0 or info.channels <= 0:
            raise RunnerError("audio artifact has invalid stream metadata")
        duration = info.frames / info.samplerate
        if not math.isfinite(duration) or duration <= 0 or duration > MAX_DURATION_SECONDS:
            raise RunnerError("audio artifact duration is invalid or exceeds limit")
        # Reading in blocks prevents a maliciously huge decoded allocation.
        peak = 0.0
        square_sum = 0.0
        sample_count = 0
        for block in sf.blocks(str(path), blocksize=65536, always_2d=True):
            if not np.isfinite(block).all():
                raise RunnerError("audio artifact contains non-finite samples")
            peak = max(peak, float(np.max(np.abs(block))))
            square_sum += float(np.sum(np.square(block, dtype=np.float64)))
            sample_count += int(block.size)
        if peak < 1e-5:
            raise RunnerError("audio artifact is silent")
        rms = math.sqrt(square_sum / sample_count) if sample_count else 0.0
        if rms < 1e-7:
            raise RunnerError("audio artifact has no measurable signal energy")
    except RunnerError:
        raise
    except ImportError as exc:
        raise RunnerError("soundfile and numpy are required to validate output") from exc
    except Exception as exc:
        raise RunnerError(f"audio artifact cannot be decoded: {type(exc).__name__}") from exc
    return {
        "path": str(path),
        "format": path.suffix.removeprefix(".").lower(),
        "sampleRate": info.samplerate,
        "channels": info.channels,
        "durationSeconds": round(duration, 6),
        "bytes": path.stat().st_size,
        "sha256": file_sha256(path),
        "peakAmplitude": peak,
        "rmsAmplitude": rms,
    }

def artifact_descriptor(path: Path, provider: str, job_id: str) -> dict[str, Any]:
    """Expose a signed capability, never a worker-local filesystem location."""
    base = os.getenv("MUSIC_GPU_ARTIFACT_BASE_URL", "").rstrip("/")
    secret = os.getenv("MUSIC_GPU_ARTIFACT_CAPABILITY_SECRET", "")
    if not base.startswith("https://") or not secret:
        raise RunnerError("artifact capability URL configuration is required")
    try:
        expires = int(os.getenv("MUSIC_GPU_ARTIFACT_CAPABILITY_EXPIRES", ""))
    except ValueError as exc:
        raise RunnerError("artifact capability expiration is invalid") from exc
    if expires <= int(time.time()):
        raise RunnerError("artifact capability expiration is invalid")
    result = validate_audio(path)
    result.pop("path", None)
    name = path.name
    token = hmac.new(secret.encode(), f"{provider}/{job_id}/{name}/{result['sha256']}/{expires}".encode(),
                     hashlib.sha256).hexdigest()
    result.update({"name": name, "contentType": f"audio/{result['format']}",
                   "url": f"{base}/{provider.lower()}/{job_id}/{urllib.parse.quote(name)}"
                          f"?expires={expires}&capability={token}",
                   "capability": token, "expiresAt": expires})
    return result


def cached_result(work: Path) -> dict[str, Any] | None:
    try:
        value = json.loads((work / "result.json").read_text())
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise RunnerError("existing durable job result is invalid") from exc
    if not isinstance(value, dict):
        raise RunnerError("existing durable job result is invalid")
    return value


def save_result(work: Path, value: dict[str, Any]) -> None:
    temporary = work / ".result.json.tmp"
    temporary.write_text(json.dumps(value, separators=(",", ":"), sort_keys=True))
    temporary.chmod(0o600)
    os.replace(temporary, work / "result.json")


def runtime_provenance() -> dict[str, str]:
    torch = require_cuda()
    container = os.getenv("MUSIC_GPU_CONTAINER_DIGEST", "").strip()
    if not container:
        raise RunnerError("MUSIC_GPU_CONTAINER_DIGEST is required for provenance")
    modal_image_id = os.getenv("MODAL_IMAGE_ID", "").strip()
    if not __import__("re").fullmatch(r"im-[A-Za-z0-9]+", modal_image_id):
        raise RunnerError("valid MODAL_IMAGE_ID is required for provenance")
    provenance = {"sourceImageDigest": container, "containerDigest": container,
            "modalImageId": modal_image_id, "imageId": modal_image_id,
            "cudaVersion": str(torch.version.cuda or "unknown"),
            "pytorchVersion": str(torch.__version__),
            "gpu": torch.cuda.get_device_name(torch.cuda.current_device())}
    compatibility_patch = os.getenv(
        "MUSIC_GPU_COMPATIBILITY_PATCH_SHA256", ""
    ).strip().lower()
    if compatibility_patch:
        if not __import__("re").fullmatch(r"[a-f0-9]{64}", compatibility_patch):
            raise RunnerError("compatibility patch identity is invalid")
        provenance["compatibilityPatchSha256"] = compatibility_patch
    return provenance


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def move_artifact(source: Path, destination: Path) -> Path:
    if source.resolve() == destination.resolve():
        return source
    shutil.copy2(source, destination)
    return destination


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))