"""Observe, attest, and promote one exact DiffRhythm2 research deployment."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import multiprocessing
import os
import queue
import re
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
import wave
from multiprocessing.connection import wait as wait_for_connections
from pathlib import Path
from urllib.parse import urlsplit

import modal
from modal.exception import RemoteError

from modal_config import APP_NAME, PROMOTION_SECRET_NAME
from comparison_resources import (
    COMPARISON_CANCELLATION_WORK_SECONDS,
    COMPARISON_EXECUTION_STOP_BOUND_SECONDS,
    COMPARISON_MAX_CONCURRENT_INPUTS,
)

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[1]
EVIDENCE = ROOT / "release-evidence"
GENERATED = WORKSPACE / "artifacts/api-server/src/lib/gpuPromotions.generated.ts"
KEY_DERIVATION_DOMAIN = b"MUSIC_GPU Modal promotion v1\0"
ED25519_PKCS8_PREFIX = bytes.fromhex("302e020100300506032b657004220420")
RESEARCH_LICENSE = (
    "Apache-2.0 source and DiffRhythm2 weights; "
    "CC-BY-NC-4.0 MuQ-MuLan and MuQ weights"
)
COMPARISON_APP_NAME = f"{APP_NAME}-comparison"
COMPARISON_BURST_REQUESTS = max(3, COMPARISON_MAX_CONCURRENT_INPUTS + 1)
COMPARISON_BURST_TIMEOUT_SECONDS = 600
COMPARISON_RESULT_WAITER_CLEANUP_SECONDS = 0.1
COMPARISON_CANCEL_TIMEOUT_SECONDS = 0.25
COMPARISON_CANCEL_WORKER_START_BOUND_SECONDS = 5
COMPARISON_STALL_START_BOUND_SECONDS = 60
COMPARISON_CANCEL_ACK_BOUND_SECONDS = 30
COMPARISON_RECOVERY_BOUND_SECONDS = 30
COMPARISON_CANCELLATION_SUITE_BOUND_SECONDS = (
    COMPARISON_STALL_START_BOUND_SECONDS * COMPARISON_MAX_CONCURRENT_INPUTS
    + COMPARISON_CANCEL_ACK_BOUND_SECONDS * 2
    + COMPARISON_EXECUTION_STOP_BOUND_SECONDS
    + COMPARISON_RECOVERY_BOUND_SECONDS
)


def _cancel_modal_call(call_id: str, sender, _worker_args: tuple) -> None:
    try:
        sender.send("started")
        modal.FunctionCall.from_id(call_id).cancel()
        sender.send(True)
    except Exception:
        sender.send(False)
    finally:
        sender.close()


def _await_modal_cancellation(
    call_id: str, sender, worker_args: tuple
) -> None:
    deadline, = worker_args
    try:
        sender.send("started")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            sender.send(False)
            return
        modal.FunctionCall.from_id(call_id).get(timeout=remaining)
        sender.send(False)
    except RemoteError:
        sender.send(True)
    except Exception:
        sender.send(False)
    finally:
        sender.close()


def _await_local_cancellation(call, sender, worker_args: tuple) -> None:
    deadline, = worker_args
    try:
        sender.send("started")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            sender.send(False)
            return
        call.get(timeout=remaining)
        sender.send(False)
    except RemoteError:
        sender.send(True)
    except Exception:
        sender.send(False)
    finally:
        sender.close()


def _run_cancel_workers_within_bound(
    call_ids: list,
    timeout_seconds: float,
    worker_target=_cancel_modal_call,
    worker_args: tuple = (),
    absolute_deadline: float | None = None,
    context_name: str = "spawn",
) -> list[bool]:
    overall_deadline = (
        absolute_deadline
        if absolute_deadline is not None
        else time.monotonic() + timeout_seconds
    )
    cleanup_reserve = min(0.2, timeout_seconds / 2)
    context = multiprocessing.get_context(context_name)
    receivers = []
    workers = []
    try:
        for call_id in call_ids:
            receiver, sender = context.Pipe(duplex=False)
            worker = context.Process(
                target=worker_target, args=(call_id, sender, worker_args)
            )
            worker.daemon = True
            worker.start()
            sender.close()
            receivers.append(receiver)
            workers.append(worker)

        startup_deadline = min(
            overall_deadline - cleanup_reserve,
            time.monotonic() + COMPARISON_CANCEL_WORKER_START_BOUND_SECONDS,
        )
        started = []
        for receiver in receivers:
            remaining = startup_deadline - time.monotonic()
            if remaining > 0 and receiver.poll(remaining):
                try:
                    started.append(receiver.recv() == "started")
                except EOFError:
                    started.append(False)
            else:
                started.append(False)

        result_deadline = overall_deadline - cleanup_reserve
        results = [False] * len(receivers)
        pending_receivers = {
            receiver: index
            for index, (receiver, worker_started)
            in enumerate(zip(receivers, started))
            if worker_started
        }
        while pending_receivers:
            remaining = result_deadline - time.monotonic()
            if remaining <= 0:
                break
            ready = wait_for_connections(
                list(pending_receivers), timeout=remaining
            )
            if not ready:
                break
            for receiver in ready:
                index = pending_receivers.pop(receiver)
                try:
                    results[index] = receiver.recv() is True
                except EOFError:
                    results[index] = False
        return results
    finally:
        for receiver in receivers:
            receiver.close()
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
        termination_deadline = overall_deadline - cleanup_reserve / 2
        for worker in workers:
            worker.join(timeout=max(0, termination_deadline - time.monotonic()))
        for worker in workers:
            if worker.is_alive():
                worker.kill()
        for worker in workers:
            worker.join(timeout=max(0, overall_deadline - time.monotonic()))


def cancel_calls_within_bound(
    calls: list,
    timeout_seconds: float,
    absolute_deadline: float | None = None,
) -> list[bool]:
    """Cancel call IDs in fresh clients and reap workers within a shared bound."""
    return _run_cancel_workers_within_bound(
        [str(call.object_id) for call in calls],
        timeout_seconds,
        absolute_deadline=absolute_deadline,
    )


def _run_acknowledgement_workers_within_bound(
    call_ids: list[str],
    deadline: float,
    worker_target=_await_modal_cancellation,
    worker_args: tuple = (),
) -> list[bool]:
    return _run_cancel_workers_within_bound(
        call_ids,
        max(0, deadline - time.monotonic()),
        worker_target,
        (deadline, *worker_args),
        deadline,
    )


def cancel_calls_before_deadline(calls: list, timeout_seconds: float) -> tuple[int, int]:
    """Request and observe cancellation against one monotonic deadline."""
    deadline = time.monotonic() + timeout_seconds
    request_results = cancel_calls_within_bound(
        calls,
        max(0, deadline - time.monotonic()),
        absolute_deadline=deadline,
    )
    requested = sum(request_results)
    if requested != len(calls):
        return requested, 0
    return requested, count_cancellation_acknowledgements(calls, deadline)


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as handle:
        handle.write(canonical(value) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, path)


def modal_json(*args: str) -> object:
    result = subprocess.run(
        ["uv", "run", "modal", *args],
        cwd=WORKSPACE,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Modal metadata command failed: {' '.join(args[:2])}")
    return json.loads(result.stdout)


def origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("DiffRhythm2 endpoint is not a credential-free HTTPS origin")
    return f"https://{parsed.hostname.lower()}" + (
        f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    )


def observe() -> dict:
    apps = modal_json("app", "list", "--json")
    matches = [
        item
        for item in apps
        if isinstance(item, dict)
        and item.get("description") == APP_NAME
        and item.get("state") == "deployed"
    ]
    if len(matches) != 1:
        raise ValueError("expected exactly one deployed DiffRhythm2 app")
    app_id = str(matches[0]["app_id"])
    history = modal_json("app", "history", app_id, "--json")
    if not isinstance(history, list) or not history:
        raise ValueError("DiffRhythm2 deployment history is empty")
    endpoint = modal.Function.from_name(APP_NAME, "endpoint")
    endpoint.hydrate()
    metadata = {
        "provider": "DIFFRHYTHM_2",
        "modalAppId": app_id,
        "modalDeploymentId": str(history[0]["version"]),
        "modalFunctionId": endpoint.object_id,
        "endpointOrigin": origin(endpoint.get_web_url()),
    }
    for field, pattern in {
        "modalAppId": r"ap-[A-Za-z0-9]+",
        "modalDeploymentId": r"v[1-9][0-9]*",
        "modalFunctionId": r"fu-[A-Za-z0-9]+",
    }.items():
        if re.fullmatch(pattern, metadata[field]) is None:
            raise ValueError(f"invalid observed {field}")
    return metadata


def observe_comparison() -> dict:
    apps = modal_json("app", "list", "--json")
    matches = [
        item
        for item in apps
        if isinstance(item, dict)
        and item.get("description") == COMPARISON_APP_NAME
        and item.get("state") == "deployed"
    ]
    if len(matches) != 1:
        raise ValueError("expected exactly one deployed DiffRhythm2 comparison app")
    app_id = str(matches[0]["app_id"])
    history = modal_json("app", "history", app_id, "--json")
    if not isinstance(history, list) or not history:
        raise ValueError("DiffRhythm2 comparison deployment history is empty")
    function = modal.Function.from_name(
        COMPARISON_APP_NAME, "drill_retained_smoke_comparison"
    )
    function.hydrate()
    identity = {
        "modalAppId": app_id,
        "modalDeploymentId": str(history[0]["version"]),
        "modalFunctionId": function.object_id,
    }
    if (
        re.fullmatch(r"ap-[A-Za-z0-9]+", identity["modalAppId"]) is None
        or re.fullmatch(r"v[1-9][0-9]*", identity["modalDeploymentId"]) is None
        or re.fullmatch(r"fu-[A-Za-z0-9]+", identity["modalFunctionId"]) is None
    ):
        raise ValueError("DiffRhythm2 comparison deployment identity is invalid")
    return identity


def install_identity(metadata: dict) -> None:
    identity = {
        "MUSIC_GPU_MODAL_APP_ID": metadata["modalAppId"],
        "MUSIC_GPU_MODAL_DEPLOYMENT_ID": metadata["modalDeploymentId"],
        "MUSIC_GPU_MODAL_FUNCTION_ID": metadata["modalFunctionId"],
    }
    atomic_json(EVIDENCE / "worker-identity.json", identity)
    subprocess.run(
        [
            "uv",
            "run",
            "modal",
            "secret",
            "create",
            PROMOTION_SECRET_NAME,
            "--from-json",
            str(EVIDENCE / "worker-identity.json"),
            "--force",
        ],
        cwd=WORKSPACE,
        check=True,
    )
    containers = modal_json(
        "container", "list", "--app-id", metadata["modalAppId"], "--json"
    )
    previous = [
        item["container_id"]
        for item in containers
        if isinstance(item, dict)
        and re.fullmatch(r"ta-[A-Za-z0-9]+", str(item.get("container_id", "")))
    ]
    for container in previous:
        subprocess.run(
            [
                "uv",
                "run",
                "modal",
                "container",
                "stop",
                container,
                "--graceful",
                "--yes",
            ],
            cwd=WORKSPACE,
            check=True,
        )
    stale = previous
    for _ in range(30):
        current = modal_json(
            "container", "list", "--app-id", metadata["modalAppId"], "--json"
        )
        stale = [
            item.get("container_id")
            for item in current
            if isinstance(item, dict) and item.get("container_id") in previous
        ]
        if not stale:
            break
        time.sleep(2)
    proof = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "modalDeploymentId": metadata["modalDeploymentId"],
        "stoppedContainerIds": previous,
        "staleContainerIds": stale,
    }
    atomic_json(EVIDENCE / "identity-refresh.json", proof)
    if stale:
        raise RuntimeError("old DiffRhythm2 containers remained after identity rotation")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_health(metadata: dict) -> dict:
    token = os.getenv("MUSIC_AI_WORKER_TOKEN", "")
    if not token:
        raise ValueError("music worker token is unavailable")
    url = f"{metadata['endpointOrigin']}/health"
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.build_opener(NoRedirect).open(request, timeout=1800) as response:
        if response.status != 200 or response.geturl() != url:
            raise RuntimeError("DiffRhythm2 health did not return directly")
        health = json.loads(response.read(2 * 1024 * 1024))
    required = (
        health.get("provider") == "DIFFRHYTHM_2",
        health.get("ready") is True,
        health.get("healthy") is True,
        health.get("licenseStatus") == "RESEARCH_ONLY",
        health.get("commercialUsePermitted") is False,
        health.get("modalAppId") == metadata["modalAppId"],
        health.get("modalDeploymentId") == metadata["modalDeploymentId"],
        health.get("modalFunctionId") == metadata["modalFunctionId"],
        re.fullmatch(r"im-[A-Za-z0-9]+", str(health.get("modalImageId", ""))) is not None,
    )
    if not all(required):
        raise ValueError("DiffRhythm2 live health is incomplete or identity drifted")
    return health

def validate_codec_evidence(health: dict) -> dict:
    codec_evidence = health.get("codecThresholdEvidence")
    if (
        not isinstance(codec_evidence, dict)
        or codec_evidence.get("passed") is not True
        or codec_evidence.get("audioRetained") is not False
        or codec_evidence.get("sourceImageDigest") != health["sourceImageDigest"]
        or codec_evidence.get("modalImageId") != health["modalImageId"]
        or not str(codec_evidence.get("ffmpegVersion", "")).startswith("ffmpeg version ")
    ):
        raise ValueError("DiffRhythm2 image codec threshold evidence is incomplete")
    return codec_evidence
def research_rhythm_wav() -> bytes:
    sample_rate = 16000
    duration_seconds = 4
    frames = bytearray()
    for index in range(sample_rate * duration_seconds):
        time_seconds = index / sample_rate
        beat_phase = time_seconds % 0.5
        pulse = math.exp(-beat_phase * 28) * math.sin(2 * math.pi * 110 * time_seconds)
        frames.extend(struct.pack("<h", round(max(-1, min(1, pulse * 0.45)) * 32767)))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as fixture:
        fixture.setnchannels(1)
        fixture.setsampwidth(2)
        fixture.setframerate(sample_rate)
        fixture.writeframes(frames)
    return buffer.getvalue()


def describe_audio(audio: bytes) -> dict:
    with tempfile.NamedTemporaryFile(suffix=".mp3") as handle:
        handle.write(audio)
        handle.flush()
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries",
                "format=duration", "-of", "json", handle.name,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        decoded = subprocess.run(
            [
                "ffmpeg", "-v", "error", "-i", handle.name, "-f", "s16le",
                "-ac", "1", "-ar", "16000", "pipe:1",
            ],
            capture_output=True,
            check=False,
        )
    if probe.returncode or decoded.returncode:
        raise RuntimeError("DiffRhythm2 canary artifact is not decodable audio")
    try:
        duration = float(json.loads(probe.stdout)["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("DiffRhythm2 canary duration is unavailable") from exc
    samples = struct.iter_unpack("<h", decoded.stdout)
    sample_count = 0
    square_sum = 0
    for (sample,) in samples:
        sample_count += 1
        square_sum += sample * sample
    rms = math.sqrt(square_sum / sample_count) / 32768 if sample_count else 0
    if duration < 1 or rms <= 1e-5:
        raise RuntimeError("DiffRhythm2 canary artifact is silent or too short")
    return {"durationSeconds": duration, "rmsAmplitude": rms}


def verify_research_generation(metadata: dict, health: dict | None = None) -> dict:
    token = os.getenv("MUSIC_AI_WORKER_TOKEN", "").strip()
    if not token:
        raise ValueError("music worker token is unavailable")
    health = health or fetch_health(metadata)
    body = canonical({
        "lyrics": "[verse]\nA short research canary follows the beat",
        "rhythmWavBase64": base64.b64encode(research_rhythm_wav()).decode(),
        "stylePrompt": "minimal acoustic pop",
        "duration": 8,
        "steps": 16,
        "guidance": 2,
    }).encode()
    generation_url = f"{metadata['endpointOrigin']}/generate"
    request = urllib.request.Request(
        generation_url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(request, timeout=1800) as response:
        if response.status != 200 or response.geturl() != generation_url:
            raise RuntimeError("DiffRhythm2 canary generation did not return directly")
        result = json.loads(response.read(2 * 1024 * 1024))
    if (
        result.get("provider") != "DIFFRHYTHM_2"
        or result.get("licenseStatus") != "RESEARCH_ONLY"
        or result.get("commercialUsePermitted") is not False
        or result.get("license") != RESEARCH_LICENSE
    ):
        raise ValueError("DiffRhythm2 canary response lost its research license terms")
    artifact_path = str(result.get("artifactUrl", ""))
    if re.fullmatch(r"/artifacts/[a-f0-9]{32}", artifact_path) is None:
        raise ValueError("DiffRhythm2 canary returned an untrusted artifact path")
    artifact_url = f"{metadata['endpointOrigin']}{artifact_path}"
    artifact_request = urllib.request.Request(
        artifact_url, headers={"Authorization": f"Bearer {token}"}
    )
    with opener.open(artifact_request, timeout=1800) as response:
        if response.status != 200 or response.geturl() != artifact_url:
            raise RuntimeError("DiffRhythm2 canary artifact was not directly retrievable")
        audio = response.read(128 * 1024 * 1024 + 1)
        etag = response.headers.get("ETag", "").strip('"')
    if len(audio) > 128 * 1024 * 1024:
        raise ValueError("DiffRhythm2 canary artifact exceeds verification limit")
    observed_sha = hashlib.sha256(audio).hexdigest()
    if observed_sha != result.get("artifactSha256") or etag != observed_sha:
        raise ValueError("DiffRhythm2 canary artifact hash differs from response metadata")
    description = describe_audio(audio)
    proof = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "modalDeploymentId": metadata["modalDeploymentId"],
        "modalImageId": health["modalImageId"],
        "licenseStatus": "RESEARCH_ONLY",
        "commercialUsePermitted": False,
        "license": RESEARCH_LICENSE,
        "outputSha256": observed_sha,
        "bytes": len(audio),
        **description,
        "artifactHashVerified": True,
        "authenticatedArtifactRetrieved": True,
        "artifactOrigin": metadata["endpointOrigin"],
    }
    atomic_json(EVIDENCE / "live-research-generation-proof.json", proof)
    return proof


def validate_generation_proof(proof: dict, metadata: dict, health: dict) -> None:
    exact = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "modalDeploymentId": metadata["modalDeploymentId"],
        "modalImageId": health["modalImageId"],
        "licenseStatus": "RESEARCH_ONLY",
        "commercialUsePermitted": False,
        "license": RESEARCH_LICENSE,
        "artifactHashVerified": True,
        "authenticatedArtifactRetrieved": True,
        "artifactOrigin": metadata["endpointOrigin"],
    }
    if any(proof.get(field) != expected for field, expected in exact.items()):
        raise ValueError("DiffRhythm2 retained generation proof is stale or invalid")
    if (
        re.fullmatch(r"[a-f0-9]{64}", str(proof.get("outputSha256", ""))) is None
        or not isinstance(proof.get("bytes"), int)
        or proof["bytes"] <= 0
        or not isinstance(proof.get("durationSeconds"), (int, float))
        or proof["durationSeconds"] < 1
        or not isinstance(proof.get("rmsAmplitude"), (int, float))
        or proof["rmsAmplitude"] <= 1e-5
    ):
        raise ValueError("DiffRhythm2 retained generation audio evidence is invalid")


def verify_comparison_burst(metadata: dict) -> dict:
    identity = observe_comparison()
    comparison = modal.Function.from_name(
        COMPARISON_APP_NAME, "drill_retained_smoke_comparison"
    )
    started = time.time()
    outcomes = []
    results = queue.Queue()
    calls = {}
    result_waiters = []
    deadline = time.monotonic() + COMPARISON_BURST_TIMEOUT_SECONDS

    def await_comparison(index: int, call) -> None:
        try:
            results.put((
                index,
                call.get(timeout=max(0, deadline - time.monotonic())),
            ))
        except TimeoutError:
            return
        except Exception:
            results.put((index, None))

    for index in range(COMPARISON_BURST_REQUESTS):
        try:
            call = comparison.spawn()
        except Exception:
            results.put((index, None))
            continue
        calls[index] = call
        waiter = threading.Thread(
            target=await_comparison,
            args=(index, call),
            daemon=True,
            name=f"diffrhythm2-comparison-result-{index}",
        )
        waiter.start()
        result_waiters.append(waiter)

    pending = set(range(COMPARISON_BURST_REQUESTS))
    while pending:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            index, result = results.get(timeout=remaining)
        except queue.Empty:
            break
        if index not in pending:
            continue
        pending.remove(index)
        valid = (
            isinstance(result, dict)
            and result.get("outcome") == "completed"
            and isinstance(result.get("startedUnixSeconds"), (int, float))
            and isinstance(result.get("finishedUnixSeconds"), (int, float))
            and result["startedUnixSeconds"] <= result["finishedUnixSeconds"]
            and (
                result["finishedUnixSeconds"] - result["startedUnixSeconds"]
                <= COMPARISON_BURST_TIMEOUT_SECONDS
            )
            and result.get("modalImageId")
            and set(result) == {
                "outcome", "startedUnixSeconds", "finishedUnixSeconds",
                "modalImageId",
            }
        )
        observed = time.time()
        outcomes.append({
            "requestIndex": index,
            "outcome": "completed" if valid else "failed",
            "startedUnixSeconds": (
                float(result["startedUnixSeconds"]) if valid else observed
            ),
            "finishedUnixSeconds": (
                float(result["finishedUnixSeconds"]) if valid else observed
            ),
            "modalImageId": result.get("modalImageId", "") if valid else "",
        })
    waiter_cleanup_deadline = (
        max(deadline, time.monotonic()) + COMPARISON_RESULT_WAITER_CLEANUP_SECONDS
    )
    for waiter in result_waiters:
        waiter.join(timeout=max(0, waiter_cleanup_deadline - time.monotonic()))
    cancellable = {index for index in pending if index in calls}
    cancellation_failed = set(pending - cancellable)
    cancellation_deadline = time.monotonic() + COMPARISON_CANCEL_TIMEOUT_SECONDS
    cancellable_indices = sorted(cancellable)
    cancellation_results = cancel_calls_within_bound(
        [calls[index] for index in cancellable_indices],
        max(0, cancellation_deadline - time.monotonic()),
        absolute_deadline=cancellation_deadline,
    )
    for offset, index in enumerate(cancellable_indices):
        if (
            offset >= len(cancellation_results)
            or cancellation_results[offset] is not True
        ):
            cancellation_failed.add(index)
    for index in pending:
        outcomes.append({
            "requestIndex": index,
            "outcome": (
                "cancellation_failed" if index in cancellation_failed else "timeout"
            ),
            "startedUnixSeconds": started,
            "finishedUnixSeconds": started + COMPARISON_BURST_TIMEOUT_SECONDS,
            "modalImageId": "",
        })
    completed = [
        item for item in outcomes if item["outcome"] == "completed"
    ]
    image_ids = {item["modalImageId"] for item in completed}
    ordered = sorted(completed, key=lambda item: item["startedUnixSeconds"])
    queue_observed = (
        len(ordered) == COMPARISON_BURST_REQUESTS
        and len(image_ids) == 1
        and ordered[COMPARISON_MAX_CONCURRENT_INPUTS]["startedUnixSeconds"]
        >= min(
            item["finishedUnixSeconds"]
            for item in ordered[:COMPARISON_MAX_CONCURRENT_INPUTS]
        )
    )
    safe_outcomes = [
        {
            "requestIndex": item["requestIndex"],
            "outcome": item["outcome"],
            "startedAfterSeconds": round(
                max(0, item["startedUnixSeconds"] - started), 3
            ),
            "durationSeconds": round(
                max(0, item["finishedUnixSeconds"] - item["startedUnixSeconds"]), 3
            ),
        }
        for item in outcomes
    ]
    identity_unchanged = observe_comparison() == identity
    proof = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "workerModalDeploymentId": metadata["modalDeploymentId"],
        "comparisonModalAppId": identity["modalAppId"],
        "comparisonModalDeploymentId": identity["modalDeploymentId"],
        "comparisonModalFunctionId": identity["modalFunctionId"],
        "comparisonModalImageId": next(iter(image_ids), ""),
        "requestCount": COMPARISON_BURST_REQUESTS,
        "concurrencyLimit": COMPARISON_MAX_CONCURRENT_INPUTS,
        "timeoutSeconds": COMPARISON_BURST_TIMEOUT_SECONDS,
        "wallDurationSeconds": round(time.time() - started, 3),
        "queueObserved": queue_observed and identity_unchanged,
        "outcomes": sorted(safe_outcomes, key=lambda item: item["requestIndex"]),
    }
    atomic_json(EVIDENCE / "live-comparison-burst-proof.json", proof)
    if (
        any(item["outcome"] != "completed" for item in outcomes)
        or not queue_observed
        or not identity_unchanged
    ):
        raise RuntimeError(
            "live comparison burst did not queue safely within the worker resource limit"
        ) from None
    return proof


def validate_comparison_burst(proof: dict, metadata: dict) -> None:
    if (
        set(proof) != {
            "schemaVersion", "provider", "workerModalDeploymentId",
            "comparisonModalAppId", "comparisonModalDeploymentId",
            "comparisonModalFunctionId", "comparisonModalImageId", "requestCount",
            "concurrencyLimit", "timeoutSeconds", "wallDurationSeconds",
            "queueObserved", "outcomes",
        }
        or proof.get("schemaVersion") != 1
        or proof.get("provider") != "DIFFRHYTHM_2"
        or proof.get("workerModalDeploymentId") != metadata["modalDeploymentId"]
        or re.fullmatch(
            r"ap-[A-Za-z0-9]+", str(proof.get("comparisonModalAppId", ""))
        ) is None
        or re.fullmatch(
            r"v[1-9][0-9]*", str(proof.get("comparisonModalDeploymentId", ""))
        ) is None
        or re.fullmatch(
            r"fu-[A-Za-z0-9]+", str(proof.get("comparisonModalFunctionId", ""))
        ) is None
        or re.fullmatch(
            r"im-[A-Za-z0-9]+", str(proof.get("comparisonModalImageId", ""))
        ) is None
        or proof.get("requestCount") != COMPARISON_BURST_REQUESTS
        or proof.get("concurrencyLimit") != COMPARISON_MAX_CONCURRENT_INPUTS
        or proof["requestCount"] <= proof["concurrencyLimit"]
        or proof.get("timeoutSeconds") != COMPARISON_BURST_TIMEOUT_SECONDS
        or not isinstance(proof.get("wallDurationSeconds"), (int, float))
        or proof["wallDurationSeconds"] < 0
        or proof.get("queueObserved") is not True
        or not isinstance(proof.get("outcomes"), list)
        or len(proof["outcomes"]) != COMPARISON_BURST_REQUESTS
    ):
        raise ValueError("DiffRhythm2 comparison burst evidence is invalid")
    for index, outcome in enumerate(proof["outcomes"]):
        if (
            outcome != {
                "requestIndex": index,
                "outcome": "completed",
                "startedAfterSeconds": outcome.get("startedAfterSeconds"),
                "durationSeconds": outcome.get("durationSeconds"),
            }
            or not isinstance(outcome.get("startedAfterSeconds"), (int, float))
            or outcome["startedAfterSeconds"] < 0
            or not isinstance(outcome.get("durationSeconds"), (int, float))
            or not 0 <= outcome["durationSeconds"] <= COMPARISON_BURST_TIMEOUT_SECONDS
        ):
            raise ValueError("DiffRhythm2 comparison burst outcome is invalid")

def verify_cancelled_comparison_capacity(metadata: dict) -> dict:
    identity = observe_comparison()
    comparison = modal.Function.from_name(
        COMPARISON_APP_NAME, "drill_retained_smoke_comparison"
    )
    calls = []
    starts = []
    cancellation_acknowledged = 0
    cancellation_requests_started = False
    result = None
    probe = None
    cancellation_requested = time.time()
    with modal.Queue.ephemeral() as readiness:
        calls = [
            comparison.spawn("stall", readiness)
            for _ in range(COMPARISON_MAX_CONCURRENT_INPUTS)
        ]
        for _ in calls:
            marker = readiness.get(timeout=COMPARISON_STALL_START_BOUND_SECONDS)
            if (
                not isinstance(marker, dict)
                or marker.get("outcome") != "started"
                or not isinstance(marker.get("startedUnixSeconds"), (int, float))
                or re.fullmatch(
                    r"im-[A-Za-z0-9]+", str(marker.get("modalImageId", ""))
                ) is None
                or set(marker) != {
                    "outcome", "startedUnixSeconds", "modalImageId",
                }
            ):
                break
            starts.append(marker)
        if len(starts) == COMPARISON_MAX_CONCURRENT_INPUTS:
            cancellation_requested = time.time()
            cancellation_requests_started = True
            _, cancellation_acknowledged = cancel_calls_before_deadline(
                calls, COMPARISON_CANCEL_ACK_BOUND_SECONDS
            )
            if cancellation_acknowledged == len(calls):
                probe = comparison.spawn("probe")
                try:
                    result = probe.get(timeout=COMPARISON_RECOVERY_BOUND_SECONDS)
                except Exception:
                    result = None
    observed = time.time()
    image_ids = {marker["modalImageId"] for marker in starts}
    valid = (
        len(starts) == COMPARISON_MAX_CONCURRENT_INPUTS
        and cancellation_acknowledged == COMPARISON_MAX_CONCURRENT_INPUTS
        and len(image_ids) == 1
        and
        isinstance(result, dict)
        and result.get("outcome") == "completed"
        and isinstance(result.get("startedUnixSeconds"), (int, float))
        and isinstance(result.get("finishedUnixSeconds"), (int, float))
        and result["startedUnixSeconds"] <= result["finishedUnixSeconds"]
        and result["startedUnixSeconds"] >= cancellation_requested
        and result["startedUnixSeconds"] - cancellation_requested
        <= COMPARISON_RECOVERY_BOUND_SECONDS
        and re.fullmatch(
            r"im-[A-Za-z0-9]+", str(result.get("modalImageId", ""))
        ) is not None
        and result["modalImageId"] in image_ids
        and set(result) == {
            "outcome", "startedUnixSeconds", "finishedUnixSeconds", "modalImageId",
        }
        and observe_comparison() == identity
    )
    proof = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "workerModalDeploymentId": metadata["modalDeploymentId"],
        "comparisonModalAppId": identity["modalAppId"],
        "comparisonModalDeploymentId": identity["modalDeploymentId"],
        "comparisonModalFunctionId": identity["modalFunctionId"],
        "comparisonModalImageId": result.get("modalImageId", "") if valid else "",
        "occupiedCapacity": COMPARISON_MAX_CONCURRENT_INPUTS,
        "startedCapacity": len(starts),
        "stallStartBoundSeconds": COMPARISON_STALL_START_BOUND_SECONDS,
        "cancelAckBoundSeconds": COMPARISON_CANCEL_ACK_BOUND_SECONDS,
        "cancellationsAcknowledged": cancellation_acknowledged,
        "recoveryBoundSeconds": COMPARISON_RECOVERY_BOUND_SECONDS,
        "recoveredAfterSeconds": round(
            max(0, float(result["startedUnixSeconds"]) - cancellation_requested), 3
        ) if valid else round(max(0, observed - cancellation_requested), 3),
        "cancellationRequested": True,
        "capacityReleased": valid,
    }
    atomic_json(EVIDENCE / "live-comparison-cancellation-proof.json", proof)
    if not valid:
        if not cancellation_requests_started:
            cancel_calls_within_bound(calls, COMPARISON_CANCEL_TIMEOUT_SECONDS)
        if probe is not None:
            cancel_calls_within_bound([probe], COMPARISON_CANCEL_TIMEOUT_SECONDS)
        raise RuntimeError(
            "cancelled comparison capacity was not released within the safe bound"
        ) from None
    return proof


def validate_cancelled_comparison_capacity(proof: dict, metadata: dict) -> None:
    if (
        set(proof) != {
            "schemaVersion", "provider", "workerModalDeploymentId",
            "comparisonModalAppId", "comparisonModalDeploymentId",
            "comparisonModalFunctionId", "comparisonModalImageId",
            "occupiedCapacity", "startedCapacity", "stallStartBoundSeconds",
            "cancelAckBoundSeconds", "cancellationsAcknowledged",
            "recoveryBoundSeconds", "recoveredAfterSeconds",
            "cancellationRequested", "capacityReleased",
        }
        or proof.get("schemaVersion") != 1
        or proof.get("provider") != "DIFFRHYTHM_2"
        or proof.get("workerModalDeploymentId") != metadata["modalDeploymentId"]
        or re.fullmatch(
            r"ap-[A-Za-z0-9]+", str(proof.get("comparisonModalAppId", ""))
        ) is None
        or re.fullmatch(
            r"v[1-9][0-9]*", str(proof.get("comparisonModalDeploymentId", ""))
        ) is None
        or re.fullmatch(
            r"fu-[A-Za-z0-9]+", str(proof.get("comparisonModalFunctionId", ""))
        ) is None
        or re.fullmatch(
            r"im-[A-Za-z0-9]+", str(proof.get("comparisonModalImageId", ""))
        ) is None
        or proof.get("occupiedCapacity") != COMPARISON_MAX_CONCURRENT_INPUTS
        or proof.get("startedCapacity") != COMPARISON_MAX_CONCURRENT_INPUTS
        or proof.get("stallStartBoundSeconds")
        != COMPARISON_STALL_START_BOUND_SECONDS
        or proof.get("cancelAckBoundSeconds")
        != COMPARISON_CANCEL_ACK_BOUND_SECONDS
        or proof.get("cancellationsAcknowledged")
        != COMPARISON_MAX_CONCURRENT_INPUTS
        or proof.get("recoveryBoundSeconds") != COMPARISON_RECOVERY_BOUND_SECONDS
        or not isinstance(proof.get("recoveredAfterSeconds"), (int, float))
        or not 0 <= proof["recoveredAfterSeconds"] <= COMPARISON_RECOVERY_BOUND_SECONDS
        or proof.get("cancellationRequested") is not True
        or proof.get("capacityReleased") is not True
    ):
        raise ValueError("DiffRhythm2 comparison cancellation evidence is invalid")


def verify_cancelled_comparison_execution(metadata: dict) -> dict:
    identity = observe_comparison()
    comparison = modal.Function.from_name(
        COMPARISON_APP_NAME, "drill_retained_smoke_comparison"
    )
    call = None
    start = None
    cancellation_acknowledged = False
    cancellation_started = False
    post_work_marker_observed = False
    operational_failure = False
    with modal.Queue.ephemeral() as lifecycle:
        try:
            call = comparison.spawn("cancel_execution", lifecycle)
            marker = lifecycle.get(timeout=COMPARISON_STALL_START_BOUND_SECONDS)
            if (
                isinstance(marker, dict)
                and marker.get("outcome") == "pre_work"
                and isinstance(marker.get("startedUnixSeconds"), (int, float))
                and re.fullmatch(
                    r"im-[A-Za-z0-9]+", str(marker.get("modalImageId", ""))
                ) is not None
                and set(marker) == {
                    "outcome", "startedUnixSeconds", "modalImageId",
                }
            ):
                start = marker
                cancellation_started = True
                _, acknowledgements = cancel_calls_before_deadline(
                    [call], COMPARISON_CANCEL_ACK_BOUND_SECONDS
                )
                cancellation_acknowledged = acknowledgements == 1
                if cancellation_acknowledged:
                    try:
                        post_marker = lifecycle.get(
                            timeout=COMPARISON_EXECUTION_STOP_BOUND_SECONDS
                        )
                    except queue.Empty:
                        post_marker = None
                    post_work_marker_observed = post_marker is not None
        except Exception:
            operational_failure = True
    identity_unchanged = observe_comparison() == identity
    valid = (
        start is not None
        and cancellation_acknowledged
        and not post_work_marker_observed
        and identity_unchanged
        and not operational_failure
    )
    proof = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "workerModalDeploymentId": metadata["modalDeploymentId"],
        "comparisonModalAppId": identity["modalAppId"],
        "comparisonModalDeploymentId": identity["modalDeploymentId"],
        "comparisonModalFunctionId": identity["modalFunctionId"],
        "comparisonModalImageId": start["modalImageId"] if start else "",
        "workSeconds": COMPARISON_CANCELLATION_WORK_SECONDS,
        "observationBoundSeconds": COMPARISON_EXECUTION_STOP_BOUND_SECONDS,
        "preWorkMarkerObserved": start is not None,
        "cancellationAcknowledged": cancellation_acknowledged,
        "postWorkMarkerObserved": post_work_marker_observed,
        "executionStopped": valid,
    }
    atomic_json(
        EVIDENCE / "live-comparison-execution-cancellation-proof.json", proof
    )
    if not valid:
        if call is not None and not cancellation_started:
            cancel_calls_within_bound(
                [call], COMPARISON_CANCEL_TIMEOUT_SECONDS
            )
        raise RuntimeError(
            "cancelled comparison execution did not stop within the safe bound"
        ) from None
    return proof


def validate_cancelled_comparison_execution(proof: dict, metadata: dict) -> None:
    if (
        set(proof) != {
            "schemaVersion", "provider", "workerModalDeploymentId",
            "comparisonModalAppId", "comparisonModalDeploymentId",
            "comparisonModalFunctionId", "comparisonModalImageId",
            "workSeconds", "observationBoundSeconds", "preWorkMarkerObserved",
            "cancellationAcknowledged", "postWorkMarkerObserved",
            "executionStopped",
        }
        or proof.get("schemaVersion") != 1
        or proof.get("provider") != "DIFFRHYTHM_2"
        or proof.get("workerModalDeploymentId") != metadata["modalDeploymentId"]
        or re.fullmatch(
            r"ap-[A-Za-z0-9]+", str(proof.get("comparisonModalAppId", ""))
        ) is None
        or re.fullmatch(
            r"v[1-9][0-9]*", str(proof.get("comparisonModalDeploymentId", ""))
        ) is None
        or re.fullmatch(
            r"fu-[A-Za-z0-9]+", str(proof.get("comparisonModalFunctionId", ""))
        ) is None
        or re.fullmatch(
            r"im-[A-Za-z0-9]+", str(proof.get("comparisonModalImageId", ""))
        ) is None
        or proof.get("workSeconds") != COMPARISON_CANCELLATION_WORK_SECONDS
        or proof.get("observationBoundSeconds")
        != COMPARISON_EXECUTION_STOP_BOUND_SECONDS
        or proof.get("preWorkMarkerObserved") is not True
        or proof.get("cancellationAcknowledged") is not True
        or proof.get("postWorkMarkerObserved") is not False
        or proof.get("executionStopped") is not True
    ):
        raise ValueError(
            "DiffRhythm2 comparison execution cancellation evidence is invalid"
        )


def count_cancellation_acknowledgements(calls: list, deadline: float) -> int:
    if any(not hasattr(call, "object_id") for call in calls):
        results = _run_cancel_workers_within_bound(
            calls,
            max(0, deadline - time.monotonic()),
            _await_local_cancellation,
            (deadline,),
            deadline,
            "fork",
        )
    else:
        results = _run_acknowledgement_workers_within_bound(
            [str(call.object_id) for call in calls], deadline
        )
    return sum(result is True for result in results)


def verify_cancelled_comparison_batch_execution(metadata: dict) -> dict:
    identity = observe_comparison()
    comparison = modal.Function.from_name(
        COMPARISON_APP_NAME, "drill_retained_smoke_comparison"
    )
    calls = []
    starts = []
    cancellations_acknowledged = 0
    post_work_markers_observed = 0
    operational_failure = False
    cancellation_requests_started = False

    with modal.Queue.ephemeral() as lifecycle:
        try:
            calls = [
                comparison.spawn("cancel_execution", lifecycle)
                for _ in range(COMPARISON_MAX_CONCURRENT_INPUTS)
            ]
            for _ in calls:
                marker = lifecycle.get(timeout=COMPARISON_STALL_START_BOUND_SECONDS)
                if (
                    not isinstance(marker, dict)
                    or marker.get("outcome") != "pre_work"
                    or not isinstance(marker.get("startedUnixSeconds"), (int, float))
                    or re.fullmatch(
                        r"im-[A-Za-z0-9]+", str(marker.get("modalImageId", ""))
                    ) is None
                    or set(marker) != {
                        "outcome", "startedUnixSeconds", "modalImageId",
                    }
                ):
                    operational_failure = True
                    break
                starts.append(marker)
            if len(starts) == len(calls):
                cancellation_requests_started = True
                cancellation_requests_succeeded, cancellations_acknowledged = (
                    cancel_calls_before_deadline(
                        calls, COMPARISON_CANCEL_ACK_BOUND_SECONDS
                    )
                )
                if cancellation_requests_succeeded != len(calls):
                    operational_failure = True
                if cancellations_acknowledged == len(calls):
                    deadline = (
                        time.monotonic() + COMPARISON_EXECUTION_STOP_BOUND_SECONDS
                    )
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        try:
                            marker = lifecycle.get(timeout=remaining)
                        except queue.Empty:
                            break
                        if marker is None:
                            break
                        post_work_markers_observed += 1
        except Exception:
            operational_failure = True
    image_ids = {marker["modalImageId"] for marker in starts}
    identity_unchanged = observe_comparison() == identity
    valid = (
        len(starts) == COMPARISON_MAX_CONCURRENT_INPUTS
        and cancellations_acknowledged == COMPARISON_MAX_CONCURRENT_INPUTS
        and post_work_markers_observed == 0
        and len(image_ids) == 1
        and identity_unchanged
        and not operational_failure
    )
    proof = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "workerModalDeploymentId": metadata["modalDeploymentId"],
        "comparisonModalAppId": identity["modalAppId"],
        "comparisonModalDeploymentId": identity["modalDeploymentId"],
        "comparisonModalFunctionId": identity["modalFunctionId"],
        "comparisonModalImageId": next(iter(image_ids), "") if valid else "",
        "occupiedCapacity": COMPARISON_MAX_CONCURRENT_INPUTS,
        "preWorkMarkersObserved": len(starts),
        "cancellationsAcknowledged": cancellations_acknowledged,
        "workSeconds": COMPARISON_CANCELLATION_WORK_SECONDS,
        "observationBoundSeconds": COMPARISON_EXECUTION_STOP_BOUND_SECONDS,
        "postWorkMarkersObserved": post_work_markers_observed,
        "allExecutionsStopped": valid,
    }
    atomic_json(
        EVIDENCE / "live-comparison-batch-execution-cancellation-proof.json", proof
    )
    if not valid:
        if not cancellation_requests_started:
            cancel_calls_within_bound(calls, COMPARISON_CANCEL_TIMEOUT_SECONDS)
        raise RuntimeError(
            "cancelled comparison batch did not stop within the safe bound"
        ) from None
    return proof


def validate_cancelled_comparison_batch_execution(
    proof: dict, metadata: dict
) -> None:
    if (
        set(proof) != {
            "schemaVersion", "provider", "workerModalDeploymentId",
            "comparisonModalAppId", "comparisonModalDeploymentId",
            "comparisonModalFunctionId", "comparisonModalImageId",
            "occupiedCapacity", "preWorkMarkersObserved",
            "cancellationsAcknowledged", "workSeconds",
            "observationBoundSeconds", "postWorkMarkersObserved",
            "allExecutionsStopped",
        }
        or proof.get("schemaVersion") != 1
        or proof.get("provider") != "DIFFRHYTHM_2"
        or proof.get("workerModalDeploymentId") != metadata["modalDeploymentId"]
        or re.fullmatch(
            r"ap-[A-Za-z0-9]+", str(proof.get("comparisonModalAppId", ""))
        ) is None
        or re.fullmatch(
            r"v[1-9][0-9]*", str(proof.get("comparisonModalDeploymentId", ""))
        ) is None
        or re.fullmatch(
            r"fu-[A-Za-z0-9]+", str(proof.get("comparisonModalFunctionId", ""))
        ) is None
        or re.fullmatch(
            r"im-[A-Za-z0-9]+", str(proof.get("comparisonModalImageId", ""))
        ) is None
        or proof.get("occupiedCapacity") != COMPARISON_MAX_CONCURRENT_INPUTS
        or proof.get("preWorkMarkersObserved") != COMPARISON_MAX_CONCURRENT_INPUTS
        or proof.get("cancellationsAcknowledged")
        != COMPARISON_MAX_CONCURRENT_INPUTS
        or proof.get("workSeconds") != COMPARISON_CANCELLATION_WORK_SECONDS
        or proof.get("observationBoundSeconds")
        != COMPARISON_EXECUTION_STOP_BOUND_SECONDS
        or proof.get("postWorkMarkersObserved") != 0
        or proof.get("allExecutionsStopped") is not True
    ):
        raise ValueError(
            "DiffRhythm2 comparison batch cancellation evidence is invalid"
        )


def validate_cancelled_comparison_timing(proof: dict, metadata: dict) -> None:
    if (
        set(proof) != {
            "schemaVersion", "provider", "workerModalDeploymentId",
            "controlledBatchCount", "proofCount", "wallDurationSeconds",
            "wallDurationBoundSeconds",
        }
        or proof.get("schemaVersion") != 1
        or proof.get("provider") != "DIFFRHYTHM_2"
        or proof.get("workerModalDeploymentId") != metadata["modalDeploymentId"]
        or proof.get("controlledBatchCount") != 1
        or proof.get("proofCount") != 3
        or proof.get("wallDurationBoundSeconds")
        != COMPARISON_CANCELLATION_SUITE_BOUND_SECONDS
        or not isinstance(proof.get("wallDurationSeconds"), (int, float))
        or not 0 <= proof["wallDurationSeconds"] <= proof["wallDurationBoundSeconds"]
    ):
        raise ValueError("DiffRhythm2 cancellation timing evidence is invalid")


def verify_cancelled_comparison_drills(metadata: dict) -> tuple[dict, dict, dict, dict]:
    """Capture all cancellation guarantees from one controlled capacity batch."""
    suite_started = time.monotonic()
    identity = observe_comparison()
    comparison = modal.Function.from_name(
        COMPARISON_APP_NAME, "drill_retained_smoke_comparison"
    )
    calls = []
    starts = []
    cancellations_acknowledged = 0
    post_work_markers_observed = 0
    operational_failure = False
    result = None
    probe = None
    cancellation_requested = time.time()
    cancellation_started = False

    with modal.Queue.ephemeral() as lifecycle:
        try:
            for _ in range(COMPARISON_MAX_CONCURRENT_INPUTS):
                calls.append(comparison.spawn("cancel_execution", lifecycle))
            for _ in calls:
                marker = lifecycle.get(timeout=COMPARISON_STALL_START_BOUND_SECONDS)
                if (
                    not isinstance(marker, dict)
                    or marker.get("outcome") != "pre_work"
                    or not isinstance(marker.get("startedUnixSeconds"), (int, float))
                    or re.fullmatch(
                        r"im-[A-Za-z0-9]+", str(marker.get("modalImageId", ""))
                    ) is None
                    or set(marker) != {
                        "outcome", "startedUnixSeconds", "modalImageId",
                    }
                ):
                    operational_failure = True
                    break
                starts.append(marker)
            if len(starts) == len(calls):
                cancellation_requested = time.time()
                cancellation_started = True
                requests_succeeded, cancellations_acknowledged = (
                    cancel_calls_before_deadline(
                        calls, COMPARISON_CANCEL_ACK_BOUND_SECONDS
                    )
                )
                if requests_succeeded != len(calls):
                    operational_failure = True
                if cancellations_acknowledged == len(calls):
                    deadline = (
                        time.monotonic() + COMPARISON_EXECUTION_STOP_BOUND_SECONDS
                    )
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        try:
                            marker = lifecycle.get(timeout=remaining)
                        except queue.Empty:
                            break
                        if marker is None:
                            break
                        post_work_markers_observed += 1
                    if post_work_markers_observed == 0:
                        probe = comparison.spawn("probe")
                        try:
                            result = probe.get(timeout=COMPARISON_RECOVERY_BOUND_SECONDS)
                        except Exception:
                            result = None
        except Exception:
            operational_failure = True
        if calls and not cancellation_started:
            cancellation_started = True
            cancel_calls_within_bound(calls, COMPARISON_CANCEL_TIMEOUT_SECONDS)

    observed = time.time()
    image_ids = {marker["modalImageId"] for marker in starts}
    identity_unchanged = observe_comparison() == identity
    batch_valid = (
        len(starts) == COMPARISON_MAX_CONCURRENT_INPUTS
        and cancellations_acknowledged == COMPARISON_MAX_CONCURRENT_INPUTS
        and post_work_markers_observed == 0
        and len(image_ids) == 1
        and identity_unchanged
        and not operational_failure
    )
    capacity_valid = (
        batch_valid
        and isinstance(result, dict)
        and result.get("outcome") == "completed"
        and isinstance(result.get("startedUnixSeconds"), (int, float))
        and isinstance(result.get("finishedUnixSeconds"), (int, float))
        and result["startedUnixSeconds"] <= result["finishedUnixSeconds"]
        and result["startedUnixSeconds"] >= cancellation_requested
        and result["startedUnixSeconds"] - cancellation_requested
        <= COMPARISON_RECOVERY_BOUND_SECONDS
        and result.get("modalImageId") in image_ids
        and set(result) == {
            "outcome", "startedUnixSeconds", "finishedUnixSeconds", "modalImageId",
        }
    )
    comparison_image_id = next(iter(image_ids), "") if batch_valid else ""
    capacity = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "workerModalDeploymentId": metadata["modalDeploymentId"],
        "comparisonModalAppId": identity["modalAppId"],
        "comparisonModalDeploymentId": identity["modalDeploymentId"],
        "comparisonModalFunctionId": identity["modalFunctionId"],
        "comparisonModalImageId": result.get("modalImageId", "") if capacity_valid else "",
        "occupiedCapacity": COMPARISON_MAX_CONCURRENT_INPUTS,
        "startedCapacity": len(starts),
        "stallStartBoundSeconds": COMPARISON_STALL_START_BOUND_SECONDS,
        "cancelAckBoundSeconds": COMPARISON_CANCEL_ACK_BOUND_SECONDS,
        "cancellationsAcknowledged": cancellations_acknowledged,
        "recoveryBoundSeconds": COMPARISON_RECOVERY_BOUND_SECONDS,
        "recoveredAfterSeconds": round(
            max(0, float(result["startedUnixSeconds"]) - cancellation_requested), 3
        ) if capacity_valid else round(max(0, observed - cancellation_requested), 3),
        "cancellationRequested": True,
        "capacityReleased": capacity_valid,
    }
    execution = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "workerModalDeploymentId": metadata["modalDeploymentId"],
        "comparisonModalAppId": identity["modalAppId"],
        "comparisonModalDeploymentId": identity["modalDeploymentId"],
        "comparisonModalFunctionId": identity["modalFunctionId"],
        "comparisonModalImageId": comparison_image_id,
        "workSeconds": COMPARISON_CANCELLATION_WORK_SECONDS,
        "observationBoundSeconds": COMPARISON_EXECUTION_STOP_BOUND_SECONDS,
        "preWorkMarkerObserved": bool(starts),
        "cancellationAcknowledged": cancellations_acknowledged > 0,
        "postWorkMarkerObserved": post_work_markers_observed > 0,
        "executionStopped": batch_valid,
    }
    batch = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "workerModalDeploymentId": metadata["modalDeploymentId"],
        "comparisonModalAppId": identity["modalAppId"],
        "comparisonModalDeploymentId": identity["modalDeploymentId"],
        "comparisonModalFunctionId": identity["modalFunctionId"],
        "comparisonModalImageId": comparison_image_id,
        "occupiedCapacity": COMPARISON_MAX_CONCURRENT_INPUTS,
        "preWorkMarkersObserved": len(starts),
        "cancellationsAcknowledged": cancellations_acknowledged,
        "workSeconds": COMPARISON_CANCELLATION_WORK_SECONDS,
        "observationBoundSeconds": COMPARISON_EXECUTION_STOP_BOUND_SECONDS,
        "postWorkMarkersObserved": post_work_markers_observed,
        "allExecutionsStopped": batch_valid,
    }
    timing = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "workerModalDeploymentId": metadata["modalDeploymentId"],
        "controlledBatchCount": 1,
        "proofCount": 3,
        "wallDurationSeconds": round(time.monotonic() - suite_started, 3),
        "wallDurationBoundSeconds": COMPARISON_CANCELLATION_SUITE_BOUND_SECONDS,
    }
    for name, proof in (
        ("live-comparison-cancellation-proof.json", capacity),
        ("live-comparison-execution-cancellation-proof.json", execution),
        ("live-comparison-batch-execution-cancellation-proof.json", batch),
        ("live-comparison-cancellation-timing-proof.json", timing),
    ):
        atomic_json(EVIDENCE / name, proof)
    try:
        validate_cancelled_comparison_capacity(capacity, metadata)
        validate_cancelled_comparison_execution(execution, metadata)
        validate_cancelled_comparison_batch_execution(batch, metadata)
        validate_cancelled_comparison_timing(timing, metadata)
    except ValueError:
        raise RuntimeError(
            "consolidated comparison cancellation drills failed within a safe bound"
        ) from None
    return capacity, execution, batch, timing
def validate_release(release: dict) -> dict:
    metadata = {
        field: release.get(field)
        for field in (
            "provider", "modalAppId", "modalDeploymentId",
            "modalFunctionId", "endpointOrigin",
        )
    }
    health = release.get("liveHealth")
    proof = release.get("liveResearchGeneration")
    burst = release.get("liveComparisonBurst")
    cancellation = release.get("liveComparisonCancellation")
    execution_cancellation = release.get("liveComparisonExecutionCancellation")
    batch_execution_cancellation = release.get(
        "liveComparisonBatchExecutionCancellation"
    )
    cancellation_timing = release.get("liveComparisonCancellationTiming")
    if not all(
        isinstance(item, dict)
        for item in (
            health, proof, burst, cancellation, execution_cancellation,
            batch_execution_cancellation, cancellation_timing,
        )
    ):
        raise ValueError(
            "DiffRhythm2 release lacks live health, generation, or comparison proof"
        )
    if (
        release.get("provider") != "DIFFRHYTHM_2"
        or release.get("licenseStatus") != "RESEARCH_ONLY"
        or release.get("commercialUsePermitted") is not False
        or any(
            health.get(field) != release.get(field)
            for field in ("modalAppId", "modalDeploymentId", "modalFunctionId", "modalImageId")
        )
        or health.get("ready") is not True
        or health.get("healthy") is not True
    ):
        raise ValueError("DiffRhythm2 release identity or readiness is invalid")
    validate_generation_proof(proof, metadata, health)
    validate_comparison_burst(burst, metadata)
    validate_cancelled_comparison_capacity(cancellation, metadata)
    validate_cancelled_comparison_execution(execution_cancellation, metadata)
    validate_cancelled_comparison_batch_execution(
        batch_execution_cancellation, metadata
    )
    validate_cancelled_comparison_timing(cancellation_timing, metadata)
    codec_evidence = validate_codec_evidence(health)
    codec_path = EVIDENCE / "codec-threshold-evidence.json"
    if (
        release.get("codecThresholdEvidence") != codec_evidence
        or json.loads(codec_path.read_text()) != codec_evidence
        or release.get("retainedEvidence", {}).get(codec_path.name)
        != {"sha256": sha256(codec_path), "bytes": codec_path.stat().st_size}
    ):
        raise ValueError("DiffRhythm2 codec threshold evidence digest is not retained")
    for name, expected in (
        ("live-research-generation-proof.json", proof),
        ("live-comparison-burst-proof.json", burst),
        ("live-comparison-cancellation-proof.json", cancellation),
        (
            "live-comparison-execution-cancellation-proof.json",
            execution_cancellation,
        ),
        (
            "live-comparison-batch-execution-cancellation-proof.json",
            batch_execution_cancellation,
        ),
        ("live-comparison-cancellation-timing-proof.json", cancellation_timing),
    ):
        path = EVIDENCE / name
        if (
            json.loads(path.read_text()) != expected
            or release.get("retainedEvidence", {}).get(path.name)
            != {"sha256": sha256(path), "bytes": path.stat().st_size}
        ):
            raise ValueError(f"DiffRhythm2 {name} digest is not retained")
    return release


def capture(metadata: dict) -> dict:
    health = fetch_health(metadata)
    codec_evidence = validate_codec_evidence(health)
    (
        cancellation,
        execution_cancellation,
        batch_execution_cancellation,
        cancellation_timing,
    ) = verify_cancelled_comparison_drills(
        metadata
    )
    burst = verify_comparison_burst(metadata)
    generation = verify_research_generation(metadata, health)
    if observe() != metadata:
        raise ValueError("DiffRhythm2 deployment identity changed during capture")
    atomic_json(EVIDENCE / "live-health.json", health)
    atomic_json(EVIDENCE / "codec-threshold-evidence.json", codec_evidence)
    retained_names = (
        "model-assets.json",
        "known-good-short-smoke-proof.json",
        "known-good-short-output.mp3",
        "known-good-short-diagnostic.json",
        "full-fixture-smoke-proof.json",
        "full-fixture-output.mp3",
        "full-fixture-diagnostic.json",
        "live-research-generation-proof.json",
        "live-comparison-burst-proof.json",
        "live-comparison-cancellation-proof.json",
        "live-comparison-execution-cancellation-proof.json",
        "live-comparison-batch-execution-cancellation-proof.json",
        "live-comparison-cancellation-timing-proof.json",
        "codec-threshold-evidence.json",
    )
    retained = {}
    for name in retained_names:
        path = EVIDENCE / name
        retained[name] = {"sha256": sha256(path), "bytes": path.stat().st_size}
    release = {
        "schemaVersion": 1,
        **metadata,
        "modalImageId": health["modalImageId"],
        "modelVersion": health["modelVersion"],
        "checkpointRevision": health["revision"],
        "checkpointSha256": health["checkpointSha256"],
        "sourceRevision": health["sourceRevision"],
        "sourceImageDigest": health["sourceImageDigest"],
        "licenseStatus": "RESEARCH_ONLY",
        "commercialUsePermitted": False,
        "codecThresholdEvidence": codec_evidence,
        "retainedEvidence": retained,
        "liveHealth": health,
        "liveResearchGeneration": generation,
        "liveComparisonBurst": burst,
        "liveComparisonCancellation": cancellation,
        "liveComparisonExecutionCancellation": execution_cancellation,
        "liveComparisonBatchExecutionCancellation": batch_execution_cancellation,
        "liveComparisonCancellationTiming": cancellation_timing,
    }
    atomic_json(EVIDENCE / "release-evidence.json", release)
    return validate_release(release)


def private_key() -> tuple[Path, bool]:
    material = os.getenv("MUSIC_GPU_PROMOTION_SIGNING_KEY", "").strip()
    if not material:
        raise ValueError("promotion signing key is unavailable")
    try:
        raw = base64.b64decode(material, validate=True)
    except ValueError as exc:
        raise ValueError("promotion signing key is not base64") from exc
    seed = raw if len(raw) == 32 else hashlib.sha256(
        KEY_DERIVATION_DOMAIN + raw
    ).digest()
    result = subprocess.run(
        ["openssl", "pkey", "-inform", "DER", "-outform", "PEM"],
        input=ED25519_PKCS8_PREFIX + seed,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError("Ed25519 key normalization failed")
    handle = tempfile.NamedTemporaryFile(mode="wb", delete=False)
    handle.write(result.stdout)
    handle.close()
    os.chmod(handle.name, 0o600)
    return Path(handle.name), True


def sign(record: dict, key: Path) -> str:
    with tempfile.NamedTemporaryFile(mode="wb", delete=False) as handle:
        handle.write(canonical(record).encode())
        message = Path(handle.name)
    try:
        result = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-sign",
                "-rawin",
                "-inkey",
                str(key),
                "-in",
                str(message),
            ],
            capture_output=True,
            check=False,
        )
    finally:
        message.unlink(missing_ok=True)
    if result.returncode or len(result.stdout) != 64:
        raise RuntimeError("DiffRhythm2 Ed25519 signing failed")
    return base64.b64encode(result.stdout).decode()


def promote(release: dict) -> tuple[dict, str]:
    validate_release(release)
    health = release["liveHealth"]
    record = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "modalAppId": release["modalAppId"],
        "modalDeploymentId": release["modalDeploymentId"],
        "modalFunctionId": release["modalFunctionId"],
        "modalImageId": release["modalImageId"],
        "endpointOrigin": release["endpointOrigin"],
        "modelVersion": release["modelVersion"],
        "checkpointSha256": release["checkpointSha256"],
        "checkpointRevision": release["checkpointRevision"],
        "sourceRevision": release["sourceRevision"],
        "sourceImageDigest": release["sourceImageDigest"],
        "releaseEvidenceSha256": hashlib.sha256(
            canonical(release).encode()
        ).hexdigest(),
        "runtime": {
            "python": health["runtime"]["pythonVersion"],
            "cudaImage": health["framework"]["cuda_image"],
            "cuda": health["framework"]["cuda"],
            "pytorch": health["framework"]["pytorch"],
            "torchvision": health["framework"]["torchvision"],
            "torchaudio": health["framework"]["torchaudio"],
            "torchIndexUrl": health["framework"]["torch_index_url"],
            "transformers": health["framework"]["transformers"],
            "accelerate": health["framework"]["accelerate"],
        },
    }
    key, temporary = private_key()
    try:
        bundle = {"record": record, "signature": sign(record, key)}
        public = subprocess.run(
            ["openssl", "pkey", "-in", str(key), "-pubout"],
            capture_output=True,
            check=True,
        ).stdout.decode()
    finally:
        if temporary:
            key.unlink(missing_ok=True)
    atomic_json(EVIDENCE / "promotion-bundle.json", bundle)
    (EVIDENCE / "promotion-public-key.pem").write_text(public)
    return bundle, public


def activate(bundle: dict, public: str, release: dict) -> None:
    validate_release(release)
    if bundle.get("record", {}).get("releaseEvidenceSha256") != hashlib.sha256(
        canonical(release).encode()
    ).hexdigest():
        raise ValueError("DiffRhythm2 promotion does not bind retained release evidence")
    match = re.fullmatch(
        r"/\* Generated by the fail-closed generic Modal release workflow\. \*/\n"
        r"export const committedGpuPromotionsJson = (.+);\n",
        GENERATED.read_text(),
    )
    if not match:
        raise ValueError("canonical promotions file is malformed")
    collection = json.loads(json.loads(match.group(1)))
    if collection.get("publicKey", "").strip() != public.strip():
        raise ValueError("DiffRhythm2 signing key differs from canonical promotion key")
    collection["bundles"]["DIFFRHYTHM_2"] = bundle
    GENERATED.write_text(
        "/* Generated by the fail-closed generic Modal release workflow. */\n"
        f"export const committedGpuPromotionsJson = {json.dumps(canonical(collection))};\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=(
            "observe", "install-identity", "capture", "canary", "promote", "activate"
        ),
    )
    args = parser.parse_args()
    metadata_path = EVIDENCE / "observed-deployment.json"
    if args.command == "observe":
        atomic_json(metadata_path, observe())
    elif args.command == "install-identity":
        install_identity(json.loads(metadata_path.read_text()))
    elif args.command == "capture":
        capture(json.loads(metadata_path.read_text()))
    elif args.command == "canary":
        verify_research_generation(json.loads(metadata_path.read_text()))
    elif args.command == "promote":
        promote(json.loads((EVIDENCE / "release-evidence.json").read_text()))
    else:
        activate(
            json.loads((EVIDENCE / "promotion-bundle.json").read_text()),
            (EVIDENCE / "promotion-public-key.pem").read_text(),
            json.loads((EVIDENCE / "release-evidence.json").read_text()),
        )


if __name__ == "__main__":
    main()
