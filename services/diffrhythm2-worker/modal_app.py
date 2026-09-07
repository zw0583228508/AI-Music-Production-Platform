"""Dedicated immutable DiffRhythm2 research endpoint."""
from __future__ import annotations

import modal

from modal_config import (
    APP_NAME,
    ARTIFACT_MOUNT,
    ARTIFACT_VOLUME_NAME,
    DEPLOYMENT_BASE_IMAGE_ID,
    MODEL_MOUNT,
    MODEL_VOLUME_NAME,
    PROMOTION_SECRET_NAME,
    RUNTIME_SECRET_NAME,
    WORKER_ROOT,
    environment,
)

app = modal.App(APP_NAME)
image = (
    modal.Image.from_id(DEPLOYMENT_BASE_IMAGE_ID)
    .add_local_file(WORKER_ROOT / "app.py", remote_path="/app/app.py", copy=True)
    .add_local_file(
        WORKER_ROOT / "contract.py",
        remote_path="/app/contract.py",
        copy=True,
    )
    .add_local_file(
        WORKER_ROOT / "inference.py", remote_path="/app/inference.py", copy=True
    )
    .add_local_file(
        WORKER_ROOT / "upstream_runner.py",
        remote_path="/app/upstream_runner.py",
        copy=True,
    )
    .add_local_file(
        WORKER_ROOT / "model_manifest.json",
        remote_path="/app/model_manifest.json",
        copy=True,
    )
    .env({
        **environment(False),
        "PYTHONPATH": "/opt/diffrhythm2-venv/lib/python3.11/site-packages",
    })
)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
artifacts = modal.Volume.from_name(ARTIFACT_VOLUME_NAME, create_if_missing=True)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
promotion_secret = modal.Secret.from_name(PROMOTION_SECRET_NAME)


@app.function(
    image=image,
    gpu="L40S",
    secrets=[runtime_secret, promotion_secret],
    volumes={MODEL_MOUNT: models, ARTIFACT_MOUNT: artifacts},
    timeout=1800,
    scaledown_window=300,
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app()
def endpoint():
    from app import app as worker

    return worker
