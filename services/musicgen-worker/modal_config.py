"""Credential-free deployment configuration for the isolated MusicGen worker."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

APP_NAME = "musicgen-worker"
ENDPOINT_LABEL = "musicgen"
RUNTIME_SECRET_NAME = "music-ai-worker-runtime"
LICENSE_SECRET_NAME = "musicgen-cc-by-nc-4-0-acceptance-v1"
MODEL_VOLUME_NAME = "musicgen-models-private-v1"
SMOKE_VOLUME_NAME = "musicgen-smoke-private-v1"
OUTPUT_VOLUME_NAME = "musicgen-artifacts-private-v1"
MODEL_MOUNT = "/var/lib/musicgen/models"
SMOKE_MOUNT = "/var/lib/musicgen/smoke"
OUTPUT_MOUNT = "/var/lib/musicgen/artifacts"
WORKER_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next(
    (item for item in (WORKER_ROOT, *WORKER_ROOT.parents) if (item / "pnpm-workspace.yaml").is_file()),
    WORKER_ROOT,
)


def image_evidence() -> str:
    """A reproducible digest of image inputs, not a claimed registry digest."""
    digest = hashlib.sha256()
    for name in ("Dockerfile", "requirements.txt", "model_manifest.json", "app.py", "bootstrap_assets.py"):
        path = WORKER_ROOT / name
        digest.update(name.encode("utf-8") + b"\0" + path.read_bytes() + b"\0")
    return "sha256:" + digest.hexdigest()


def worker_environment() -> dict[str, str]:
    return {
        "MUSICGEN_ASSET_ROOT": MODEL_MOUNT,
        "MUSICGEN_SMOKE_ROOT": SMOKE_MOUNT,
        "MUSICGEN_ARTIFACT_ROOT": OUTPUT_MOUNT,
        "HF_HOME": f"{MODEL_MOUNT}/hf-cache",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "MUSICGEN_IMAGE_EVIDENCE": image_evidence(),
        "PYTHONUNBUFFERED": "1",
    }


def workload_environment(*, online: bool = False) -> dict[str, str]:
    """Environment exclusively for Python 3.9 AudioCraft subprocesses.

    Modal's decorator/control interpreter must retain its injected Python
    (currently >=3.10).  In particular, do not pass this PATH to decorators.
    """
    environment = worker_environment()
    environment["PATH"] = "/opt/musicgen-venv/bin:" + os.environ.get("PATH", "")
    if online:
        environment["HF_HUB_OFFLINE"] = "0"
        environment["TRANSFORMERS_OFFLINE"] = "0"
    return environment