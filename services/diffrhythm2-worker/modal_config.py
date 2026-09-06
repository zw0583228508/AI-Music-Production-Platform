from pathlib import Path
ROOT=Path(__file__).parent
REPOSITORY_ROOT=ROOT.parents[1] if len(ROOT.parents) > 1 else ROOT
WORKER_ROOT=ROOT
APP_NAME="diffrhythm2-worker"; MODEL_VOLUME_NAME="diffrhythm2-private-models-v1"; SMOKE_VOLUME_NAME="diffrhythm2-private-smoke-v1"
MODEL_MOUNT="/var/lib/diffrhythm2/models"; SMOKE_MOUNT="/var/lib/diffrhythm2/smoke"
RUNTIME_SECRET_NAME="music-ai-worker-runtime"
def environment(online:bool=False):
 return {"DIFFRHYTHM2_ASSET_ROOT":MODEL_MOUNT,"HF_HUB_OFFLINE":"0" if online else "1","TRANSFORMERS_OFFLINE":"0" if online else "1"}