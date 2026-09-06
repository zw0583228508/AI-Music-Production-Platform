"""Cheap compatibility probe: build and verify media without model downloads."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import modal

from modal_config import (
    APP_NAME,
    REPOSITORY_ROOT,
    SMOKE_MOUNT,
    SMOKE_VOLUME_NAME,
    WORKER_ROOT,
    worker_environment,
    workload_environment,
)

app = modal.App(f"{APP_NAME}-compatibility")
image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT)
smoke_volume = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=True)


@app.function(
    image=image,
    volumes={SMOKE_MOUNT: smoke_volume},
    env=worker_environment(),
    timeout=1800,
)
def verify() -> None:
    environment = {**os.environ, **workload_environment()}
    subprocess.run(
        ["/opt/moss-venv/bin/python", "/app/compatibility.py"],
        env=environment,
        check=True,
    )
    smoke_volume.commit()