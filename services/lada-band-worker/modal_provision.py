"""The only Modal operation permitted to access the network."""
from __future__ import annotations
import subprocess,sys
from pathlib import Path
ROOT=Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent;sys.path.insert(0,str(ROOT))
from license_gate import require_authorization
require_authorization("LaDA-Band Modal provisioning")
import modal
from modal_config import *
app=modal.App(APP_NAME); image=modal.Image.from_dockerfile(WORKER_ROOT/"Dockerfile",context_dir=REPOSITORY_ROOT)
@app.function(image=image,gpu="L40S",secrets=[modal.Secret.from_name(RUNTIME_SECRET_NAME),modal.Secret.from_name(LICENSE_SECRET_NAME)],volumes={MODEL_MOUNT:modal.Volume.from_name(MODEL_VOLUME_NAME,create_if_missing=True),SMOKE_MOUNT:modal.Volume.from_name(SMOKE_VOLUME_NAME,create_if_missing=True)},env=worker_environment(online=True),timeout=7200)
def provision():
 subprocess.run(["/opt/lada-band-venv/bin/python","/app/bootstrap_assets.py"],check=True)
 subprocess.run(["/opt/lada-band-venv/bin/python","/app/smoke.py"],check=True)