"""Dedicated AnyAccomp provisioning, smoke and bearer-only endpoint."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import modal

from modal_config import *

app = modal.App(APP_NAME)
SOURCE_IMAGE_DIGEST = "sha256:73ea0220b42826b7603162855ab2b6fdf5695a8b265403aa38462ae206690fd3"
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile",
    context_dir=WORKER_ROOT.parent.parent,
    build_args={"SOURCE_IMAGE_DIGEST": SOURCE_IMAGE_DIGEST},
)
provision_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install("huggingface-hub==0.34.4")
    .add_local_dir(WORKER_ROOT, remote_path="/app")
)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
artifacts = modal.Volume.from_name(ARTIFACT_VOLUME_NAME, create_if_missing=False)
secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
promotion_secret = modal.Secret.from_name(PROMOTION_SECRET_NAME)


@app.function(
    image=provision_image,
    volumes={MODEL_MOUNT: models},
    timeout=7200,
)
def provision_assets() -> dict:
    os.environ["ANYACCOMP_ASSET_ROOT"] = MODEL_MOUNT
    sys.path.insert(0, "/app")
    from bootstrap_assets import main

    result = main()
    models.commit()
    return result


@app.function(
    image=image,
    gpu="L40S",
    volumes={MODEL_MOUNT: models},
    timeout=1800,
)
def smoke_fixture(fixture_path: str) -> dict:
    os.environ["ANYACCOMP_ASSET_ROOT"] = MODEL_MOUNT
    sys.path.insert(0, "/app")
    from smoke import main

    result = main(Path(fixture_path))
    models.commit()
    return result


@app.function(
    image=image,
    gpu="L40S",
    volumes={MODEL_MOUNT: models},
    timeout=900,
)
def runtime_identity() -> dict:
    import accelerate
    import torch
    import torchaudio
    import torchvision
    import transformers

    return {
        "pythonVersion": ".".join(map(str, sys.version_info[:3])),
        "torchVersion": torch.__version__,
        "torchaudioVersion": torchaudio.__version__,
        "torchvisionVersion": torchvision.__version__,
        "transformersVersion": transformers.__version__,
        "accelerateVersion": accelerate.__version__,
        "cudaAvailable": torch.cuda.is_available(),
        "cudaVersion": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }


@app.cls(
    image=image,
    gpu="L40S",
    secrets=[secret, promotion_secret],
    volumes={MODEL_MOUNT: models, ARTIFACT_MOUNT: artifacts},
    timeout=1800,
    max_containers=1,
)
class AnyAccompWorker:
    @modal.asgi_app(label=ENDPOINT_LABEL)
    def endpoint(self):
        from app import app as api

        return api