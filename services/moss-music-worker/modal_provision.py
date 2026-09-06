"""Explicit, network-enabled provisioning function; never invoked by requests."""
from __future__ import annotations
import os, subprocess, sys
from pathlib import Path
ROOT = Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import modal
from modal_config import (APP_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME, REPOSITORY_ROOT, RUNTIME_SECRET_NAME,
    SMOKE_MOUNT, SMOKE_VOLUME_NAME, WORKER_ROOT, worker_environment, workload_environment)
app = modal.App(APP_NAME)
image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT)
@app.function(image=image, gpu="L40S", secrets=[modal.Secret.from_name(RUNTIME_SECRET_NAME)],
 volumes={MODEL_MOUNT:modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True),
          SMOKE_MOUNT:modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=True)},
 env=worker_environment(online=True), timeout=7200)
def provision() -> None:
    # Smoke runs only after immutable snapshots have been written and committed.
    environment = {**os.environ, **workload_environment(online=True)}
    subprocess.run(["/opt/moss-venv/bin/python","/app/compatibility.py"], env=environment, check=True)
    subprocess.run(["/opt/moss-venv/bin/python","/app/bootstrap_assets.py"], env=environment, check=True)
    subprocess.run(["/opt/moss-venv/bin/python","/app/preflight.py"], env=environment, check=True)
    subprocess.run(["/opt/moss-venv/bin/python","/app/smoke.py"], env=environment, check=True)