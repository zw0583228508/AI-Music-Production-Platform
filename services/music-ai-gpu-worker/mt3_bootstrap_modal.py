"""One-shot provisioning for the provider-private canonical MT3 model volume."""
from __future__ import annotations

import sys
from pathlib import Path

import modal

if Path("/app/modal_config.py").is_file():
    sys.path.insert(0, "/app")
from modal_config import MODEL_MOUNT, MT3_MODEL_VOLUME_NAME


APP_NAME = "music-ai-mt3-model-bootstrap"
WORKER_ROOT = Path(__file__).resolve().parent
app = modal.App(APP_NAME)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .add_local_dir(WORKER_ROOT, remote_path="/app", copy=True)
)
model_volume = modal.Volume.from_name(
    MT3_MODEL_VOLUME_NAME, create_if_missing=True
)


@app.function(
    image=image,
    volumes={MODEL_MOUNT: model_volume},
    timeout=60 * 60,
    max_containers=1,
)
def bootstrap_remote() -> dict:
    sys.path.insert(0, "/app")
    from checkpoint_bootstrap import bootstrap_provider

    try:
        result = bootstrap_provider("MT3")
    finally:
        model_volume.commit()
    print(result)
    return result


@app.local_entrypoint()
def bootstrap() -> None:
    print(bootstrap_remote.remote())