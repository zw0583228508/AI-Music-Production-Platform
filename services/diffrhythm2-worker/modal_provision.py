"""Explicit operator-invoked provisioning only; endpoint startup never downloads."""
from __future__ import annotations
import modal
from modal_config import APP_NAME,MODEL_MOUNT,MODEL_VOLUME_NAME,REPOSITORY_ROOT,RUNTIME_SECRET_NAME,SMOKE_MOUNT,SMOKE_VOLUME_NAME,WORKER_ROOT,environment
app=modal.App(f"{APP_NAME}-provision"); image=modal.Image.from_dockerfile(WORKER_ROOT/"Dockerfile",context_dir=REPOSITORY_ROOT)
models=modal.Volume.from_name(MODEL_VOLUME_NAME,create_if_missing=True); smoke=modal.Volume.from_name(SMOKE_VOLUME_NAME,create_if_missing=True)
secret=modal.Secret.from_name(RUNTIME_SECRET_NAME)
@app.function(image=image,gpu="L40S",secrets=[secret],volumes={MODEL_MOUNT:models,SMOKE_MOUNT:smoke},timeout=86400)
def provision_assets():
 import subprocess,os
 try: subprocess.run(["/opt/diffrhythm2-venv/bin/python","bootstrap_assets.py"],cwd="/app",env={**os.environ,**environment(True)},check=True)
 finally: models.commit()