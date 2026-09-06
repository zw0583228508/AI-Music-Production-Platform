from __future__ import annotations
import os,subprocess,sys
from pathlib import Path
ROOT=Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent;sys.path.insert(0,str(ROOT))
import modal
from modal_config import *
app=modal.App(APP_NAME);image=modal.Image.from_dockerfile(WORKER_ROOT/"Dockerfile",context_dir=REPOSITORY_ROOT)
@app.function(image=image,gpu="L40S",secrets=[modal.Secret.from_name(RUNTIME_SECRET_NAME)],volumes={MODEL_MOUNT:modal.Volume.from_name(MODEL_VOLUME_NAME,create_if_missing=True),SMOKE_MOUNT:modal.Volume.from_name(SMOKE_VOLUME_NAME,create_if_missing=True),OUTPUT_MOUNT:modal.Volume.from_name(OUTPUT_VOLUME_NAME,create_if_missing=True)},env=worker_environment(),timeout=1800,max_containers=1)
@modal.web_server(port=8018)
def endpoint():
 p=subprocess.Popen(["/opt/hafm-venv/bin/python","-m","uvicorn","app:app","--host","0.0.0.0","--port","8018"],cwd="/app",env={**os.environ,**worker_environment()})
 try:
  if p.wait():raise RuntimeError("HAFM workload exited unexpectedly")
 finally:
  if p.poll() is None:p.terminate()