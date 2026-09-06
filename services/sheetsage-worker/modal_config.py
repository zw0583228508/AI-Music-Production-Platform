"""Credential-free Modal configuration for the isolated SheetSage service."""
from __future__ import annotations

from pathlib import Path

APP_NAME = "sheetsage-worker"
ENDPOINT_LABEL = "sheetsage"
RUNTIME_SECRET_NAME = "music-ai-worker-runtime"
LICENSE_SECRET_NAME = "sheetsage-noncommercial-license-v1"
MODEL_VOLUME_NAME = "sheetsage-models-v1"
SMOKE_VOLUME_NAME = "sheetsage-smoke-v1"
MODEL_MOUNT = "/var/lib/sheetsage/assets"
SMOKE_MOUNT = "/var/lib/sheetsage/smoke"
WORKER_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next(
    (item for item in (WORKER_ROOT, *WORKER_ROOT.parents) if (item / "pnpm-workspace.yaml").is_file()),
    WORKER_ROOT,
)


def image_build_args() -> dict[str, str]:
    # The project owner explicitly accepted the non-commercial weight licenses.
    return {"SHEETSAGE_ACCEPT_MODEL_LICENSE": "1"}


def worker_environment() -> dict[str, str]:
    return {
        "SHEETSAGE_ASSET_ROOT": MODEL_MOUNT,
        "SHEETSAGE_CACHE_DIR": MODEL_MOUNT,
        "XDG_CACHE_HOME": MODEL_MOUNT,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "PYTHONUNBUFFERED": "1",
    }