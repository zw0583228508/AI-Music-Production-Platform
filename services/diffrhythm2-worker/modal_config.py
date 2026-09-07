import hashlib
from pathlib import Path
ROOT=Path(__file__).parent
REPOSITORY_ROOT=ROOT.parents[1] if len(ROOT.parents) > 1 else ROOT
WORKER_ROOT=ROOT
APP_NAME="diffrhythm2-worker"; MODEL_VOLUME_NAME="diffrhythm2-private-models-v1"; SMOKE_VOLUME_NAME="diffrhythm2-private-smoke-v1"
ARTIFACT_VOLUME_NAME="diffrhythm2-private-artifacts-v1"
MODEL_MOUNT="/var/lib/diffrhythm2/models"; SMOKE_MOUNT="/var/lib/diffrhythm2/smoke"
ARTIFACT_MOUNT="/var/lib/diffrhythm2/artifacts"
RUNTIME_SECRET_NAME="music-ai-worker-runtime"
PROMOTION_SECRET_NAME="diffrhythm2-promotion-identity-v1"
DEPLOYMENT_BASE_IMAGE_ID="im-XrLfUWkLKEWfFibBBtsWJ1"
SOURCE_FILES=("Dockerfile","requirements.txt","model_manifest.json","app.py","contract.py","inference.py",
              "upstream_runner.py","modal_app.py","modal_config.py",
              "codec_threshold_corpus.py")
def source_image_digest():
 digest=hashlib.sha256()
 for name in SOURCE_FILES:
  data=(ROOT/name).read_bytes()
  digest.update(name.encode()+b"\0"+data+b"\0")
 return "sha256:"+digest.hexdigest()
def environment(online:bool=False):
 return {"DIFFRHYTHM2_ASSET_ROOT":MODEL_MOUNT,"DIFFRHYTHM2_ARTIFACT_ROOT":ARTIFACT_MOUNT,
         "HF_HUB_OFFLINE":"0" if online else "1","TRANSFORMERS_OFFLINE":"0" if online else "1",
         "MUSIC_GPU_CONTAINER_DIGEST":source_image_digest()}
