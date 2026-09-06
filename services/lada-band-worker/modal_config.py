"""Isolated, offline serving configuration for LaDA-Band."""
from __future__ import annotations
import os
from pathlib import Path
APP_NAME="lada-band-worker"; RUNTIME_SECRET_NAME="music-ai-worker-runtime"; LICENSE_SECRET_NAME="lada-band-noncommercial-research-v1"
MODEL_VOLUME_NAME="lada-band-models-private-v1"; SMOKE_VOLUME_NAME="lada-band-smoke-private-v1"; OUTPUT_VOLUME_NAME="lada-band-artifacts-private-v1"
MODEL_MOUNT="/var/lib/lada-band/models"; SMOKE_MOUNT="/var/lib/lada-band/smoke"; OUTPUT_MOUNT="/var/lib/lada-band/artifacts"
WORKER_ROOT=Path(__file__).resolve().parent
REPOSITORY_ROOT=next((p for p in (WORKER_ROOT,*WORKER_ROOT.parents) if (p/"pnpm-workspace.yaml").is_file()),WORKER_ROOT)
def worker_environment(*, online=False):
    return {"LADA_BAND_ASSET_ROOT":MODEL_MOUNT,"LADA_BAND_SMOKE_ROOT":SMOKE_MOUNT,"LADA_BAND_ARTIFACT_ROOT":OUTPUT_MOUNT,
            "HF_HOME":f"{MODEL_MOUNT}/hf-cache","HF_HUB_OFFLINE":"0" if online else "1","TRANSFORMERS_OFFLINE":"0" if online else "1",
            "PYTHONUNBUFFERED":"1","PATH":"/opt/lada-band-venv/bin:"+os.environ.get("PATH","")}