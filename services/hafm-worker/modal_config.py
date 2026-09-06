from __future__ import annotations
import os
from pathlib import Path
APP_NAME="hafm-worker";RUNTIME_SECRET_NAME="music-ai-worker-runtime";MODEL_VOLUME_NAME="hafm-models-private-v1";SMOKE_VOLUME_NAME="hafm-smoke-private-v1";OUTPUT_VOLUME_NAME="hafm-artifacts-private-v1"
MODEL_MOUNT="/var/lib/hafm/models";SMOKE_MOUNT="/var/lib/hafm/smoke";OUTPUT_MOUNT="/var/lib/hafm/artifacts";WORKER_ROOT=Path(__file__).resolve().parent
REPOSITORY_ROOT=next((p for p in (WORKER_ROOT,*WORKER_ROOT.parents) if (p/"pnpm-workspace.yaml").is_file()),WORKER_ROOT)
def worker_environment(*,online=False): return {"HAFM_ASSET_ROOT":MODEL_MOUNT,"HAFM_SMOKE_ROOT":SMOKE_MOUNT,"HAFM_ARTIFACT_ROOT":OUTPUT_MOUNT,"HF_HOME":f"{MODEL_MOUNT}/hf-cache","HF_HUB_OFFLINE":"0" if online else "1","TRANSFORMERS_OFFLINE":"0" if online else "1","PATH":"/opt/hafm-venv/bin:"+os.environ.get("PATH","")}