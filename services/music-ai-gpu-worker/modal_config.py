"""Credential-free deployment definitions for the Modal music workers.

This module deliberately has no Modal import so CI can validate the deployment
shape without a Modal account, token, or GPU.  `modal_app.py` turns these
definitions into Modal classes.
"""
from __future__ import annotations

import json
import hashlib
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
    requirements_file: str
    source_image_digest: str

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


def provider_source_image_digest(provider: str, requirements_file: str) -> str:
    """Hash immutable, reviewed provider-image inputs (not an OCI layer digest)."""
    paths = [
        ROOT / "Dockerfile", ROOT / "app.py", ROOT / "modal_config.py",
        ROOT / "model_manifest.json", ROOT / "runners" / requirements_file,
        ROOT / "runners" / f"{provider.lower()}.py", ROOT / "runners" / "common.py",
        ROOT / "runners" / "_common.py",
    ]
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(ROOT).as_posix().encode() + b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()

# SQLite recovery and the in-process task registry are intentionally
# single-container only. Scaling these HTTP workers horizontally would allow two
# process-local schedulers to resume the same durable queue.
_CAPACITY = {
    # L4 and L40S are supported Modal GPU SKU strings.  ACE-Step's larger
    # generation footprint receives L40S; bounded analysis/separation uses L4.
    "BS_ROFORMER": ("L4", 1, 1_800, 300, "requirements-bs-roformer.txt"),
    "ACE_STEP": ("L40S", 1, 1_800, 300, "requirements-ace-step.txt"),
    "MT3": ("L4", 1, 1_200, 180, "requirements-mt3.txt"),
    "ALL_IN_ONE": ("L4", 1, 1_200, 180, "requirements-all-in-one.txt"),
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
        requirements_file=_CAPACITY[provider][4],
        source_image_digest=provider_source_image_digest(provider, _CAPACITY[provider][4]),
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
        # Runner common.py reads this exact variable. It owns per-job
        # subdirectories below the provider directory.
        "MUSIC_GPU_JOB_OUTPUT_ROOT": OUTPUT_MOUNT,
        "MUSIC_GPU_ENABLED_PROVIDERS": deployment.enabled_providers,
        "MUSIC_GPU_CUDA_VERSION": runtime["cuda"],
        "MUSIC_GPU_CONTAINER_DIGEST": deployment.source_image_digest,
        "MUSIC_GPU_MODAL_JOB_VOLUME_NAME": JOB_VOLUME_NAME,
        "MUSIC_GPU_MODAL_OUTPUT_VOLUME_NAME": OUTPUT_VOLUME_NAME,
        "MUSIC_GPU_MAX_CONCURRENT_JOBS": "1",
        "MUSIC_GPU_JOB_TIMEOUT_SECONDS": str(deployment.timeout_seconds),
        "MUSIC_GPU_HEALTH_TIMEOUT_SECONDS": "180",
        "PYTHONUNBUFFERED": "1",
    }