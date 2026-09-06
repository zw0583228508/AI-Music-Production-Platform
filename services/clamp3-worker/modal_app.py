from pathlib import Path

import modal

from modal_config import APP_NAME, ASSET_VOLUME, GPU, TIMEOUT_SECONDS

ROOT = Path(__file__).resolve().parent
app = modal.App(APP_NAME)
volume = modal.Volume.from_name(ASSET_VOLUME, create_if_missing=False)
image = modal.Image.from_dockerfile(ROOT / "Dockerfile", context_dir=ROOT)
runtime_secret = modal.Secret.from_name("music-ai-worker-runtime")


@app.function(
    image=image,
    gpu=GPU,
    timeout=TIMEOUT_SECONDS,
    secrets=[runtime_secret],
    volumes={"/models/clamp3": volume},
)
@modal.asgi_app()
def api():
    from app import app as fastapi_app

    return fastapi_app