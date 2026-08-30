"""Lightweight Modal entry point for synchronizing reviewed checkpoints.

This app is intentionally separate from the GPU worker deployment so a model
Volume bootstrap does not build every provider's CUDA/PyTorch image.
"""
from __future__ import annotations

import sys
from pathlib import Path

import modal

if Path("/app/modal_config.py").is_file():
    sys.path.insert(0, "/app")
from modal_config import MODEL_MOUNT, MODEL_VOLUME_NAME


APP_NAME = "music-ai-model-bootstrap"
WORKER_ROOT = Path(__file__).resolve().parent
app = modal.App(APP_NAME)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("huggingface-hub==0.28.1")
    .add_local_dir(WORKER_ROOT, remote_path="/app", copy=True)
)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)


@app.function(
    image=image,
    volumes={MODEL_MOUNT: model_volume},
    timeout=24 * 60 * 60,
    max_containers=1,
)
def bootstrap_remote(provider: str) -> dict:
    sys.path.insert(0, "/app")
    from checkpoint_bootstrap import bootstrap_provider

    try:
        result = bootstrap_provider(provider)
    finally:
        model_volume.commit()
    print(result)
    return result


@app.local_entrypoint()
def bootstrap(provider: str) -> None:
    normalized = provider.strip().upper()
    if normalized not in {"BS_ROFORMER", "ACE_STEP", "MT3", "ALL_IN_ONE"}:
        raise ValueError(
            "provider must be BS_ROFORMER, ACE_STEP, MT3, or ALL_IN_ONE"
        )
    print(bootstrap_remote.remote(normalized))