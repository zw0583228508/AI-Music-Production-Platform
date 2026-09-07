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
    env={"CLAMP3_NETWORK_ISOLATION": "modal-block-network-v1"},
    block_network=True,
    restrict_modal_access=True,
)
@modal.asgi_app()
def api():
    from runtime_user import drop_runtime_privileges

    drop_runtime_privileges()
    from app import app as fastapi_app

    return fastapi_app