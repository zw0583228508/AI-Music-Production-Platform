"""Modal HTTP deployment for the dedicated L40S MusicGen runtime."""
from __future__ import annotations

import sys
import os
import subprocess
from pathlib import Path

_ROOT = Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT))

import modal

from modal_config import (APP_NAME, ENDPOINT_LABEL, LICENSE_SECRET_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME,
                          OUTPUT_MOUNT, OUTPUT_VOLUME_NAME, REPOSITORY_ROOT, RUNTIME_SECRET_NAME, SMOKE_MOUNT,
                          SMOKE_VOLUME_NAME, WORKER_ROOT, worker_environment, workload_environment)

app = modal.App(APP_NAME)
image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)
smoke_volume = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=True)
output_volume = modal.Volume.from_name(OUTPUT_VOLUME_NAME, create_if_missing=True)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
license_secret = modal.Secret.from_name(LICENSE_SECRET_NAME)


@app.function(image=image, gpu="L40S", secrets=[runtime_secret, license_secret],
              volumes={MODEL_MOUNT: model_volume, SMOKE_MOUNT: smoke_volume, OUTPUT_MOUNT: output_volume},
              env=worker_environment(), timeout=1_800, max_containers=1, scaledown_window=300)
@modal.web_server(port=8015)
def endpoint() -> None:
    """Keep Modal control Python separate from the Python 3.9 ASGI workload."""
    environment = {**os.environ, **workload_environment()}
    process = subprocess.Popen(
        ["/opt/musicgen-venv/bin/python", "-m", "uvicorn", "app:app",
         "--host", "0.0.0.0", "--port", "8015"],
        cwd="/app", env=environment,
    )
    try:
        code = process.wait()
        if code:
            raise RuntimeError("MusicGen Python 3.9 web workload exited unexpectedly")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=30)