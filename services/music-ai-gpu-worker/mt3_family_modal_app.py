"""Dedicated production Modal app for Wave 2 MR-MT3 and YourMT3 only.

Deploy this app independently of ``modal_app.py``.  It deliberately does not
import that module, so deploying this app cannot register or redeploy the
promoted ACE-Step, BS-RoFormer, MT3, or All-In-One functions.
"""
from __future__ import annotations

import os
from pathlib import Path

import modal

from modal_config import (
    DEPLOYMENTS,
    JOB_MOUNT,
    JOB_VOLUME_NAME,
    MR_MT3_MODEL_VOLUME_NAME,
    MT3_FAMILY_MODEL_MOUNT,
    OUTPUT_MOUNT,
    OUTPUT_VOLUME_NAME,
    promotion_secret_name,
    provider_image_build_args,
    provider_app_name,
    RUNTIME_SECRET_NAME,
    YOUR_MT3_MODEL_VOLUME_NAME,
    worker_environment,
)


APP_NAME = "music-ai-mt3-family-worker"
ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next(
    (candidate for candidate in (ROOT, *ROOT.parents)
     if (candidate / "pnpm-workspace.yaml").is_file()),
    ROOT,
)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
job_volume = modal.Volume.from_name(JOB_VOLUME_NAME, create_if_missing=False)
output_volume = modal.Volume.from_name(OUTPUT_VOLUME_NAME, create_if_missing=False)
mr_mt3_model_volume = modal.Volume.from_name(MR_MT3_MODEL_VOLUME_NAME, create_if_missing=False)
your_mt3_model_volume = modal.Volume.from_name(YOUR_MT3_MODEL_VOLUME_NAME, create_if_missing=False)
enabled_providers = {
    provider.strip().upper()
    for provider in os.getenv(
        "MUSIC_GPU_MT3_FAMILY_PROVIDERS", "MR_MT3,YOUR_MT3"
    ).split(",")
    if provider.strip()
}
if not enabled_providers or enabled_providers - {"MR_MT3", "YOUR_MT3"}:
    raise ValueError(
        "MUSIC_GPU_MT3_FAMILY_PROVIDERS must select MR_MT3 and/or YOUR_MT3"
    )
# Isolate production releases while preserving the shared-app local default.
if len(enabled_providers) == 1:
    app = modal.App(provider_app_name(next(iter(enabled_providers))))
else:
    app = modal.App(APP_NAME)
provider_apps = {provider: app for provider in enabled_providers}

provider_images = {
    "MR_MT3": modal.Image.from_dockerfile(
        ROOT / "Dockerfile.mr-mt3", context_dir=REPOSITORY_ROOT,
        build_args=provider_image_build_args(DEPLOYMENTS["MR_MT3"]),
    ),
    "YOUR_MT3": modal.Image.from_dockerfile(
        ROOT / "Dockerfile.your-mt3", context_dir=REPOSITORY_ROOT,
        build_args=provider_image_build_args(DEPLOYMENTS["YOUR_MT3"]),
    ),
}


def _worker_options(provider: str, model_volume: modal.Volume) -> dict:
    deployment = DEPLOYMENTS[provider]
    return {
        "image": provider_images[provider],
        "gpu": deployment.gpu,
        "secrets": [
            runtime_secret,
            modal.Secret.from_name(promotion_secret_name(provider)),
        ],
        "volumes": {
            MT3_FAMILY_MODEL_MOUNT: model_volume,
            JOB_MOUNT: job_volume,
            OUTPUT_MOUNT: output_volume,
        },
        "timeout": deployment.timeout_seconds,
        "scaledown_window": deployment.idle_timeout_seconds,
        "max_containers": deployment.max_containers,
        "env": worker_environment(deployment),
    }


if "MR_MT3" in enabled_providers:
    @provider_apps["MR_MT3"].cls(**_worker_options("MR_MT3", mr_mt3_model_volume))
    @modal.concurrent(max_inputs=1)
    class MrMt3Worker:
        @modal.asgi_app(label="mr-mt3")
        def endpoint(self):
            # app.py retains the bearer auth, durable job/artifact fencing,
            # checkpoint attestation, and signed runtime identity validation.
            from app import app as fastapi_app
            return fastapi_app


if "YOUR_MT3" in enabled_providers:
    @provider_apps["YOUR_MT3"].cls(**_worker_options("YOUR_MT3", your_mt3_model_volume))
    @modal.concurrent(max_inputs=1)
    class YourMt3Worker:
        @modal.asgi_app(label="your-mt3")
        def endpoint(self):
            from app import app as fastapi_app
            return fastapi_app