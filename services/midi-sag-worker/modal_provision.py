"""Explicit, operator-triggered bootstrap/smoke operations; never serving startup."""
from __future__ import annotations
import os, subprocess, sys
from pathlib import Path
ROOT = Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import modal
from modal_config import APP_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME, REPOSITORY_ROOT, RUNTIME_SECRET_NAME, SMOKE_MOUNT, SMOKE_VOLUME_NAME, WORKER_ROOT, worker_environment
app = modal.App(f"{APP_NAME}-provision")
image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)
smoke = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=True)
secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
@app.function(image=image, gpu="L40S", secrets=[secret], volumes={MODEL_MOUNT: models, SMOKE_MOUNT: smoke}, timeout=86400)
def provision_assets() -> None:
    try: subprocess.run(["/opt/midi-sag-venv/bin/python", "bootstrap_assets.py"], cwd="/app", env={**os.environ, **worker_environment(online=True)}, check=True, timeout=86000)
    finally: models.commit()
@app.function(image=image, gpu="L40S", secrets=[secret], volumes={MODEL_MOUNT: models, SMOKE_MOUNT: smoke}, timeout=1800)
def smoke_remote(fixture_name: str) -> None:
    fixture = Path(SMOKE_MOUNT) / Path(fixture_name).name
    if not fixture.is_file(): raise RuntimeError("real smoke vocal fixture is missing")
    try: subprocess.run(["/opt/midi-sag-venv/bin/python", "smoke.py"], cwd="/app", env={**os.environ, **worker_environment(), "MIDI_SAG_SMOKE_AUDIO": str(fixture)}, check=True, timeout=1700)
    finally: models.commit()