"""Credential-free deployment definitions for the Modal music workers.

This module deliberately has no Modal import so CI can validate the deployment
shape without a Modal account, token, or GPU.  `modal_app.py` turns these
definitions into Modal classes.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = ROOT / "model_manifest.json"
MODEL_MOUNT = "/var/lib/music-ai-gpu/models"
JOB_MOUNT = "/var/lib/music-ai-gpu/jobs"
OUTPUT_MOUNT = "/var/lib/music-ai-gpu/outputs"
RUNTIME_SECRET_NAME = "music-ai-worker-runtime"
MODEL_VOLUME_NAME = "music-ai-models-v1"
JOB_VOLUME_NAME = "music-ai-jobs-v1"
OUTPUT_VOLUME_NAME = "music-ai-outputs-v1"


@dataclass(frozen=True)
class ProviderDeployment:
    provider: str
    endpoint_label: str
    gpu: str
    max_containers: int
    timeout_seconds: int
    idle_timeout_seconds: int
    checkpoint_path: str
    model_version: str

    @property
    def enabled_providers(self) -> str:
        return self.provider


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    """Load and minimally validate the checked-in, weight-free model manifest."""
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("checkpoint_root") != MODEL_MOUNT:
        raise ValueError("Modal model mount must match model_manifest checkpoint_root")
    runtime = manifest.get("runtime", {})
    required_runtime = {"python", "cuda", "pytorch", "transformers", "accelerate"}
    if required_runtime - set(runtime):
        raise ValueError("model manifest has an incomplete pinned runtime")
    if not manifest.get("providers"):
        raise ValueError("model manifest contains no providers")
    return manifest


MANIFEST = load_manifest()

# These capacity limits are intentionally conservative. A provider gets one
# process per container because app.py owns a SQLite-backed async job queue and
# each process is limited to one GPU inference at a time.
_CAPACITY = {
    "BS_ROFORMER": ("A10G", 2, 1_800, 300),
    "ACE_STEP": ("L40S", 2, 1_800, 300),
    "MT3": ("A10G", 2, 1_200, 180),
    # Kept deployable for the existing worker contract, but not a task #46
    # priority provider. It remains unavailable without an attested runner.
    "MUSICGEN": ("L40S", 1, 1_800, 300),
}

DEPLOYMENTS = {
    provider: ProviderDeployment(
        provider=provider,
        endpoint_label=provider.lower().replace("_", "-"),
        gpu=_CAPACITY[provider][0],
        max_containers=_CAPACITY[provider][1],
        timeout_seconds=_CAPACITY[provider][2],
        idle_timeout_seconds=_CAPACITY[provider][3],
        checkpoint_path=details["checkpoint_path"],
        model_version=details["model_version"],
    )
    for provider, details in MANIFEST["providers"].items()
    if provider in _CAPACITY
}


def worker_environment(deployment: ProviderDeployment) -> dict[str, str]:
    """Return only non-secret environment values for one isolated provider."""
    runtime = MANIFEST["runtime"]
    return {
        "MUSIC_GPU_CHECKPOINT_ROOT": MODEL_MOUNT,
        "MUSIC_GPU_JOB_DB": f"{JOB_MOUNT}/{deployment.provider.lower()}.sqlite3",
        "MUSIC_GPU_OUTPUT_ROOT": f"{OUTPUT_MOUNT}/{deployment.provider.lower()}",
        "MUSIC_GPU_ENABLED_PROVIDERS": deployment.enabled_providers,
        "MUSIC_GPU_CUDA_VERSION": runtime["cuda"],
        "MUSIC_GPU_MAX_CONCURRENT_JOBS": "1",
        "MUSIC_GPU_JOB_TIMEOUT_SECONDS": str(deployment.timeout_seconds),
        "MUSIC_GPU_HEALTH_TIMEOUT_SECONDS": "180",
        "PYTHONUNBUFFERED": "1",
    }