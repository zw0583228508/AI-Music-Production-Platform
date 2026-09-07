"""Modal-isolated Stable Audio 3 provisioning and serving deployment."""
from __future__ import annotations
import os, subprocess, sys, time, socket, json
from pathlib import Path
import modal

APP_NAME="stable-audio3-worker"; MODEL_MOUNT="/var/lib/stable-audio3/models"; ARTIFACT_MOUNT="/var/lib/stable-audio3/artifacts"
ROOT=Path(__file__).parent
app=modal.App(APP_NAME)
# Modal's webhook bootstrap uses its managed interpreter rather than the
# pinned inference venv. Keep that bootstrap deliberately small; generation
# remains in /opt/stable-audio3-venv.
image=modal.Image.from_dockerfile(
 ROOT/"Dockerfile",context_dir=ROOT.parent.parent,add_python="3.10",
).pip_install("fastapi==0.115.12","pydantic==2.10.6","soundfile==0.13.1")
models=modal.Volume.from_name("stable-audio3-models-private-v2",create_if_missing=True)
artifacts=modal.Volume.from_name("stable-audio3-artifacts-private-v1",create_if_missing=True)
secret=modal.Secret.from_name("stable-audio3-runtime-v1")
def environment():
 return {**os.environ,"STABLE_AUDIO3_ASSET_ROOT":MODEL_MOUNT,"STABLE_AUDIO3_ARTIFACT_ROOT":ARTIFACT_MOUNT,"STABLE_AUDIO3_SOURCE_ROOT":"/opt/stable-audio-3-source"}
@app.function(image=image,gpu="L40S",secrets=[secret],volumes={MODEL_MOUNT:models},timeout=86400)
def provision_assets():
 subprocess.run(["/opt/stable-audio3-venv/bin/python","bootstrap_assets.py"],cwd="/app",env=environment(),check=True); models.commit()
@app.function(image=image,gpu="L40S",secrets=[secret],volumes={MODEL_MOUNT:models},timeout=14400,block_network=True)
def run_smoke():
 completed=subprocess.run(["/opt/stable-audio3-venv/bin/python","smoke.py"],cwd="/app",env=environment(),capture_output=True,text=True)
 if completed.returncode: raise RuntimeError(completed.stderr[-4000:] or completed.stdout[-4000:])
 models.commit()
 return json.loads((Path(MODEL_MOUNT)/"smoke-proof.json").read_text())
@app.cls(image=image,gpu="L40S",secrets=[secret],volumes={MODEL_MOUNT:models,ARTIFACT_MOUNT:artifacts},timeout=1800,max_containers=1,block_network=True)
class StableAudio3Worker:
 @modal.asgi_app(label="stable-audio3")
 def endpoint(self):
  import app as worker
  os.environ.update(environment())
  return worker.app