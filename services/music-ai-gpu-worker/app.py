"""Fail-closed asynchronous worker for pinned GPU music models.

The worker deliberately contains no CPU or synthetic fallback. A deployment
supplies provider-specific model runners and checkpoints in durable storage.
The runner protocol is documented in README.md; this service owns readiness,
idempotency, persistence, cancellation, and provenance fencing around it.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field
from runners.common import validate_mt3_note_output

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())
PROVIDERS = MANIFEST["providers"]
CHECKPOINT_ROOT = Path(
    os.getenv("MUSIC_GPU_CHECKPOINT_ROOT", MANIFEST["checkpoint_root"])
)
JOB_DB = Path(os.getenv("MUSIC_GPU_JOB_DB", str(CHECKPOINT_ROOT / "jobs.sqlite3")))
JOB_DB.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
MAX_REQUEST_BYTES = int(os.getenv("MUSIC_GPU_MAX_REQUEST_BYTES", 8 * 1024 * 1024))
MAX_CONCURRENT_JOBS = max(1, int(os.getenv("MUSIC_GPU_MAX_CONCURRENT_JOBS", "1")))
JOB_TIMEOUT_SECONDS = max(30, int(os.getenv("MUSIC_GPU_JOB_TIMEOUT_SECONDS", "1800")))
HEALTH_TIMEOUT_SECONDS = max(5, int(os.getenv("MUSIC_GPU_HEALTH_TIMEOUT_SECONDS", "180")))
OUTPUT_ROOT = Path(os.getenv(
    "MUSIC_GPU_JOB_OUTPUT_ROOT", str(CHECKPOINT_ROOT / "job-outputs")
))
ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024
ARTIFACT_TTL_SECONDS = max(
    60, min(24 * 60 * 60, int(os.getenv("MUSIC_GPU_ARTIFACT_TTL_SECONDS", "3600")))
)
SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
ENABLED = {
    value.strip()
    for value in os.getenv("MUSIC_GPU_ENABLED_PROVIDERS", "").split(",")
    if value.strip()
}
TASKS: dict[str, asyncio.Task[None]] = {}
PROCESSES: dict[str, asyncio.subprocess.Process] = {}
SMOKE_ATTESTATIONS: dict[str, str] = {}
SMOKE_EVIDENCE: dict[str, dict[str, Any]] = {}
SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
STARTUP_RETRY_SECONDS = 5
COLD_START_PROVIDERS = {"ACE_STEP", "BS_ROFORMER", "MT3", "ALL_IN_ONE"}


class RuntimeInitializing(RuntimeError):
    """A CUDA probe has not finished initializing the process runtime."""


def _cuda_initialization_incomplete(exc: RuntimeError) -> bool:
    message = re.sub(r"\s+", " ", str(exc)).strip().lower()
    return message in {
        "cuda error: initialization error",
        "cuda initialization error",
        "cuda runtime initialization is incomplete",
        "cuda runtime is not yet initialized",
    }


def _cuda_probe_failure(exc: RuntimeError) -> tuple[bool, str]:
    if _cuda_initialization_incomplete(exc):
        raise RuntimeInitializing("CUDA runtime initialization is incomplete") from exc
    return False, "CUDA readiness probe failed"


def _auth(request: Request) -> None:
    token = os.getenv("MUSIC_AI_WORKER_TOKEN")
    if not token:
        raise HTTPException(503, "worker authentication is not configured")
    if request.headers.get("Authorization") != f"Bearer {token}":
        raise HTTPException(401, "invalid bearer token")


def _db() -> sqlite3.Connection:
    connection = sqlite3.connect(JOB_DB, timeout=30, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=30000")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          provider TEXT NOT NULL,
          status TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0,
          stage TEXT NOT NULL DEFAULT 'queued',
          request_json TEXT NOT NULL,
          result_json TEXT,
          error TEXT,
          error_code TEXT,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        )
        """
    )
    return connection


def _durable_commit(kind: str) -> None:
    """Flush a mounted Modal Volume; local/OCI execution deliberately no-ops."""
    volume_name = os.getenv(f"MUSIC_GPU_MODAL_{kind.upper()}_VOLUME_NAME", "").strip()
    if not volume_name:
        return
    if kind == "job" and JOB_DB.exists():
        connection = sqlite3.connect(JOB_DB, timeout=30)
        try:
            connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
        finally:
            connection.close()
    try:
        import modal
        modal.Volume.from_name(volume_name, create_if_missing=False).commit()
    except Exception as exc:
        raise RuntimeError(f"durable {kind} volume commit failed: {type(exc).__name__}") from exc


def _row(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result.pop("request_json")
    if result.get("result_json"):
        result["result"] = json.loads(result.pop("result_json"))
    else:
        result.pop("result_json", None)
    result["cancelUrl"] = f"/jobs/{result['id']}"
    result["statusUrl"] = f"/jobs/{result['id']}"
    result["requestId"] = result["id"]
    return result


def _checkpoint_digest(path: Path) -> str | None:
    if path.is_file():
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    if not path.is_dir():
        return None
    digest = hashlib.sha256()
    files = sorted(child for child in path.rglob("*") if child.is_file())
    for child in files:
        digest.update(child.relative_to(path).as_posix().encode())
        with child.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest() if files else None


def _installed_version(distribution: str) -> str | None:
    try:
        from importlib.metadata import version
        return version(distribution)
    except Exception:
        return None


def _expected_runtime(details: dict[str, Any]) -> dict[str, str]:
    return {**MANIFEST["runtime"], **details.get("runtime", {})}


def _provider_license_block_reason(
    provider: str, details: dict[str, Any] | None = None
) -> str | None:
    provider_details = details or PROVIDERS.get(provider)
    if not provider_details:
        return None
    if (
        provider_details.get("routing_status") == "BLOCKED_LICENSE"
        or provider_details.get("commercial_use_permitted") is False
    ):
        return (
            "provider is blocked: checkpoint-owner redistribution and "
            "commercial-use rights are not verified"
        )
    return None


def _assert_provider_license_allows_execution(provider: str) -> None:
    reason = _provider_license_block_reason(provider)
    if reason:
        raise HTTPException(503, reason)


def _blocked_provider_health(
    provider: str, details: dict[str, Any], reason: str
) -> dict[str, Any]:
    version = str(details["model_version"])
    expected_runtime = _expected_runtime(details)
    revision = str(details.get("revision", ""))
    license_status = str(details.get("license_status", "UNVERIFIED"))
    config_required = bool(str(details.get("config_path", "")).strip())
    return {
        "status": "blocked",
        "ready": False,
        "retryable": False,
        "retryAfterSeconds": None,
        "healthy": False,
        "provider": provider,
        "runtimeReady": False,
        "gpuReady": False,
        "checkpointReady": False,
        "modelVersion": version,
        "version": version,
        "checksum": "",
        "checkpointSha256": "",
        "configReady": not config_required,
        "configSha256": "",
        "smokeTested": False,
        "smokeEvidence": None,
        "framework": expected_runtime,
        "expectedRuntime": expected_runtime,
        "revision": revision,
        "sourceImageDigest": "",
        "containerDigest": "",
        "modalImageId": "",
        "imageId": "",
        "modalAppId": "",
        "modalDeploymentId": "",
        "modalFunctionId": "",
        "cudaVersion": "",
        "pytorchVersion": "",
        "gpu": "",
        "sourceRevision": "",
        "licenseStatus": license_status,
        "commercialUsePermitted": False,
        "runtime": {
            "revision": revision,
            "sourceImageDigest": "",
            "containerDigest": "",
            "modalImageId": "",
            "imageId": "",
            "cudaVersion": "",
            "pytorchVersion": "",
            "gpu": "",
            "pythonVersion": ".".join(str(part) for part in sys.version_info[:3]),
        },
        "message": reason,
    }


def _gpu_runtime(details: dict[str, Any]) -> tuple[bool, str]:
    expected_runtime = _expected_runtime(details)
    expected_python = expected_runtime["python"]
    actual_python = ".".join(str(part) for part in sys.version_info[:3])
    if actual_python != expected_python:
        return False, f"Python version {actual_python} does not match {expected_python}"
    try:
        import torch
    except Exception:
        return False, "PyTorch is not installed"
    expected = expected_runtime["pytorch"]
    actual = getattr(torch, "__version__", "")
    if actual != expected:
        return False, f"PyTorch version {actual or 'unknown'} does not match {expected}"
    for distribution in ("torchvision", "torchaudio", "transformers", "accelerate"):
        expected_package = expected_runtime[distribution]
        actual_package = _installed_version(distribution)
        if actual_package != expected_package:
            return False, (
                f"{distribution} version {actual_package or 'missing'} "
                f"does not match {expected_package}"
            )
    expected_cuda = expected_runtime["cuda"]
    image_cuda = os.getenv("MUSIC_GPU_CUDA_VERSION")
    if image_cuda != expected_cuda:
        return False, f"CUDA image version {image_cuda or 'unknown'} does not match {expected_cuda}"
    wheel_cuda = ".".join(expected_cuda.split(".")[:2])
    if str(torch.version.cuda or "") != wheel_cuda:
        return False, (
            f"PyTorch CUDA {torch.version.cuda or 'unknown'} does not match {wheel_cuda}"
        )
    try:
        torch.cuda.init()
        cuda_available = torch.cuda.is_available()
    except RuntimeError as exc:
        return _cuda_probe_failure(exc)
    if not cuda_available:
        return False, "CUDA GPU is not available"
    try:
        torch.zeros(1, device="cuda").sum().item()
    except Exception as exc:
        if isinstance(exc, RuntimeError):
            return _cuda_probe_failure(exc)
        return False, f"CUDA smoke allocation failed: {type(exc).__name__}"
    return True, f"CUDA {torch.version.cuda or 'unknown'} GPU ready"


def _run_command(
    command: str,
    args: list[str],
    payload: dict[str, Any] | None,
    timeout: int,
    env_overrides: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    try:
        process = subprocess.run(
            [*shlex.split(command), *args],
            input=json.dumps(payload) if payload is not None else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={
                **os.environ,
                "CUDA_VISIBLE_DEVICES": os.getenv("CUDA_VISIBLE_DEVICES", "0"),
                "MODAL_IMAGE_ID": os.getenv("MODAL_IMAGE_ID", ""),
                **(env_overrides or {}),
            },
        )
        return process.returncode, process.stdout[-4 * 1024 * 1024:], process.stderr[-4096:]
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return 127, "", type(exc).__name__


def _provider_health(
    provider: str,
    run_smoke: bool = True,
    artifact_base_url: str | None = None,
    force_smoke: bool = False,
) -> dict[str, Any]:
    details = PROVIDERS.get(provider)
    if not details:
        raise HTTPException(404, "unknown provider")
    license_block_reason = _provider_license_block_reason(provider, details)
    if license_block_reason:
        return _blocked_provider_health(provider, details, license_block_reason)
    version = details["model_version"]
    checkpoint = CHECKPOINT_ROOT / details["checkpoint_path"]
    configured = provider in ENABLED if ENABLED else False
    expected_hash = (
        os.getenv(f"MUSIC_PROVIDER_{provider}_CHECKPOINT_SHA256", "").strip()
        or details.get("checkpoint_sha256")
    )
    actual_hash = _checkpoint_digest(checkpoint)
    config_path_value = str(details.get("config_path", "")).strip()
    config = CHECKPOINT_ROOT / config_path_value if config_path_value else None
    expected_config_hash = str(details.get("config_sha256", "") or "").strip()
    actual_config_hash = _checkpoint_digest(config) if config else ""
    config_ready = (
        not config_path_value
        or bool(
            expected_config_hash
            and actual_config_hash
            and actual_config_hash.lower() == expected_config_hash.lower()
        )
    )
    expected_runtime = _expected_runtime(details)
    runtime_initializing = False
    try:
        runtime_ready, runtime_message = _gpu_runtime(details)
    except RuntimeInitializing:
        runtime_ready = False
        runtime_initializing = True
        runtime_message = "CUDA runtime initialization is still in progress"
    except Exception:
        runtime_ready = False
        runtime_message = "GPU runtime readiness check failed"
    try:
        import torch
        pytorch_version = str(torch.__version__)
        cuda_version = str(torch.version.cuda or "")
        gpu_model = str(torch.cuda.get_device_name(0)) if torch.cuda.is_available() else ""
    except Exception:
        pytorch_version = cuda_version = gpu_model = ""
    revision = str(os.getenv(
        f"MUSIC_PROVIDER_{provider}_REVISION", details.get("revision", "")
    )).strip()
    container_digest = os.getenv("MUSIC_GPU_CONTAINER_DIGEST", "").strip()
    immutable_container = bool(re.fullmatch(r"sha256:[a-fA-F0-9]{64}", container_digest))
    modal_image_id = os.getenv("MODAL_IMAGE_ID", "").strip()
    immutable_modal_image = bool(re.fullmatch(r"im-[A-Za-z0-9]+", modal_image_id))
    modal_app_id = os.getenv("MUSIC_GPU_MODAL_APP_ID", "").strip()
    modal_deployment_id = os.getenv("MUSIC_GPU_MODAL_DEPLOYMENT_ID", "").strip()
    modal_function_id = os.getenv("MUSIC_GPU_MODAL_FUNCTION_ID", "").strip()
    source_revision = os.getenv("MUSIC_GPU_SOURCE_REVISION", "").strip()
    checksum_ready = bool(
        expected_hash
        and actual_hash
        and actual_hash.lower() == expected_hash.lower()
        and config_ready
    )
    runner = os.getenv(details["runner_env"], "").strip()
    smoke_command = os.getenv(details["smoke_env"], "").strip() or runner
    smoke_identity = (
        f"{actual_hash}:{actual_config_hash}"
        if config_path_value
        else actual_hash
    )
    smoke_tested = bool(
        smoke_identity
        and SMOKE_ATTESTATIONS.get(provider) == smoke_identity
    )
    smoke_evidence = (
        SMOKE_EVIDENCE.get(provider)
        if smoke_tested else None
    )
    smoke_message = (
        "Real GPU smoke inference verified"
        if smoke_tested
        else "Real smoke runner is not configured"
    )
    if (
        configured and runtime_ready and checksum_ready and smoke_command
        and run_smoke and (force_smoke or not smoke_tested)
    ):
        code, output, error = _run_command(
            smoke_command,
            ["--smoke", "--provider", provider, "--model-version", version,
             "--checkpoint", str(checkpoint)],
            None,
            HEALTH_TIMEOUT_SECONDS,
            {
                "MUSIC_GPU_ARTIFACT_BASE_URL": artifact_base_url or "",
                "MUSIC_GPU_ARTIFACT_CAPABILITY_EXPIRES": str(
                    int(time.time()) + ARTIFACT_TTL_SECONDS
                ),
            },
        )
        if code == 0:
            try:
                proof = json.loads(output.strip().splitlines()[-1])
                if not isinstance(proof, dict):
                    raise ValueError("smoke proof must be an object")
                if provider in {"MT3", "YOUR_MT3"}:
                    validate_mt3_note_output(proof.get("output"))
                proof_provenance = (
                    proof.get("provenance")
                    if isinstance(proof.get("provenance"), dict)
                    else proof
                )
                smoke_tested = (
                    proof.get("smokeTested") is True
                    and proof.get("provider") == provider
                    and proof.get("modelVersion") == version
                    and proof.get("checkpointSha256", "").lower() == actual_hash.lower()
                    and _provenance_matches(
                        proof_provenance, version, actual_hash, revision, container_digest,
                        modal_image_id, cuda_version, pytorch_version, gpu_model,
                    )
                    and bool(proof.get("output"))
                )
                if smoke_tested and smoke_identity:
                    SMOKE_ATTESTATIONS[provider] = smoke_identity
                    SMOKE_EVIDENCE[provider] = proof
                    smoke_evidence = proof
                smoke_message = "Real GPU smoke inference verified" if smoke_tested else "Smoke proof did not match the loaded model"
            except (json.JSONDecodeError, IndexError, ValueError):
                smoke_message = "Smoke runner did not return a valid proof"
        else:
            # stderr can contain local paths, framework internals, or very
            # large logs. It is intentionally not reflected through health.
            smoke_message = f"Smoke inference failed (runner exit {code})"
    reasons = []
    if not configured:
        reasons.append("provider is not enabled")
    if not runtime_ready:
        reasons.append(runtime_message)
    if not checkpoint.is_file() and not checkpoint.is_dir():
        reasons.append("checkpoint is missing from durable storage")
    elif not expected_hash:
        reasons.append("checkpoint SHA-256 is not pinned in the manifest")
    elif not checksum_ready:
        reasons.append("checkpoint SHA-256 does not match the manifest")
    if config_path_value and not config_ready:
        reasons.append("model config SHA-256 does not match the manifest")
    if not runner:
        reasons.append("model runner is not configured")
    if not immutable_container:
        reasons.append("source image digest is not configured")
    if not immutable_modal_image:
        reasons.append("Modal image identity is not available")
    if not modal_app_id or not modal_deployment_id or not modal_function_id:
        reasons.append("Modal app, deployment, or function identity is not available")
    if not source_revision:
        reasons.append("source revision is not configured")
    if not smoke_tested:
        reasons.append(smoke_message)
    ready = not reasons
    startup_prerequisites_ready = (
        provider in COLD_START_PROVIDERS
        and configured
        and checksum_ready
        and bool(runner)
        and immutable_container
        and immutable_modal_image
        and bool(modal_app_id and modal_deployment_id and modal_function_id)
        and bool(source_revision)
    )
    starting = runtime_initializing and startup_prerequisites_ready
    return {
        "status": "ready" if ready else ("starting" if starting else "not_ready"),
        "ready": ready,
        "retryable": starting,
        "retryAfterSeconds": STARTUP_RETRY_SECONDS if starting else None,
        "healthy": ready,
        "provider": provider,
        "runtimeReady": runtime_ready,
        "gpuReady": runtime_ready,
        "checkpointReady": checksum_ready,
        "modelVersion": version,
        "version": version,
        "checksum": actual_hash,
        "checkpointSha256": actual_hash,
        "configReady": config_ready,
        "configSha256": actual_config_hash,
        "smokeTested": smoke_tested,
        "smokeEvidence": smoke_evidence,
        "framework": expected_runtime,
        "expectedRuntime": expected_runtime,
        "revision": revision,
        "sourceImageDigest": container_digest,
        "containerDigest": container_digest,
        "modalImageId": modal_image_id,
        "imageId": modal_image_id,
        "modalAppId": modal_app_id,
        "modalDeploymentId": modal_deployment_id,
        "modalFunctionId": modal_function_id,
        "cudaVersion": cuda_version,
        "pytorchVersion": pytorch_version,
        "gpu": gpu_model,
        "sourceRevision": source_revision,
        "runtime": {
            "revision": revision,
            "sourceImageDigest": container_digest,
            "containerDigest": container_digest,
            "modalImageId": modal_image_id,
            "imageId": modal_image_id,
            "cudaVersion": cuda_version,
            "pytorchVersion": pytorch_version,
            "gpu": gpu_model,
            "pythonVersion": ".".join(str(part) for part in sys.version_info[:3]),
        },
        "message": "GPU checkpoint, runtime, checksum, and smoke test are verified"
        if ready else _bounded_health_message(reasons),
    }


def _bounded_health_message(reasons: list[str]) -> str:
    cleaned = [
        re.sub(r"[\x00-\x1f\x7f]+", " ", str(reason)).strip()[:240]
        for reason in reasons
    ]
    return "; ".join(item for item in cleaned if item)[:768]


def _provenance_matches(
    provenance: Any,
    model_version: str,
    checkpoint: str | None,
    revision: str,
    container_digest: str,
    modal_image_id: str,
    cuda_version: str,
    pytorch_version: str,
    gpu: str,
) -> bool:
    """Compare a runner/smoke runtime identity to the live loaded worker."""
    if not isinstance(provenance, dict) or not checkpoint:
        return False
    expected = {
        "modelVersion": model_version,
        "checkpointSha256": checkpoint.lower(),
        "revision": revision,
        "sourceImageDigest": container_digest,
        "modalImageId": modal_image_id,
        "cudaVersion": cuda_version,
        "pytorchVersion": pytorch_version,
        "gpu": gpu,
    }
    return all(
        isinstance(provenance.get(key), str)
        and hmac.compare_digest(provenance[key].lower(), value.lower())
        for key, value in expected.items()
    )


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    provider: str
    model_version: str | None = Field(default=None, alias="modelVersion")


def _validate_provider(
    provider: str, artifact_base_url: str | None = None
) -> dict[str, Any]:
    if provider not in PROVIDERS:
        raise HTTPException(404, "unknown provider")
    _assert_provider_license_allows_execution(provider)
    health = _provider_health(
        provider, run_smoke=True, artifact_base_url=artifact_base_url
    )
    if health["status"] != "ready":
        raise HTTPException(503, "provider is not ready: " + health["message"])
    return health


def _result_from_runner(provider: str, health: dict[str, Any], output: str) -> dict[str, Any]:
    try:
        lines = [line for line in output.splitlines() if line.strip()]
        result = json.loads(lines[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        raise RuntimeError("model runner returned invalid JSON") from exc
    if not isinstance(result, dict):
        raise RuntimeError("model runner result must be an object")
    provenance = result.get("provenance")
    if not _provenance_matches(
        provenance,
        health["modelVersion"],
        health["checkpointSha256"],
        health["revision"],
        health["containerDigest"],
        health["modalImageId"],
        health["cudaVersion"],
        health["pytorchVersion"],
        health["gpu"],
    ):
        raise RuntimeError("model runner provenance does not match live worker identity")
    candidates = result.get("candidates")
    if provider in {"ACE_STEP", "MUSICGEN"} and (
        not isinstance(candidates, list) or not candidates
    ):
        raise RuntimeError("generation runner returned no candidates")
    # Only promote values after exact comparison above; never overwrite an
    # untrusted runner claim into an apparently attested result.
    result.update({
        "provider": provider,
        "modelVersion": health["modelVersion"],
        "version": health["modelVersion"],
        "checkpointSha256": health["checkpointSha256"],
        "revision": health["revision"],
        "containerDigest": health["containerDigest"],
        "sourceImageDigest": health["sourceImageDigest"],
        "modalImageId": health["modalImageId"],
        "imageId": health["modalImageId"],
        "cudaVersion": health["cudaVersion"],
        "pytorchVersion": health["pytorchVersion"],
        "gpu": health["gpu"],
        "runtimeProvenance": provenance,
        "smokeTested": True,
    })
    return result


async def _execute(job_id: str) -> None:
    connection = _db()
    try:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row or row["status"] != "queued":
            connection.execute("ROLLBACK")
            return
        claimed = connection.execute(
            "UPDATE jobs SET status='running', progress=5, stage='attesting_model', updated_at=? WHERE id=? AND status='queued'",
            (time.time(), job_id),
        ).rowcount
        connection.execute("COMMIT")
        if claimed != 1:
            return
        provider = row["provider"]
        request = _runner_payload(json.loads(row["request_json"]), job_id)
        artifact_base = request.get("_artifactBaseUrl")
        health = (
            _validate_provider(provider, artifact_base)
            if artifact_base
            else _validate_provider(provider)
        )
        loading = connection.execute(
            "UPDATE jobs SET progress=15, stage='loading_model', updated_at=? WHERE id=? AND status='running'",
            (time.time(), job_id),
        ).rowcount
        if loading != 1:
            connection.execute(
                "UPDATE jobs SET status='cancelled', progress=100, stage='cancelled', updated_at=? WHERE id=? AND status='cancel_requested'",
                (time.time(), job_id),
            )
            return
        runner = os.getenv(PROVIDERS[provider]["runner_env"], "").strip()
        connection.execute(
            "UPDATE jobs SET progress=35, stage='running_model', updated_at=? WHERE id=?",
            (time.time(), job_id),
        )
        async with SEMAPHORE:
            owner = connection.execute(
                "SELECT status FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
            if not owner or owner["status"] != "running":
                connection.execute(
                    "UPDATE jobs SET status='cancelled', progress=100, stage='cancelled', updated_at=? WHERE id=? AND status='cancel_requested'",
                    (time.time(), job_id),
                )
                return
            process = await asyncio.create_subprocess_exec(
                *shlex.split(runner),
                "--job",
                "--provider",
                provider,
                "--model-version",
                health["modelVersion"],
                "--checkpoint",
                str(CHECKPOINT_ROOT / PROVIDERS[provider]["checkpoint_path"]),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={
                    **os.environ,
                    "CUDA_VISIBLE_DEVICES": os.getenv("CUDA_VISIBLE_DEVICES", "0"),
                    "MODAL_IMAGE_ID": os.getenv("MODAL_IMAGE_ID", ""),
                    "MUSIC_GPU_ARTIFACT_BASE_URL": request.get("_artifactBaseUrl", ""),
                    "MUSIC_GPU_ARTIFACT_CAPABILITY_EXPIRES": str(
                        int(time.time()) + ARTIFACT_TTL_SECONDS
                    ),
                },
            )
            PROCESSES[job_id] = process
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(json.dumps(request).encode()),
                    timeout=JOB_TIMEOUT_SECONDS,
                )
            except TimeoutError:
                process.kill()
                await process.wait()
                raise RuntimeError("model runner timed out")
            finally:
                PROCESSES.pop(job_id, None)
            code = process.returncode
            output = stdout.decode(errors="replace")[-4 * 1024 * 1024:]
            error = stderr.decode(errors="replace")[-4096:]
            _durable_commit("output")
        latest = connection.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        if latest and latest["status"] == "cancel_requested":
            connection.execute(
                "UPDATE jobs SET status='cancelled', progress=100, stage='cancelled', updated_at=? WHERE id=?",
                (time.time(), job_id),
            )
            return
        if code != 0:
            raise RuntimeError(f"model runner failed ({error or 'non-zero exit'})")
        result = _result_from_runner(provider, health, output)
        completed = connection.execute(
            "UPDATE jobs SET status='completed', progress=100, stage='completed', result_json=?, updated_at=? WHERE id=? AND status='running'",
            (json.dumps(result), time.time(), job_id),
        ).rowcount
        if completed != 1:
            connection.execute(
                "UPDATE jobs SET status='cancelled', progress=100, stage='cancelled', updated_at=? WHERE id=? AND status='cancel_requested'",
                (time.time(), job_id),
            )
        _durable_commit("job")
    except HTTPException as exc:
        connection.execute(
            "UPDATE jobs SET status='failed', progress=100, stage='failed', error=?, error_code=?, updated_at=? WHERE id=? AND status='running'",
            (str(exc.detail), "MODEL_NOT_READY", time.time(), job_id),
        )
    except asyncio.CancelledError:
        connection.execute(
            "UPDATE jobs SET status='cancelled', progress=100, stage='cancelled', updated_at=? WHERE id=?",
            (time.time(), job_id),
        )
        raise
    except Exception as exc:
        connection.execute(
            "UPDATE jobs SET status='failed', progress=100, stage='failed', error=?, error_code=?, updated_at=? WHERE id=? AND status='running'",
            (str(exc), "RUNNER_FAILED", time.time(), job_id),
        )
        connection.execute(
            "UPDATE jobs SET status='cancelled', progress=100, stage='cancelled', updated_at=? WHERE id=? AND status='cancel_requested'",
            (time.time(), job_id),
        )
    finally:
        TASKS.pop(job_id, None)
        PROCESSES.pop(job_id, None)
        connection.close()
        # Covers cancellation and failure transitions as well as the explicit
        # completion commit above. In Modal a failed commit propagates, rather
        # than allowing an uncommitted state to be reported as durable.
        _durable_commit("job")


def _runner_payload(request: dict[str, Any], job_id: str) -> dict[str, Any]:
    """Fence runner durable directories to the persisted worker job identity."""
    payload = dict(request)
    payload["jobId"] = job_id
    payload["requestId"] = job_id
    return payload


def _queue(
    request: JobRequest, idempotency_key: str, artifact_base_url: str | None = None
) -> dict[str, Any]:
    if not idempotency_key.strip():
        raise HTTPException(400, "Idempotency-Key is required")
    details = PROVIDERS.get(request.provider)
    if not details:
        raise HTTPException(404, "unknown provider")
    if request.model_version and request.model_version != details["model_version"]:
        raise HTTPException(409, "requested model version does not match the manifest")
    serialized = request.model_dump(by_alias=True, mode="json")
    request_hash = hashlib.sha256(
        json.dumps(serialized, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    if artifact_base_url:
        serialized["_artifactBaseUrl"] = artifact_base_url
    connection = _db()
    now = time.time()
    try:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM jobs WHERE idempotency_key=?", (idempotency_key,)
        ).fetchone()
        if row:
            if row["request_hash"] != request_hash:
                connection.execute("ROLLBACK")
                raise HTTPException(409, "Idempotency-Key was already used for another request")
            existing = _row(row)
            connection.execute("COMMIT")
            return existing
        job_id = f"gpu-{uuid.uuid4().hex}"
        connection.execute(
            "INSERT INTO jobs (id,idempotency_key,request_hash,provider,status,request_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (job_id, idempotency_key, request_hash, request.provider, "queued",
             json.dumps(serialized), now, now),
        )
        created = _row(connection.execute(
            "SELECT * FROM jobs WHERE id=?", (job_id,)
        ).fetchone())
        connection.execute("COMMIT")
        _durable_commit("job")
        return created
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    connection = _db()
    connection.execute(
        "UPDATE jobs SET status='cancelled', progress=100, stage='cancelled_after_restart', updated_at=? WHERE status='cancel_requested'",
        (time.time(),),
    )
    connection.execute(
        "UPDATE jobs SET status='queued', stage='recovered_after_restart', updated_at=? WHERE status='running'",
        (time.time(),),
    )
    rows = connection.execute("SELECT id FROM jobs WHERE status='queued'").fetchall()
    connection.close()
    _durable_commit("job")
    for row in rows:
        TASKS[row["id"]] = asyncio.create_task(_execute(row["id"]))
    yield
    for task in list(TASKS.values()):
        task.cancel()
    if TASKS:
        await asyncio.gather(*TASKS.values(), return_exceptions=True)


app = FastAPI(title="Music AI GPU Worker", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def size_limit(request: Request, call_next):
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > MAX_REQUEST_BYTES:
                return JSONResponse({"detail": "request exceeds size limit"}, status_code=413)
        except ValueError:
            return JSONResponse({"detail": "invalid content-length"}, status_code=400)
    return await call_next(request)


def _artifact_metadata(value: Any, filename: str) -> dict[str, Any] | None:
    if isinstance(value, dict):
        if value.get("name") == filename and isinstance(value.get("sha256"), str):
            return value
        for child in value.values():
            found = _artifact_metadata(child, filename)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _artifact_metadata(child, filename)
            if found:
                return found
    return None


def _consume_artifact(
    provider: str, job_id: str, filename: str, expires: int, capability: str
) -> FileResponse:
    """Atomically claim one capability-protected artifact for one download."""
    secret = os.getenv("MUSIC_GPU_ARTIFACT_CAPABILITY_SECRET", "")
    if not secret:
        raise HTTPException(503, "artifact capability service is not configured")
    providers_by_path = {name.lower(): name for name in PROVIDERS}
    canonical_provider = providers_by_path.get(provider)
    if (
        not canonical_provider
        or not SAFE_COMPONENT.fullmatch(job_id)
        or not SAFE_COMPONENT.fullmatch(filename)
        or Path(filename).suffix.lower() not in {".wav", ".flac"}
    ):
        raise HTTPException(404, "artifact not found")
    now = int(time.time())
    if expires <= now or expires > now + 24 * 60 * 60:
        raise HTTPException(410, "artifact capability has expired")
    job_dir = (OUTPUT_ROOT / provider / job_id).resolve()
    root = OUTPUT_ROOT.resolve()
    try:
        job_dir.relative_to(root)
    except ValueError:
        raise HTTPException(404, "artifact not found")
    path = (job_dir / filename).resolve()
    if path.parent != job_dir:
        raise HTTPException(404, "artifact not found")
    try:
        result = json.loads((job_dir / "result.json").read_text(encoding="utf-8"))
        metadata = _artifact_metadata(result, filename)
        size = path.stat().st_size
    except (OSError, json.JSONDecodeError):
        raise HTTPException(404, "artifact not found")
    if (
        not metadata
        or not isinstance(metadata.get("bytes"), int)
        or metadata["bytes"] != size
        or size <= 0
        or size > ARTIFACT_MAX_BYTES
    ):
        raise HTTPException(409, "artifact validation failed")
    actual_sha = _checkpoint_digest(path)
    expected_sha = str(metadata.get("sha256", "")).lower()
    if not actual_sha or not hmac.compare_digest(actual_sha.lower(), expected_sha):
        raise HTTPException(409, "artifact validation failed")
    expected = hmac.new(
        secret.encode(),
        f"{canonical_provider}/{job_id}/{filename}/{expected_sha}/{expires}".encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, capability):
        raise HTTPException(401, "invalid artifact capability")
    claimed = job_dir / f".download-{uuid.uuid4().hex}"
    try:
        path.rename(claimed)
    except FileNotFoundError:
        raise HTTPException(404, "artifact not found")
    return FileResponse(
        claimed,
        media_type=str(metadata.get("contentType") or "application/octet-stream"),
        filename=filename,
        headers={"Cache-Control": "no-store"},
        background=BackgroundTask(_delete_claimed_artifact, claimed),
    )


def _delete_claimed_artifact(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
        _durable_commit("output")
    except Exception:
        # A consumed capability must never be restored after a failed durable
        # delete commit; the renamed path remains unreachable and fail-closed.
        raise


@app.get("/artifacts/{provider}/{job_id}/{filename}")
def download_artifact(
    provider: str, job_id: str, filename: str, expires: int, capability: str
):
    return _consume_artifact(provider, job_id, filename, expires, capability)


@app.get("/health", dependencies=[Depends(_auth)])
def health(
    request: Request,
    provider: str | None = None,
    forceSmoke: bool = False,
):
    artifact_base = f"{_trusted_artifact_base(request)}/artifacts"
    if provider:
        return _provider_health(
            provider,
            artifact_base_url=artifact_base,
            force_smoke=forceSmoke,
        )
    return {
        "providers": {
            name: _provider_health(name, artifact_base_url=artifact_base)
            for name in PROVIDERS
        }
    }


async def submit(request: JobRequest, raw_request: Request):
    _assert_provider_license_allows_execution(request.provider)
    key = raw_request.headers.get("Idempotency-Key", "")
    base = _trusted_artifact_base(raw_request)
    job = _queue(request, key, f"{base}/artifacts")
    if job["id"] not in TASKS and job["status"] == "queued":
        TASKS[job["id"]] = asyncio.create_task(_execute(job["id"]))
    return JSONResponse(
        {
            "jobId": job["id"],
            "requestId": job["id"],
            "status": job["status"],
            "statusUrl": job["statusUrl"],
            "cancelUrl": job["cancelUrl"],
        },
        status_code=202,
    )


def _trusted_artifact_base(request: Request) -> str:
    """Compare the request origin to the exact deployment-controlled origin."""
    configured = os.getenv("MUSIC_GPU_PUBLIC_ORIGIN", "").strip()
    expected = urlsplit(configured)
    if (
        expected.scheme != "https" or not expected.hostname
        or expected.username or expected.password
        or expected.path not in ("", "/") or expected.query or expected.fragment
    ):
        raise HTTPException(503, "canonical public origin is not configured")
    parsed = urlsplit(str(request.base_url).rstrip("/"))
    enabled = list(ENABLED)
    if len(enabled) != 1:
        raise HTTPException(503, "artifact origin requires one isolated provider")
    hostname = (parsed.hostname or "").lower()
    expected_port = expected.port or 443
    actual_port = parsed.port or 443
    if (
        parsed.scheme != "https"
        or actual_port != expected_port
        or parsed.username
        or parsed.password
        or hostname != expected.hostname.lower()
    ):
        raise HTTPException(400, "request origin does not match the configured endpoint")
    return (
        f"https://{expected.hostname.lower()}"
        + (f":{expected_port}" if expected_port != 443 else "")
    )


@app.post("/generate", dependencies=[Depends(_auth)])
async def generate(request: JobRequest, raw_request: Request):
    if request.provider not in {"ACE_STEP", "MUSICGEN"}:
        raise HTTPException(422, "generate supports ACE_STEP and MUSICGEN")
    return await submit(request, raw_request)


@app.post("/arrange", dependencies=[Depends(_auth)])
async def arrange(request: JobRequest, raw_request: Request):
    if request.provider not in {"ACE_STEP", "MUSICGEN"}:
        raise HTTPException(422, "arrange supports ACE_STEP and MUSICGEN")
    return await submit(request, raw_request)


@app.post("/separate", dependencies=[Depends(_auth)])
async def separate(request: JobRequest, raw_request: Request):
    if request.provider != "BS_ROFORMER":
        raise HTTPException(422, "separate supports BS_ROFORMER")
    return await submit(request, raw_request)


@app.post("/transcribe", dependencies=[Depends(_auth)])
async def transcribe(request: JobRequest, raw_request: Request):
    if request.provider != "MT3":
        raise HTTPException(422, "transcribe supports MT3")
    return await submit(request, raw_request)


@app.post("/analyze", dependencies=[Depends(_auth)])
async def analyze(request: JobRequest, raw_request: Request):
    if request.provider not in {"MT3", "ALL_IN_ONE"}:
        raise HTTPException(422, "analyze supports MT3 and ALL_IN_ONE")
    return await submit(request, raw_request)


@app.get("/jobs/{job_id}", dependencies=[Depends(_auth)])
def job_status(job_id: str):
    connection = _db()
    row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    connection.close()
    if not row:
        raise HTTPException(404, "job not found")
    result = _row(row)
    if result.get("result"):
        result["result"] = result["result"]
    return result


@app.delete("/jobs/{job_id}", dependencies=[Depends(_auth)])
def cancel(job_id: str):
    connection = _db()
    row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        connection.close()
        raise HTTPException(404, "job not found")
    if row["status"] in {"completed", "failed", "cancelled"}:
        connection.close()
        return _row(row)
    next_status = "cancelled" if row["status"] == "queued" else "cancel_requested"
    next_stage = "cancelled" if row["status"] == "queued" else "cancellation_requested"
    connection.execute(
        "UPDATE jobs SET status=?, progress=?, stage=?, updated_at=? WHERE id=?",
        (
            next_status,
            100 if next_status == "cancelled" else row["progress"],
            next_stage,
            time.time(),
            job_id,
        ),
    )
    updated = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    connection.close()
    _durable_commit("job")
    task = TASKS.get(job_id)
    if task and row["status"] == "queued":
        task.cancel()
    process = PROCESSES.get(job_id)
    if process and process.returncode is None:
        process.terminate()
    return _row(updated)
