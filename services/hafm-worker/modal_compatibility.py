"""Build the HAFM image and retain a fail-closed remote compatibility probe."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

ROOT = (
    Path("/app")
    if Path("/app/modal_config.py").is_file()
    else Path(__file__).resolve().parent
)
sys.path.insert(0, str(ROOT))

import modal

from modal_config import (
    APP_NAME,
    MODEL_MOUNT,
    MODEL_VOLUME_NAME,
    REPOSITORY_ROOT,
    SMOKE_MOUNT,
    SMOKE_VOLUME_NAME,
    WORKER_ROOT,
    worker_environment,
)

app = modal.App(f"{APP_NAME}-compatibility")
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile",
    context_dir=REPOSITORY_ROOT,
)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)
smoke_volume = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=True)


@app.function(
    image=image,
    volumes={
        MODEL_MOUNT: model_volume,
        SMOKE_MOUNT: smoke_volume,
    },
    env=worker_environment(),
    timeout=1800,
)
def verify() -> None:
    completed = subprocess.run(
        ["/opt/hafm-venv/bin/python", "/app/compatibility.py"],
        env={**os.environ, **worker_environment()},
        check=False,
    )
    smoke_volume.commit()
    if completed.returncode:
        raise subprocess.CalledProcessError(
            completed.returncode,
            completed.args,
        )