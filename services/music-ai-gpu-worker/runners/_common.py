"""Deprecated compatibility surface; all implementation lives in common.py."""
import json
import math
import tempfile
from pathlib import Path

from .common import *  # noqa: F401,F403
from .common import RunnerError, checkpoint_sha256 as checkpoint_digest, require_cuda as require_gpu


def finite(value, label, low=None, high=None):
    return finite_number(value, label, low, high)


def fetch_source(request):
    directory = tempfile.TemporaryDirectory(prefix="music-runner-")
    try:
        return download_source(request_value(request, "sourceUrl"), Path(directory.name) / "source.wav"), directory
    except Exception:
        directory.cleanup()
        raise


def stdin_request():
    try:
        value = json.load(__import__("sys").stdin)
    except json.JSONDecodeError as exc:
        raise RunnerError("stdin must contain one JSON request") from exc
    if not isinstance(value, dict):
        raise RunnerError("request must be a JSON object")
    return value


def provenance(source_revision, checkpoint_sha256, backend):
    return {"source": source_revision, "checkpointSha256": checkpoint_sha256,
            "backend": backend, "device": "cuda", **runtime_provenance()}