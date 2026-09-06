"""Dedicated AnyAccomp image and private volumes; never share another provider."""
import modal
from modal_config import *
app = modal.App(APP_NAME)
image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile", context_dir=WORKER_ROOT.parent.parent)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
artifacts = modal.Volume.from_name(ARTIFACT_VOLUME_NAME, create_if_missing=False)
secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
@app.cls(image=image, gpu="L40S", secrets=[secret], volumes={MODEL_MOUNT: models, ARTIFACT_MOUNT: artifacts}, timeout=1800, max_containers=1)
class AnyAccompWorker:
    @modal.asgi_app(label=ENDPOINT_LABEL)
    def endpoint(self):
        from app import app as api
        return api