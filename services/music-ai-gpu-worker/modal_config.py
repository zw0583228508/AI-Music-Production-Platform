"""Credential-free deployment definitions for the Modal music workers.

This module deliberately has no Modal import so CI can validate the deployment
shape without a Modal account, token, or GPU.  `modal_app.py` turns these
definitions into Modal classes.
"""
from __future__ import annotations

import json
import hashlib
import os
from urllib.parse import urlsplit
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
SMOKE_FIXTURE = f"{MODEL_MOUNT}/_smoke/non-silent-440hz-1s.wav"


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
    cuda_image: str
    cuda_runtime: str
    pytorch: str
    torchvision: str
    torchaudio: str
    torch_index_url: str
    transformers: str
    accelerate: str

    @property
    def enabled_providers(self) -> str:
        return self.provider


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    """Load and minimally validate the checked-in, weight-free model manifest."""
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("checkpoint_root") != MODEL_MOUNT:
        raise ValueError("Modal model mount must match model_manifest checkpoint_root")
    runtime = manifest.get("runtime", {})
    required_runtime = {
        "python", "cuda_image", "cuda", "pytorch", "torchvision", "torchaudio",
        "torch_index_url", "transformers", "accelerate",
    }
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
        ROOT / "modal_app.py", ROOT / "checkpoint_bootstrap.py",
        ROOT / "model_manifest.json", ROOT / "runners" / requirements_file,
        ROOT / "runners" / f"{provider.lower()}.py", ROOT / "runners" / "common.py",
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
        **{
            "cuda_image": {**MANIFEST["runtime"], **details.get("runtime", {})}["cuda_image"],
            "cuda_runtime": {**MANIFEST["runtime"], **details.get("runtime", {})}["cuda"],
            "pytorch": {**MANIFEST["runtime"], **details.get("runtime", {})}["pytorch"],
            "torchvision": {**MANIFEST["runtime"], **details.get("runtime", {})}["torchvision"],
            "torchaudio": {**MANIFEST["runtime"], **details.get("runtime", {})}["torchaudio"],
            "torch_index_url": {**MANIFEST["runtime"], **details.get("runtime", {})}["torch_index_url"],
            "transformers": {**MANIFEST["runtime"], **details.get("runtime", {})}["transformers"],
            "accelerate": {**MANIFEST["runtime"], **details.get("runtime", {})}["accelerate"],
        },
    )
    for provider, details in MANIFEST["providers"].items()
    if provider in _CAPACITY
}


def selected_deployments(value: str | None = None) -> dict[str, ProviderDeployment]:
    """Validate an explicit Modal deployment allowlist; default to verified ACE."""
    raw = os.getenv("MUSIC_GPU_MODAL_DEPLOY_PROVIDERS") if value is None else value
    raw = "ACE_STEP" if raw is None else raw
    selected = {item.strip().upper() for item in raw.split(",") if item.strip()}
    if not selected:
        raise ValueError("MUSIC_GPU_MODAL_DEPLOY_PROVIDERS must not be empty")
    unknown = selected - set(DEPLOYMENTS)
    if unknown:
        raise ValueError("unknown Modal deploy providers: " + ", ".join(sorted(unknown)))
    return {provider: DEPLOYMENTS[provider] for provider in DEPLOYMENTS if provider in selected}


def worker_environment(deployment: ProviderDeployment) -> dict[str, str]:
    """Return runtime identity and non-secret environment for one provider."""
    module = deployment.provider.lower()
    command = f"python -m runners.{module}"
    environment = {
        "MUSIC_GPU_CHECKPOINT_ROOT": MODEL_MOUNT,
        "MUSIC_GPU_JOB_DB": f"{JOB_MOUNT}/{deployment.provider.lower()}.sqlite3",
        # Runner common.py reads this exact variable. It owns per-job
        # subdirectories below the provider directory.
        "MUSIC_GPU_JOB_OUTPUT_ROOT": OUTPUT_MOUNT,
        "MUSIC_GPU_ENABLED_PROVIDERS": deployment.enabled_providers,
        "MUSIC_GPU_CUDA_VERSION": deployment.cuda_runtime,
        "MUSIC_GPU_CONTAINER_DIGEST": deployment.source_image_digest,
        "MUSIC_GPU_MODAL_JOB_VOLUME_NAME": JOB_VOLUME_NAME,
        "MUSIC_GPU_MODAL_OUTPUT_VOLUME_NAME": OUTPUT_VOLUME_NAME,
        "MUSIC_GPU_MAX_CONCURRENT_JOBS": "1",
        "MUSIC_GPU_JOB_TIMEOUT_SECONDS": str(deployment.timeout_seconds),
        "MUSIC_GPU_HEALTH_TIMEOUT_SECONDS": "180",
        "MUSIC_GPU_SMOKE_INPUT_PATH": SMOKE_FIXTURE,
        f"MUSIC_GPU_RUNNER_{deployment.provider}": command,
        f"MUSIC_GPU_SMOKE_{deployment.provider}": command,
        "PYTHONUNBUFFERED": "1",
    }
    public_origin = os.getenv(
        f"MUSIC_GPU_PUBLIC_ORIGIN_{deployment.provider}", ""
    ).strip()
    if public_origin:
        parsed = urlsplit(public_origin)
        if (
            parsed.scheme != "https" or not parsed.hostname
            or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
        ):
            raise ValueError(
                f"MUSIC_GPU_PUBLIC_ORIGIN_{deployment.provider} must be an HTTPS origin"
            )
        environment["MUSIC_GPU_PUBLIC_ORIGIN"] = (
            f"https://{parsed.hostname.lower()}"
            + (f":{parsed.port}" if parsed.port and parsed.port != 443 else "")
        )
    return environment


def provider_image_build_args(deployment: ProviderDeployment) -> dict[str, str]:
    """Return only dependency inputs that are allowed to affect image layers.

    The source-build digest is deliberately absent. It changes whenever worker
    application code changes and is injected through ``worker_environment`` at
    runtime instead, so unchanged dependency layers remain cacheable.
    """
    return {
        "PROVIDER_REQUIREMENTS": deployment.requirements_file,
        "CUDA_IMAGE": deployment.cuda_image,
        "CUDA_RUNTIME": deployment.cuda_runtime,
        "PYTORCH_SPEC": f"torch=={deployment.pytorch}",
        "TORCHVISION_SPEC": f"torchvision=={deployment.torchvision}",
        "TORCHAUDIO_SPEC": f"torchaudio=={deployment.torchaudio}",
        "TORCH_INDEX_URL": deployment.torch_index_url,
        "TRANSFORMERS_SPEC": f"transformers=={deployment.transformers}",
        "ACCELERATE_SPEC": f"accelerate=={deployment.accelerate}",
    }