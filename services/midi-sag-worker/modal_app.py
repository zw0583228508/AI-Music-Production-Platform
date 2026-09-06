"""Modal HTTP entrypoint.  Provisioning is intentionally in modal_provision.py."""
from __future__ import annotations
import os, subprocess, sys
from pathlib import Path
ROOT = Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import modal
from modal_config import APP_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME, REPOSITORY_ROOT, RUNTIME_SECRET_NAME, WORKER_ROOT, worker_environment
app = modal.App(APP_NAME)
image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)
secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
@app.function(image=image, gpu="L40S", secrets=[secret], volumes={MODEL_MOUNT: models}, env=worker_environment(), timeout=1800, max_containers=1)
@modal.web_server(port=8019)
def endpoint() -> None:
    subprocess.run(["/opt/midi-sag-venv/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8019"], cwd="/app", env={**os.environ, **worker_environment()}, check=True)