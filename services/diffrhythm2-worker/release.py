"""Observe, attest, and promote one exact DiffRhythm2 research deployment."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
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
from pathlib import Path
from urllib.parse import urlsplit

import modal

from modal_config import APP_NAME, PROMOTION_SECRET_NAME
from comparison_resources import COMPARISON_MAX_CONCURRENT_INPUTS

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
COMPARISON_CANCEL_TIMEOUT_SECONDS = 0.25


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
    cancellations = queue.Queue()
    calls = {}

    def await_comparison(index: int, call) -> None:
        try:
            results.put((index, call.get()))
        except Exception:
            results.put((index, None))

    def cancel_comparison(index: int, call) -> None:
        try:
            call.cancel()
            cancellations.put((index, True))
        except Exception:
            cancellations.put((index, False))

    for index in range(COMPARISON_BURST_REQUESTS):
        try:
            call = comparison.spawn()
        except Exception:
            results.put((index, None))
            continue
        calls[index] = call
        threading.Thread(
            target=await_comparison, args=(index, call), daemon=True
        ).start()

    deadline = time.monotonic() + COMPARISON_BURST_TIMEOUT_SECONDS
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
    cancellable = {index for index in pending if index in calls}
    for index in cancellable:
        call = calls.get(index)
        threading.Thread(
            target=cancel_comparison, args=(index, call), daemon=True
        ).start()
    cancellation_deadline = time.monotonic() + COMPARISON_CANCEL_TIMEOUT_SECONDS
    cancellation_failed = set(pending - cancellable)
    awaiting_cancellation = set(cancellable)
    while awaiting_cancellation:
        remaining = cancellation_deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            index, succeeded = cancellations.get(timeout=remaining)
        except queue.Empty:
            break
        if index not in awaiting_cancellation:
            continue
        awaiting_cancellation.remove(index)
        if not succeeded:
            cancellation_failed.add(index)
    cancellation_failed.update(awaiting_cancellation)
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
    if not all(isinstance(item, dict) for item in (health, proof, burst)):
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
    for name, expected in (
        ("live-research-generation-proof.json", proof),
        ("live-comparison-burst-proof.json", burst),
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
    burst = verify_comparison_burst(metadata)
    generation = verify_research_generation(metadata, health)
    if observe() != metadata:
        raise ValueError("DiffRhythm2 deployment identity changed during capture")
    atomic_json(EVIDENCE / "live-health.json", health)
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
        "retainedEvidence": retained,
        "liveHealth": health,
        "liveResearchGeneration": generation,
        "liveComparisonBurst": burst,
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