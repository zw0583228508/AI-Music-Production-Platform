"""Modal serving endpoint. It never receives online bootstrap settings."""
from __future__ import annotations
import sys
import os
from pathlib import Path
ROOT = Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import modal
from modal_config import (APP_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME, OUTPUT_MOUNT, OUTPUT_VOLUME_NAME,
    REPOSITORY_ROOT, RUNTIME_SECRET_NAME, SMOKE_MOUNT, SMOKE_VOLUME_NAME, WORKER_ROOT, worker_environment, workload_environment)
app = modal.App(APP_NAME)
image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)
smoke = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=True)
outputs = modal.Volume.from_name(OUTPUT_VOLUME_NAME, create_if_missing=True)
@app.function(image=image, gpu="L40S", secrets=[runtime_secret],
  volumes={MODEL_MOUNT:models, SMOKE_MOUNT:smoke, OUTPUT_MOUNT:outputs},
  env=worker_environment(), timeout=1800, max_containers=1, scaledown_window=300)
@modal.web_server(port=8016)
def endpoint() -> None:
    import subprocess
    subprocess.run(["/opt/moss-venv/bin/python","-m","uvicorn","app:app","--host","0.0.0.0","--port","8016"],
                   cwd="/app", env={**os.environ, **workload_environment()}, check=True)