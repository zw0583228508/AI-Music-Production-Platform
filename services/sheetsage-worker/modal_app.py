"""Modal HTTPS deployment for SheetSage; deployment alone never implies READY."""
from __future__ import annotations

import modal

from modal_config import (
    APP_NAME, ENDPOINT_LABEL, LICENSE_SECRET_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME, REPOSITORY_ROOT,
    RUNTIME_SECRET_NAME, SMOKE_MOUNT, SMOKE_VOLUME_NAME, WORKER_ROOT,
    image_build_args, worker_environment,
)

app = modal.App(APP_NAME)
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT, build_args=image_build_args()
)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
smoke_volume = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=False)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
license_secret = modal.Secret.from_name(LICENSE_SECRET_NAME)


@app.cls(
    image=image,
    secrets=[runtime_secret, license_secret],
    volumes={MODEL_MOUNT: model_volume, SMOKE_MOUNT: smoke_volume},
    timeout=600,
    scaledown_window=300,
    max_containers=1,
    # Intentionally no min_containers / scale floor.
    env=worker_environment(),
)
@modal.concurrent(max_inputs=1)
class SheetSageWorker:
    @modal.asgi_app(label=ENDPOINT_LABEL)
    def endpoint(self):
        from app import app as fastapi_app
        return fastapi_app