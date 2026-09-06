"""Configuration and immutable source-image identity for HAFM."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

APP_NAME = "hafm-worker"
RUNTIME_SECRET_NAME = "music-ai-worker-runtime"
MODEL_VOLUME_NAME = "hafm-models-private-v1"
SMOKE_VOLUME_NAME = "hafm-smoke-private-v1"
OUTPUT_VOLUME_NAME = "hafm-artifacts-private-v1"
MODEL_MOUNT = "/var/lib/hafm/models"
SMOKE_MOUNT = "/var/lib/hafm/smoke"
OUTPUT_MOUNT = "/var/lib/hafm/artifacts"
WORKER_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next(
    (path for path in (WORKER_ROOT, *WORKER_ROOT.parents)
     if (path / "pnpm-workspace.yaml").is_file()),
    WORKER_ROOT,
)


def image_evidence() -> str:
    digest = hashlib.sha256()
    for name in (
        "Dockerfile",
        "requirements.txt",
        "model_manifest.json",
        "license_manifest.json",
        "fixture-authorization.json",
        "app.py",
        "bootstrap_assets.py",
        "compatibility.py",
        "inference.py",
        "modal_app.py",
        "modal_compatibility.py",
        "modal_config.py",
        "modal_provision.py",
        "smoke.py",
    ):
        digest.update(
            name.encode()
            + b"\0"
            + (WORKER_ROOT / name).read_bytes()
            + b"\0"
        )
    return "sha256:" + digest.hexdigest()


def worker_environment(*, online: bool = False) -> dict[str, str]:
    return {
        "HAFM_ASSET_ROOT": MODEL_MOUNT,
        "HAFM_SMOKE_ROOT": SMOKE_MOUNT,
        "HAFM_ARTIFACT_ROOT": OUTPUT_MOUNT,
        "HAFM_SOURCE_IMAGE_DIGEST": image_evidence(),
        "HF_HOME": f"{MODEL_MOUNT}/hf-cache",
        "HF_HUB_OFFLINE": "0" if online else "1",
        "TRANSFORMERS_OFFLINE": "0" if online else "1",
        "PATH": "/opt/hafm-venv/bin:" + os.environ.get("PATH", ""),
        "PYTHONUNBUFFERED": "1",
    }