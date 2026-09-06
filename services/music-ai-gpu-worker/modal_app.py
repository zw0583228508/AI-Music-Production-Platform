"""Modal deployment entry point for the fail-closed FastAPI GPU worker.

Deploy from the repository root with:
    modal deploy services/music-ai-gpu-worker/modal_app.py

No endpoint is marked ready by this module.  Readiness still requires the
secret-provided runner, an exact checkpoint hash, mounted weights, CUDA smoke
inference, and the FastAPI bearer token in app.py.
"""
from __future__ import annotations

from pathlib import Path
import os

import modal

from modal_config import (
    DEPLOYMENTS,
    JOB_MOUNT,
    JOB_VOLUME_NAME,
    MODEL_MOUNT,
    OUTPUT_MOUNT,
    OUTPUT_VOLUME_NAME,
    promotion_secret_name,
    RUNTIME_SECRET_NAME,
    provider_image_build_args,
    provider_app_name,
    provider_model_volume_name,
    worker_environment,
)


APP_NAME = "music-ai-gpu-worker"
MODULE_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next(
    (
        candidate
        for candidate in (MODULE_ROOT, *MODULE_ROOT.parents)
        if (candidate / "pnpm-workspace.yaml").is_file()
    ),
    MODULE_ROOT,
)
PROVIDER_DOCKERFILES = {
    "ACE_STEP": MODULE_ROOT / "Dockerfile.ace-step",
    "BS_ROFORMER": MODULE_ROOT / "Dockerfile.bs-roformer",
    "MT3": MODULE_ROOT / "Dockerfile.mt3",
    "ALL_IN_ONE": MODULE_ROOT / "Dockerfile.all-in-one",
}
LICENSE_BLOCKED_PROVIDERS = {"BS_ROFORMER"}
# Each production provider is a distinct app.  This avoids a deployment of one
# function replacing sibling functions or stopping their containers.  Keeping
# all definitions importable preserves the existing local Modal developer flow.
release_providers = {
    value.strip().upper() for value in os.getenv(
        "MUSIC_GPU_MODAL_DEPLOY_PROVIDERS", "ACE_STEP,MT3,ALL_IN_ONE"
    ).split(",") if value.strip()
}
if not release_providers or release_providers - {"BS_ROFORMER", "ACE_STEP", "MT3", "ALL_IN_ONE"}:
    raise ValueError("MUSIC_GPU_MODAL_DEPLOY_PROVIDERS selects an unsupported provider")
blocked_release_providers = release_providers & LICENSE_BLOCKED_PROVIDERS
if blocked_release_providers:
    raise ValueError(
        "MUSIC_GPU_MODAL_DEPLOY_PROVIDERS selects license-blocked provider(s): "
        + ",".join(sorted(blocked_release_providers))
    )
if len(release_providers) == 1:
    app = modal.App(provider_app_name(next(iter(release_providers))))
else:
    # Preserve the existing shared-app default for local development/imports.
    app = modal.App(APP_NAME)
provider_apps = {provider: app for provider in release_providers}

# Modal identifies Dockerfile-based images by Dockerfile path before it applies
# build arguments. Every provider therefore needs a unique Dockerfile path.
provider_images: dict[str, modal.Image] = {
    "BS_ROFORMER": modal.Image.from_dockerfile(
        PROVIDER_DOCKERFILES["BS_ROFORMER"],
        context_dir=REPOSITORY_ROOT,
        build_args=provider_image_build_args(DEPLOYMENTS["BS_ROFORMER"]),
    ),
    "ACE_STEP": modal.Image.from_dockerfile(
        PROVIDER_DOCKERFILES["ACE_STEP"],
        context_dir=REPOSITORY_ROOT,
        build_args=provider_image_build_args(DEPLOYMENTS["ACE_STEP"]),
    ),
    "MT3": modal.Image.from_dockerfile(
        PROVIDER_DOCKERFILES["MT3"],
        context_dir=REPOSITORY_ROOT,
        build_args=provider_image_build_args(DEPLOYMENTS["MT3"]),
    ),
    "ALL_IN_ONE": modal.Image.from_dockerfile(
        PROVIDER_DOCKERFILES["ALL_IN_ONE"],
        context_dir=REPOSITORY_ROOT,
        build_args=provider_image_build_args(DEPLOYMENTS["ALL_IN_ONE"]),
    ),
}
model_volumes = {
    provider: modal.Volume.from_name(
        provider_model_volume_name(provider), create_if_missing=False
    )
    for provider in release_providers
}
job_volume = modal.Volume.from_name(JOB_VOLUME_NAME, create_if_missing=False)
output_volume = modal.Volume.from_name(OUTPUT_VOLUME_NAME, create_if_missing=False)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)


def _worker_options(provider: str) -> dict:
    deployment = DEPLOYMENTS[provider]
    return {
        "image": provider_images[provider],
        "gpu": deployment.gpu,
        "secrets": [
            runtime_secret,
            modal.Secret.from_name(promotion_secret_name(provider)),
        ],
        "volumes": {
            MODEL_MOUNT: model_volumes[provider],
            JOB_MOUNT: job_volume,
            OUTPUT_MOUNT: output_volume,
        },
        "timeout": deployment.timeout_seconds,
        "scaledown_window": deployment.idle_timeout_seconds,
        "max_containers": deployment.max_containers,
        "env": worker_environment(deployment),
    }


if "BS_ROFORMER" in release_providers:
    @provider_apps["BS_ROFORMER"].cls(**_worker_options("BS_ROFORMER"))
    @modal.concurrent(max_inputs=1)
    class BSRoFormerWorker:
        @modal.asgi_app(label="bs-roformer-isolated")
        def endpoint(self):
            from app import app as fastapi_app
            return fastapi_app


if "ACE_STEP" in release_providers:
    @provider_apps["ACE_STEP"].cls(**_worker_options("ACE_STEP"))
    @modal.concurrent(max_inputs=1)
    class AceStepWorker:
        @modal.asgi_app(label="ace-step-isolated")
        def endpoint(self):
            from app import app as fastapi_app
            return fastapi_app


if "MT3" in release_providers:
    @provider_apps["MT3"].cls(**_worker_options("MT3"))
    @modal.concurrent(max_inputs=1)
    class MT3Worker:
        @modal.asgi_app(label="mt3-isolated")
        def endpoint(self):
            from app import app as fastapi_app
            return fastapi_app


if "ALL_IN_ONE" in release_providers:
    @provider_apps["ALL_IN_ONE"].cls(**_worker_options("ALL_IN_ONE"))
    @modal.concurrent(max_inputs=1)
    class AllInOneWorker:
        @modal.asgi_app(label="all-in-one-isolated")
        def endpoint(self):
            from app import app as fastapi_app
            return fastapi_app
