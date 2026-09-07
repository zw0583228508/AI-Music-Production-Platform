"""Dedicated immutable DiffRhythm2 research endpoint."""
from __future__ import annotations

import modal

from modal_config import (
    APP_NAME,
    ARTIFACT_MOUNT,
    ARTIFACT_VOLUME_NAME,
    MODEL_MOUNT,
    MODEL_VOLUME_NAME,
    PROMOTION_SECRET_NAME,
    REPOSITORY_ROOT,
    RUNTIME_SECRET_NAME,
    WORKER_ROOT,
    environment,
)

app = modal.App(APP_NAME)
image = (
    modal.Image.from_dockerfile(
        WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT
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