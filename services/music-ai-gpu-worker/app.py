"""Fail-closed asynchronous worker for pinned GPU music models.

The worker deliberately contains no CPU or synthetic fallback. A deployment
supplies provider-specific model runners and checkpoints in durable storage.
The runner protocol is documented in README.md; this service owns readiness,
idempotency, persistence, cancellation, and provenance fencing around it.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

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
ENABLED = {
    value.strip()
    for value in os.getenv("MUSIC_GPU_ENABLED_PROVIDERS", "").split(",")
    if value.strip()
}
TASKS: dict[str, asyncio.Task[None]] = {}
PROCESSES: dict[str, asyncio.subprocess.Process] = {}
SMOKE_ATTESTATIONS: dict[str, str] = {}
SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_JOBS)


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


def _gpu_runtime() -> tuple[bool, str]:
    expected_python = MANIFEST["runtime"]["python"]
    actual_python = ".".join(str(part) for part in sys.version_info[:3])
    if actual_python != expected_python:
        return False, f"Python version {actual_python} does not match {expected_python}"
    try:
        import torch
    except Exception:
        return False, "PyTorch is not installed"
    expected = MANIFEST["runtime"]["pytorch"]
    actual = getattr(torch, "__version__", "")
    if actual != expected:
        return False, f"PyTorch version {actual or 'unknown'} does not match {expected}"
    for distribution in ("transformers", "accelerate"):
        expected_package = MANIFEST["runtime"][distribution]
        actual_package = _installed_version(distribution)
        if actual_package != expected_package:
            return False, (
                f"{distribution} version {actual_package or 'missing'} "
                f"does not match {expected_package}"
            )
    expected_cuda = MANIFEST["runtime"]["cuda"]
    image_cuda = os.getenv("MUSIC_GPU_CUDA_VERSION")
    if image_cuda != expected_cuda:
        return False, f"CUDA image version {image_cuda or 'unknown'} does not match {expected_cuda}"
    if not torch.cuda.is_available():
        return False, "CUDA GPU is not available"
    try:
        torch.zeros(1, device="cuda").sum().item()
    except Exception as exc:
        return False, f"CUDA smoke allocation failed: {type(exc).__name__}"
    return True, f"CUDA {torch.version.cuda or 'unknown'} GPU ready"


def _run_command(command: str, args: list[str], payload: dict[str, Any] | None,
                 timeout: int) -> tuple[int, str, str]:
    try:
        process = subprocess.run(
            [*shlex.split(command), *args],
            input=json.dumps(payload) if payload is not None else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "CUDA_VISIBLE_DEVICES": os.getenv("CUDA_VISIBLE_DEVICES", "0")},
        )
        return process.returncode, process.stdout[-4 * 1024 * 1024:], process.stderr[-4096:]
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return 127, "", type(exc).__name__


def _provider_health(provider: str, run_smoke: bool = True) -> dict[str, Any]:
    details = PROVIDERS.get(provider)
    if not details:
        raise HTTPException(404, "unknown provider")
    version = details["model_version"]
    checkpoint = CHECKPOINT_ROOT / details["checkpoint_path"]
    configured = provider in ENABLED if ENABLED else False
    expected_hash = (
        os.getenv(f"MUSIC_PROVIDER_{provider}_CHECKPOINT_SHA256", "").strip()
        or details.get("checkpoint_sha256")
    )
    actual_hash = _checkpoint_digest(checkpoint)
    runtime_ready, runtime_message = _gpu_runtime()
    checksum_ready = bool(expected_hash and actual_hash and actual_hash.lower() == expected_hash.lower())
    runner = os.getenv(details["runner_env"], "").strip()
    smoke_command = os.getenv(details["smoke_env"], "").strip() or runner
    smoke_tested = bool(actual_hash and SMOKE_ATTESTATIONS.get(provider) == actual_hash)
    smoke_message = (
        "Real GPU smoke inference verified"
        if smoke_tested
        else "Real smoke runner is not configured"
    )
    if (
        configured and runtime_ready and checksum_ready and smoke_command
        and run_smoke and not smoke_tested
    ):
        code, output, error = _run_command(
            smoke_command,
            ["--smoke", "--provider", provider, "--model-version", version,
             "--checkpoint", str(checkpoint)],
            None,
            HEALTH_TIMEOUT_SECONDS,
        )
        if code == 0:
            try:
                proof = json.loads(output.strip().splitlines()[-1])
                smoke_tested = (
                    proof.get("smokeTested") is True
                    and proof.get("provider") == provider
                    and proof.get("modelVersion") == version
                    and proof.get("checkpointSha256", "").lower() == actual_hash.lower()
                    and bool(proof.get("output"))
                )
                if smoke_tested and actual_hash:
                    SMOKE_ATTESTATIONS[provider] = actual_hash
                smoke_message = "Real GPU smoke inference verified" if smoke_tested else "Smoke proof did not match the loaded model"
            except (json.JSONDecodeError, IndexError):
                smoke_message = "Smoke runner did not return a valid proof"
        else:
            smoke_message = f"Smoke inference failed ({error or 'runner error'})"
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
    if not runner:
        reasons.append("model runner is not configured")
    if not smoke_tested:
        reasons.append(smoke_message)
    ready = not reasons
    return {
        "status": "ready" if ready else ("configured" if configured else "unavailable"),
        "healthy": ready,
        "provider": provider,
        "runtimeReady": runtime_ready,
        "gpuReady": runtime_ready,
        "checkpointReady": checksum_ready,
        "modelVersion": version,
        "version": version,
        "checksum": actual_hash,
        "checkpointSha256": actual_hash,
        "smokeTested": smoke_tested,
        "framework": MANIFEST["runtime"],
        "message": "GPU checkpoint, runtime, checksum, and smoke test are verified"
        if ready else "; ".join(reasons),
    }


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    provider: str
    model_version: str | None = Field(default=None, alias="modelVersion")


def _validate_provider(provider: str) -> dict[str, Any]:
    if provider not in PROVIDERS:
        raise HTTPException(404, "unknown provider")
    health = _provider_health(provider, run_smoke=True)
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
    candidates = result.get("candidates")
    if provider in {"ACE_STEP", "MUSICGEN"} and (
        not isinstance(candidates, list) or not candidates
    ):
        raise RuntimeError("generation runner returned no candidates")
    result["provider"] = provider
    result["modelVersion"] = health["modelVersion"]
    result["version"] = health["modelVersion"]
    result["checkpointSha256"] = health["checkpointSha256"]
    result["smokeTested"] = True
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
        health = _validate_provider(provider)
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
        request = json.loads(row["request_json"])
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


def _queue(request: JobRequest, idempotency_key: str) -> dict[str, Any]:
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


@app.get("/health", dependencies=[Depends(_auth)])
def health(provider: str | None = None):
    if provider:
        return _provider_health(provider)
    return {"providers": {name: _provider_health(name) for name in PROVIDERS}}


async def submit(request: JobRequest, raw_request: Request):
    key = raw_request.headers.get("Idempotency-Key", "")
    job = _queue(request, key)
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
    if request.provider != "MT3":
        raise HTTPException(422, "analyze supports MT3")
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
    task = TASKS.get(job_id)
    if task and row["status"] == "queued":
        task.cancel()
    process = PROCESSES.get(job_id)
    if process and process.returncode is None:
        process.terminate()
    return _row(updated)