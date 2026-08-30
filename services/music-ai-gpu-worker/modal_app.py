"""Modal deployment entry point for the fail-closed FastAPI GPU worker.

Deploy from the repository root with:
    modal deploy services/music-ai-gpu-worker/modal_app.py

No endpoint is marked ready by this module.  Readiness still requires the
secret-provided runner, an exact checkpoint hash, mounted weights, CUDA smoke
inference, and the FastAPI bearer token in app.py.
"""
from __future__ import annotations

from pathlib import Path

import modal

from modal_config import (
    DEPLOYMENTS,
    JOB_MOUNT,
    JOB_VOLUME_NAME,
    MODEL_MOUNT,
    MODEL_VOLUME_NAME,
    OUTPUT_MOUNT,
    OUTPUT_VOLUME_NAME,
    RUNTIME_SECRET_NAME,
    provider_image_build_args,
    selected_deployments,
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
DOCKERFILE = MODULE_ROOT / "Dockerfile"
app = modal.App(APP_NAME)

# Build a separate OCI image for every provider.  Its pinned runner
# requirements are installed during the image build, never at request time.
SELECTED_DEPLOYMENTS = selected_deployments()
provider_images = {
    provider: modal.Image.from_dockerfile(
        DOCKERFILE,
        context_dir=REPOSITORY_ROOT,
        # Source identity is runtime provenance, not a Docker cache input.
        build_args=provider_image_build_args(deployment),
    )
    for provider, deployment in SELECTED_DEPLOYMENTS.items()
}
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
job_volume = modal.Volume.from_name(JOB_VOLUME_NAME, create_if_missing=False)
output_volume = modal.Volume.from_name(OUTPUT_VOLUME_NAME, create_if_missing=False)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
volumes = {
    MODEL_MOUNT: model_volume,
    JOB_MOUNT: job_volume,
    OUTPUT_MOUNT: output_volume,
}


def _worker_options(provider: str) -> dict:
    deployment = DEPLOYMENTS[provider]
    return {
        "image": provider_images[provider],
        "gpu": deployment.gpu,
        "secrets": [runtime_secret],
        "volumes": volumes,
        "timeout": deployment.timeout_seconds,
        "scaledown_window": deployment.idle_timeout_seconds,
        "max_containers": deployment.max_containers,
        "env": worker_environment(deployment),
    }


if "BS_ROFORMER" in SELECTED_DEPLOYMENTS:
    @app.cls(**_worker_options("BS_ROFORMER"))
    @modal.concurrent(max_inputs=1)
    class BSRoFormerWorker:
        @modal.asgi_app(label="bs-roformer")
        def endpoint(self):
            from app import app as fastapi_app
            return fastapi_app


if "ACE_STEP" in SELECTED_DEPLOYMENTS:
    @app.cls(**_worker_options("ACE_STEP"))
    @modal.concurrent(max_inputs=1)
    class AceStepWorker:
        @modal.asgi_app(label="ace-step")
        def endpoint(self):
            from app import app as fastapi_app
            return fastapi_app


if "MT3" in SELECTED_DEPLOYMENTS:
    @app.cls(**_worker_options("MT3"))
    @modal.concurrent(max_inputs=1)
    class MT3Worker:
        @modal.asgi_app(label="mt3")
        def endpoint(self):
            from app import app as fastapi_app
            return fastapi_app


if "ALL_IN_ONE" in SELECTED_DEPLOYMENTS:
    @app.cls(**_worker_options("ALL_IN_ONE"))
    @modal.concurrent(max_inputs=1)
    class AllInOneWorker:
        @modal.asgi_app(label="all-in-one")
        def endpoint(self):
            from app import app as fastapi_app
            return fastapi_app