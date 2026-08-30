"""Shared, deliberately small safety primitives for GPU model runners."""
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class RunnerError(RuntimeError):
    """A configuration or inference failure which must fail the job."""


def require_gpu() -> None:
    try:
        import torch
    except Exception as exc:  # pragma: no cover - installation dependent
        raise RunnerError("PyTorch is required for a GPU runner") from exc
    if not torch.cuda.is_available():
        raise RunnerError("CUDA GPU is not available; CPU inference is forbidden")
    try:
        torch.empty(1, device="cuda").fill_(1).item()
    except Exception as exc:
        raise RunnerError("CUDA GPU allocation failed") from exc


def checkpoint_digest(path: Path) -> str:
    if path.is_file():
        files = [path]
        root = path.parent
    elif path.is_dir():
        files = sorted(child for child in path.rglob("*") if child.is_file())
        root = path
    else:
        raise RunnerError(f"checkpoint is missing: {path}")
    if not files:
        raise RunnerError(f"checkpoint contains no files: {path}")
    digest = hashlib.sha256()
    for child in files:
        digest.update(child.relative_to(root).as_posix().encode())
        with child.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def attest_checkpoint(path: Path) -> str:
    actual = checkpoint_digest(path)
    expected = os.getenv("MUSIC_RUNNER_CHECKPOINT_SHA256", "").strip().lower()
    if not expected:
        raise RunnerError("MUSIC_RUNNER_CHECKPOINT_SHA256 must pin the checkpoint")
    if actual != expected:
        raise RunnerError("checkpoint SHA-256 does not match MUSIC_RUNNER_CHECKPOINT_SHA256")
    return actual


def finite(value: Any, label: str, low: float | None = None, high: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RunnerError(f"{label} must be finite")
    result = float(value)
    if low is not None and result < low or high is not None and result > high:
        raise RunnerError(f"{label} is out of bounds")
    return result


def fetch_source(request: dict[str, Any]) -> tuple[Path, tempfile.TemporaryDirectory[str]]:
    source = request.get("sourceUrl")
    if not isinstance(source, str) or not source.strip():
        raise RunnerError("sourceUrl is required")
    parsed = urllib.parse.urlparse(source)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RunnerError("sourceUrl must be an HTTPS URL")
    maximum = int(os.getenv("MUSIC_RUNNER_MAX_SOURCE_BYTES", str(512 * 1024 * 1024)))
    directory = tempfile.TemporaryDirectory(prefix="music-runner-")
    target = Path(directory.name) / "source-audio"
    try:
        req = urllib.request.Request(source, headers={"User-Agent": "music-ai-gpu-worker/1"})
        with urllib.request.urlopen(req, timeout=60) as response, target.open("wb") as output:
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > maximum:
                raise RunnerError("source audio exceeds configured byte limit")
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > maximum:
                    raise RunnerError("source audio exceeds configured byte limit")
                output.write(chunk)
    except Exception:
        directory.cleanup()
        raise
    if not target.is_file() or target.stat().st_size == 0:
        directory.cleanup()
        raise RunnerError("source audio is empty")
    return target, directory


def stdin_request() -> dict[str, Any]:
    import sys
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        raise RunnerError("stdin must contain one JSON request") from exc
    if not isinstance(payload, dict):
        raise RunnerError("request must be a JSON object")
    return payload


def provenance(source_revision: str, checkpoint_sha256: str, backend: str) -> dict[str, str]:
    return {
        "source": source_revision,
        "checkpointSha256": checkpoint_sha256,
        "backend": backend,
        "device": "cuda",
    }