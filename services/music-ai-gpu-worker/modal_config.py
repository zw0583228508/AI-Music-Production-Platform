"""Credential-free deployment definitions for the Modal music workers.

This module deliberately has no Modal import so CI can validate the deployment
shape without a Modal account, token, or GPU.  `modal_app.py` turns these
definitions into Modal classes.
"""
from __future__ import annotations

import base64
import json
import hashlib
import os
import re
import subprocess
import tempfile
from urllib.parse import urlsplit
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = Path(os.getenv("MUSIC_GPU_SOURCE_ROOT", ROOT))
MANIFEST_PATH = ROOT / "model_manifest.json"
MODEL_MOUNT = "/var/lib/music-ai-gpu/models"
JOB_MOUNT = "/var/lib/music-ai-gpu/jobs"
OUTPUT_MOUNT = "/var/lib/music-ai-gpu/outputs"
RUNTIME_SECRET_NAME = "music-ai-worker-runtime"
PROMOTION_SECRET_PREFIX = "music-ai-gpu-promotion"
PROMOTION_SCHEMA_VERSION = 1
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
    source_revision: str
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

def _canonical_json(value: object) -> str:
    """Serialize promotion records identically in CI and the API verifier."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
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
        SOURCE_ROOT / f"Dockerfile.{provider.lower().replace('_', '-')}",
        SOURCE_ROOT / "app.py", SOURCE_ROOT / "modal_config.py",
        SOURCE_ROOT / "modal_app.py", SOURCE_ROOT / "checkpoint_bootstrap.py",
        SOURCE_ROOT / "model_manifest.json",
        SOURCE_ROOT / "runners" / requirements_file,
        SOURCE_ROOT / "runners" / "__init__.py",
        SOURCE_ROOT / "runners" / f"{provider.lower()}.py",
        SOURCE_ROOT / "runners" / "common.py",
    ]
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(SOURCE_ROOT).as_posix().encode() + b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()

def promotion_secret_name(provider: str) -> str:
    if provider not in DEPLOYMENTS:
        raise ValueError(f"unknown Modal promotion provider: {provider}")
    return f"{PROMOTION_SECRET_PREFIX}-{provider.lower().replace('_', '-')}-v1"

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
    source_revision = os.getenv("MUSIC_GPU_SOURCE_REVISION", "").strip()
    if source_revision:
        environment["MUSIC_GPU_SOURCE_REVISION"] = source_revision
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

def _https_origin(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError as exc:
        raise ValueError("promotion endpoint origin is invalid") from exc
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("promotion endpoint origin must be an HTTPS origin")
    return (
        f"https://{parsed.hostname.lower()}"
        + (f":{port}" if port and port != 443 else "")
    )

def sign_promotion_record(record: dict, private_key_path: Path) -> str:
    if not private_key_path.is_file():
        raise ValueError("promotion private key file does not exist")
    with tempfile.NamedTemporaryFile() as canonical:
        canonical.write(canonical_promotion_record(record).encode("utf-8"))
        canonical.flush()
        result = subprocess.run(
            [
                "openssl", "pkeyutl", "-sign", "-rawin",
                "-inkey", str(private_key_path), "-in", canonical.name,
            ],
            capture_output=True,
            check=False,
        )
    if result.returncode != 0 or len(result.stdout) != 64:
        raise RuntimeError("Ed25519 promotion signing failed")
    return base64.b64encode(result.stdout).decode("ascii")

def write_promotion_bundle(
    path: Path,
    record: dict,
    private_key_path: Path,
) -> dict:
    """Atomically replace the signed promotion bundle used by deployment CI."""
    signature = sign_promotion_record(record, private_key_path)
    bundle = {"record": record, "signature": signature}
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    encoded = (_canonical_json(bundle) + "\n").encode("utf-8")
    try:
        with temporary.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        return bundle
    finally:
        temporary.unlink(missing_ok=True)

def write_worker_identity(path: Path, record: dict) -> dict[str, str]:
    """Atomically write CI-observed IDs for the provider-only Modal Secret."""
    identity = {
        "MUSIC_GPU_MODAL_APP_ID": str(record["modalAppId"]),
        "MUSIC_GPU_MODAL_DEPLOYMENT_ID": str(record["modalDeploymentId"]),
        "MUSIC_GPU_MODAL_FUNCTION_ID": str(record["modalFunctionId"]),
    }
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    encoded = (_canonical_json(identity) + "\n").encode("utf-8")
    try:
        with temporary.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        return identity
    finally:
        temporary.unlink(missing_ok=True)

def build_promotion_record(
    deployment: ProviderDeployment,
    *,
    modal_app_id: str,
    modal_deployment_id: str,
    modal_function_id: str,
    modal_image_id: str,
    endpoint_origin: str,
    checkpoint_sha256: str,
    source_revision: str,
) -> dict:
    """Build the complete immutable identity recorded by deployment CI."""
    identifiers = {
        "modalAppId": modal_app_id,
        "modalDeploymentId": modal_deployment_id,
        "modalFunctionId": modal_function_id,
        "modalImageId": modal_image_id,
    }
    if any(
        not isinstance(value, str) or not value.strip()
        for value in identifiers.values()
    ):
        raise ValueError("Modal promotion IDs must not be empty")
    if not modal_image_id.startswith("im-"):
        raise ValueError("Modal promotion image ID must start with im-")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", checkpoint_sha256):
        raise ValueError("promotion checkpoint SHA-256 must be 64 hexadecimal characters")
    if not source_revision.strip():
        raise ValueError("promotion source revision must not be empty")
    if not deployment.source_revision:
        raise ValueError("promotion checkpoint revision must not be empty")
    runtime = {
        "python": MANIFEST["runtime"]["python"],
        "cudaImage": deployment.cuda_image,
        "cuda": deployment.cuda_runtime,
        "pytorch": deployment.pytorch,
        "torchvision": deployment.torchvision,
        "torchaudio": deployment.torchaudio,
        "torchIndexUrl": deployment.torch_index_url,
        "transformers": deployment.transformers,
        "accelerate": deployment.accelerate,
    }
    return {
        "schemaVersion": PROMOTION_SCHEMA_VERSION,
        "provider": deployment.provider,
        **identifiers,
        "endpointOrigin": _https_origin(endpoint_origin),
        "modelVersion": deployment.model_version,
        "checkpointSha256": checkpoint_sha256.lower(),
        "checkpointRevision": deployment.source_revision,
        "sourceRevision": source_revision.strip(),
        "sourceImageDigest": deployment.source_image_digest,
        "runtime": runtime,
    }

def canonical_promotion_record(record: dict) -> str:
    return _canonical_json(record)
