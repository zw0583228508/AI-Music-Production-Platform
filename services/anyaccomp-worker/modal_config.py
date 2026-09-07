"""No credentials are embedded in AnyAccomp deployment configuration."""
from pathlib import Path
APP_NAME = "anyaccomp-worker"
ENDPOINT_LABEL = "anyaccomp-rename-drill"
MODEL_VOLUME_NAME = "anyaccomp-models-private-v1"
ARTIFACT_VOLUME_NAME = "anyaccomp-artifacts-private-v1"
MODEL_MOUNT = "/var/lib/anyaccomp/models"
ARTIFACT_MOUNT = "/var/lib/anyaccomp/artifacts"
RUNTIME_SECRET_NAME = "anyaccomp-runtime-v1"
PROMOTION_SECRET_NAME = "anyaccomp-promotion-identity-v1"
WORKER_ROOT = Path(__file__).resolve().parent