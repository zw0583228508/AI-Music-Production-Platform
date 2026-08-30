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
    worker_environment,
)


APP_NAME = "music-ai-gpu-worker"
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = Path(__file__).resolve().with_name("Dockerfile")
app = modal.App(APP_NAME)

# Build the checked-in OCI recipe rather than resolving packages at deploy
# time. Dockerfile pins CUDA, Python, PyTorch and worker dependencies.
image = modal.Image.from_dockerfile(DOCKERFILE, context_dir=REPOSITORY_ROOT)
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
        "image": image,
        "gpu": deployment.gpu,
        "secrets": [runtime_secret],
        "volumes": volumes,
        "timeout": deployment.timeout_seconds,
        "container_idle_timeout": deployment.idle_timeout_seconds,
        "max_containers": deployment.max_containers,
        "allow_concurrent_inputs": 1,
        "env": worker_environment(deployment),
    }


@app.cls(**_worker_options("BS_ROFORMER"))
class BSRoFormerWorker:
    """Private-by-bearer provider URL; only BS_ROFORMER is enabled."""

    @modal.asgi_app(label="bs-roformer")
    def endpoint(self):
        from app import app as fastapi_app

        return fastapi_app


@app.cls(**_worker_options("ACE_STEP"))
class AceStepWorker:
    """Private-by-bearer provider URL; only ACE_STEP is enabled."""

    @modal.asgi_app(label="ace-step")
    def endpoint(self):
        from app import app as fastapi_app

        return fastapi_app


@app.cls(**_worker_options("MT3"))
class MT3Worker:
    """Private-by-bearer provider URL; only MT3 is enabled."""

    @modal.asgi_app(label="mt3")
    def endpoint(self):
        from app import app as fastapi_app

        return fastapi_app


@app.cls(**_worker_options("MUSICGEN"))
class MusicGenWorker:
    """Existing contract endpoint, deliberately not enabled by default."""

    @modal.asgi_app(label="musicgen")
    def endpoint(self):
        from app import app as fastapi_app

        return fastapi_app