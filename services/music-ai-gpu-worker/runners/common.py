"""Small, dependency-light safety boundary shared by GPU runners."""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024 * 1024
MAX_DURATION_SECONDS = 30 * 60
ALLOWED_AUDIO_SUFFIXES = {".wav", ".flac", ".mp3", ".m4a", ".ogg"}


class RunnerError(RuntimeError):
    """A deliberate, safe-to-report runner failure."""


def checkpoint_sha256(path: Path) -> str:
    if not path.is_file():
        raise RunnerError("checkpoint is not a mounted file")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


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
    path.mkdir(mode=0o750, parents=True, exist_ok=False)
    return path


def download_source(source_url: Any, destination: Path) -> Path:
    if not isinstance(source_url, str) or not source_url:
        raise RunnerError("canonical sourceUrl is required")
    parsed = urllib.parse.urlparse(source_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise RunnerError("sourceUrl must be an absolute HTTPS URL")
    suffix = Path(parsed.path).suffix.lower()
    if suffix not in ALLOWED_AUDIO_SUFFIXES:
        raise RunnerError("sourceUrl must name a supported audio file")
    request = urllib.request.Request(source_url, headers={"User-Agent": "music-ai-gpu-runner/1"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response, destination.open("wb") as output:
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
    return destination


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
        for block in sf.blocks(str(path), blocksize=65536, always_2d=True):
            if not np.isfinite(block).all():
                raise RunnerError("audio artifact contains non-finite samples")
            peak = max(peak, float(np.max(np.abs(block))))
        if peak < 1e-5:
            raise RunnerError("audio artifact is silent")
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
    }


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