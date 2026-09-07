from __future__ import annotations

import hashlib
import hmac
import importlib.metadata
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import sys
import time
import urllib.request
import wave
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from inference import InferenceError, run

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
LICENSE = json.loads((ROOT / "license_manifest.json").read_text())
ASSETS = Path(os.getenv("ANYACCOMP_ASSET_ROOT", SPEC["asset_root"]))
ARTIFACTS = Path(os.getenv("ANYACCOMP_ARTIFACT_ROOT", SPEC["artifact_root"]))
MAX_SOURCE_BYTES = 64 * 1024 * 1024
CAPABILITY_TTL_SECONDS = 3600


class GenerateRequest(BaseModel):
    provider: str
    prompt: str = ""
    vocalSource: dict


def allowed_source_origins() -> set[str]:
    origins = {
        origin.strip().rstrip("/")
        for origin in os.getenv("ANYACCOMP_ALLOWED_SOURCE_ORIGINS", "").split(",")
        if origin.strip()
    }
    return {
        origin for origin in origins
        if re.fullmatch(r"https://[A-Za-z0-9.-]+", origin)
    }


def canonical_public_origin(value: str) -> str | None:
    parsed = urlparse(value.strip())
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        return None
    return f"https://{parsed.hostname.lower()}" + (
        f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    )


def public_artifact_origin_state() -> tuple[str, bool]:
    configured = canonical_public_origin(
        os.getenv("ANYACCOMP_PUBLIC_ORIGIN", "")
    )
    promoted = canonical_public_origin(
        os.getenv("MUSIC_GPU_PROMOTION_ENDPOINT_ORIGIN", "")
    )
    return configured or "", configured is not None and configured == promoted


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def verify_entries(root: Path, entries: object) -> bool:
    return isinstance(entries, list) and all(
        isinstance(entry, dict)
        and isinstance(entry.get("path"), str)
        and (path := root / entry["path"]).is_file()
        and path.stat().st_size == entry.get("bytes")
        and digest(path) == entry.get("sha256")
        for entry in entries
    )


def asset_state() -> dict:
    inventory_path = ASSETS / SPEC["asset_manifest"]
    proof_path = ASSETS / SPEC["smoke_proof"]
    fixture_path = ASSETS / "fixtures/authorized-procedural-vocal.wav"
    fixture_auth_path = ASSETS / "fixtures/fixture-authorization.json"
    try:
        inventory = json.loads(inventory_path.read_text())
        source_files = inventory["source"]["files"]
        weight_files = inventory["weights"]["files"]
        source_ready = (
            inventory["source"]["checkedOutRevision"] == SPEC["source"]["revision"]
            and inventory["source"]["observedGitTree"] == SPEC["source"]["git_tree"]
            and inventory["source"]["treeSha256"]
            == SPEC["source"]["file_inventory_sha256"]
            and canonical_sha256(source_files) == SPEC["source"]["file_inventory_sha256"]
            and verify_entries(ASSETS / "source", source_files)
        )
        checkpoint_sha = canonical_sha256(weight_files)
        checkpoint_ready = (
            inventory["weights"]["revision"] == SPEC["weights"]["revision"]
            and checkpoint_sha == SPEC["weights"]["checkpoint_set_sha256"]
            and inventory["weights"]["treeSha256"] == checkpoint_sha
            and verify_entries(ASSETS / "weights", weight_files)
        )
        license_ready = (
            LICENSE["commercial_use_permitted"] is True
            and LICENSE["environment_values_are_authorization_evidence"] is False
            and inventory["licenseStatus"] == "COMMERCIAL"
            and inventory["licenseEvidenceSha256"]
            == LICENSE["license_evidence_sha256"]
        )
        authorization = json.loads(fixture_auth_path.read_text())
        fixture_ready = (
            fixture_path.is_file()
            and authorization["sha256"] == digest(fixture_path)
            and authorization["containsExternalRecording"] is False
            and authorization["containsBiologicalVoice"] is False
            and authorization["authorizationScope"]
            == "private AnyAccomp validation and regression testing only"
        )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return {
            "assetsReady": False,
            "sourceReady": False,
            "checkpointReady": False,
            "licenseReady": False,
            "fixtureReady": False,
            "smokeTested": False,
            "checkpointSha256": SPEC["weights"]["checkpoint_set_sha256"],
        }

    smoke_tested = False
    try:
        proof = json.loads(proof_path.read_text())
        output = proof["output"]
        smoke_tested = (
            proof["schemaVersion"] == 2
            and proof["provider"] == SPEC["provider"]
            and proof["modelVersion"] == SPEC["model_version"]
            and proof["checkpointSha256"] == checkpoint_sha
            and proof["checkpointRevision"] == SPEC["weights"]["revision"]
            and proof["sourceRevision"] == SPEC["source"]["revision"]
            and proof["sourceGitTree"] == SPEC["source"]["git_tree"]
            and proof["licenseEvidenceSha256"] == inventory["licenseEvidenceSha256"]
            and proof["input"]["sha256"] == authorization["sha256"]
            and proof["input"]["authorization"]["authorizationScope"]
            == "private AnyAccomp validation and regression testing only"
            and proof["smokeTested"] is True
            and output["finiteSamples"] is True
            and output["notCopy"] is True
            and output["peakAmplitude"] >= 1e-5
            and output["rmsAmplitude"] >= 1e-7
            and math.isfinite(output["inputCorrelation"])
            and abs(output["inputCorrelation"]) <= 0.995
            and output["normalizedDifference"] >= 0.05
            and digest(ASSETS / "smoke-output.wav") == output["sha256"]
        )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        smoke_tested = False
    return {
        "assetsReady": source_ready and checkpoint_ready and license_ready,
        "sourceReady": source_ready,
        "checkpointReady": checkpoint_ready,
        "licenseReady": license_ready,
        "fixtureReady": fixture_ready,
        "smokeTested": smoke_tested,
        "checkpointSha256": checkpoint_sha,
    }


def runtime_state() -> dict:
    framework = {
        "python": SPEC["runtime"]["python"],
        "cuda_image": SPEC["runtime"]["cuda_image"],
        "cuda": SPEC["runtime"]["cuda"],
        "pytorch": SPEC["runtime"]["pytorch"],
        "torchvision": SPEC["runtime"]["torchvision"],
        "torchaudio": SPEC["runtime"]["torchaudio"],
        "torch_index_url": SPEC["runtime"]["torch_index_url"],
        "transformers": SPEC["runtime"]["transformers"],
        "accelerate": SPEC["runtime"]["accelerate"],
    }
    try:
        import torch

        runtime = {
            "pythonVersion": ".".join(map(str, sys.version_info[:3])),
            "pytorchVersion": torch.__version__,
            "cudaVersion": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "",
            "gpuReady": torch.cuda.is_available(),
            "modalImageId": os.getenv("MODAL_IMAGE_ID", ""),
            "sourceImageDigest": os.getenv("MUSIC_GPU_CONTAINER_DIGEST", ""),
        }
        ready = (
            runtime["pythonVersion"] == framework["python"]
            and runtime["pytorchVersion"] == framework["pytorch"]
            and importlib.metadata.version("torchvision") == framework["torchvision"]
            and importlib.metadata.version("torchaudio") == framework["torchaudio"]
            and importlib.metadata.version("transformers") == framework["transformers"]
            and importlib.metadata.version("accelerate") == framework["accelerate"]
            and runtime["cudaVersion"] == framework["cuda"]
            and runtime["gpuReady"] is True
            and runtime["modalImageId"].startswith("im-")
            and runtime["sourceImageDigest"].startswith("sha256:")
        )
    except Exception:
        runtime = {
            "pythonVersion": ".".join(map(str, sys.version_info[:3])),
            "pytorchVersion": "",
            "cudaVersion": "",
            "gpu": "",
            "gpuReady": False,
            "modalImageId": os.getenv("MODAL_IMAGE_ID", ""),
            "sourceImageDigest": os.getenv("MUSIC_GPU_CONTAINER_DIGEST", ""),
        }
        ready = False
    return {"ready": ready, "runtime": runtime, "framework": framework}


def require_bearer(request: Request) -> None:
    expected = os.getenv("ANYACCOMP_API_TOKEN", "")
    if not expected:
        raise HTTPException(503, "worker token is not configured")
    supplied = request.headers.get("Authorization", "")
    if not hmac.compare_digest(supplied, f"Bearer {expected}"):
        raise HTTPException(401, "unauthorized")


app = FastAPI(title="AnyAccomp Worker")


def health_payload() -> dict:
    assets = asset_state()
    runtime = runtime_state()
    modal_app_id = os.getenv("MUSIC_GPU_MODAL_APP_ID", "")
    modal_deployment_id = os.getenv("MUSIC_GPU_MODAL_DEPLOYMENT_ID", "")
    modal_function_id = os.getenv("MUSIC_GPU_MODAL_FUNCTION_ID", "")
    identity_ready = (
        re.fullmatch(r"ap-[A-Za-z0-9]+", modal_app_id) is not None
        and modal_app_id != "ap-Pending"
        and re.fullmatch(r"v[1-9][0-9]*", modal_deployment_id) is not None
        and re.fullmatch(r"fu-[A-Za-z0-9]+", modal_function_id) is not None
        and modal_function_id != "fu-Pending"
    )
    source_origins_ready = bool(allowed_source_origins())
    public_artifact_origin, artifact_origin_ready = public_artifact_origin_state()
    ready = (
        assets["assetsReady"]
        and assets["fixtureReady"]
        and assets["smokeTested"]
        and runtime["ready"]
        and identity_ready
        and source_origins_ready
        and artifact_origin_ready
    )
    source_image_digest = runtime["runtime"]["sourceImageDigest"]
    modal_image_id = runtime["runtime"]["modalImageId"]
    smoke_evidence = None
    if assets["smokeTested"]:
        try:
            smoke_evidence = json.loads((ASSETS / SPEC["smoke_proof"]).read_text())
        except (OSError, json.JSONDecodeError):
            smoke_evidence = None
    return {
        "provider": SPEC["provider"],
        "status": "ready" if ready else "blocked",
        "ready": ready,
        "healthy": ready,
        "retryable": False,
        "retryAfterSeconds": None,
        "message": "verified AnyAccomp runtime is ready" if ready
        else "AnyAccomp retained asset, runtime, identity, or smoke evidence is incomplete",
        "modelVersion": SPEC["model_version"],
        "version": SPEC["model_version"],
        "revision": f"{SPEC['weights']['repository']}@{SPEC['weights']['revision']}",
        "sourceRevision": SPEC["source"]["revision"],
        "checkpointSha256": assets["checkpointSha256"],
        "checksum": assets["checkpointSha256"],
        "sourceImageDigest": source_image_digest,
        "containerDigest": source_image_digest,
        "modalImageId": modal_image_id,
        "modalAppId": modal_app_id,
        "modalDeploymentId": modal_deployment_id,
        "modalFunctionId": modal_function_id,
        "runtime": runtime["runtime"],
        "framework": runtime["framework"],
        "gpuReady": runtime["runtime"]["gpuReady"],
        "runtimeReady": runtime["ready"],
        "packageReady": runtime["ready"],
        "checkpointReady": assets["checkpointReady"],
        "sourceReady": assets["sourceReady"],
        "licenseReady": assets["licenseReady"],
        "fixtureReady": assets["fixtureReady"],
        "smokeTested": assets["smokeTested"],
        "identityReady": identity_ready,
        "sourceOriginsReady": source_origins_ready,
        "publicArtifactOrigin": public_artifact_origin,
        "artifactOriginReady": artifact_origin_ready,
        "smokeEvidence": smoke_evidence,
    }


@app.get("/health", dependencies=[Depends(require_bearer)])
def health() -> dict:
    return health_payload()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_source_url(value: str) -> str:
    parsed = urlparse(value)
    allowed = allowed_source_origins()
    origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or origin not in allowed
    ):
        raise HTTPException(400, "vocal source origin is not authorized")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443)
        if any(
            not ipaddress.ip_address(address[4][0]).is_global for address in addresses
        ):
            raise HTTPException(400, "vocal source does not resolve to public addresses")
    except socket.gaierror as exc:
        raise HTTPException(400, "vocal source host did not resolve") from exc
    return value


def download_source(url: str, destination: Path) -> None:
    request = urllib.request.Request(validate_source_url(url), headers={"Accept": "audio/*"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
            if response.status != 200 or response.geturl() != url:
                raise RuntimeError("unexpected vocal source response")
            content = response.read(MAX_SOURCE_BYTES + 1)
    except Exception as exc:
        raise HTTPException(422, "vocal source download failed") from exc
    if len(content) > MAX_SOURCE_BYTES:
        raise HTTPException(413, "vocal source is too large")
    destination.write_bytes(content)


def artifact_capability(name: str, expiry: int) -> str:
    token = os.getenv("ANYACCOMP_API_TOKEN", "").encode()
    return hmac.new(token, f"{name}:{expiry}".encode(), hashlib.sha256).hexdigest()


@app.post("/generate", dependencies=[Depends(require_bearer)])
def generate(body: GenerateRequest) -> dict:
    health = health_payload()
    if body.provider != SPEC["provider"] or not health["ready"]:
        raise HTTPException(503, "AnyAccomp is not ready")
    source_url = body.vocalSource.get("url")
    if not isinstance(source_url, str) or not source_url:
        raise HTTPException(400, "private source vocal URL is required")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    work = ARTIFACTS / uuid4().hex
    work.mkdir(mode=0o700)
    vocal = work / "vocal-input"
    output = work / "accompaniment.wav"
    download_source(source_url, vocal)
    try:
        run(vocal, output, body.prompt, ASSETS)
    except InferenceError as exc:
        raise HTTPException(500, "AnyAccomp inference failed") from exc
    expiry = int(time.time()) + CAPABILITY_TTL_SECONDS
    name = f"{work.name}/accompaniment.wav"
    cap = artifact_capability(name, expiry)
    with wave.open(str(output), "rb") as rendered:
        sample_rate = rendered.getframerate()
        channels = rendered.getnchannels()
        duration_seconds = rendered.getnframes() / sample_rate
    base, artifact_origin_ready = public_artifact_origin_state()
    if not artifact_origin_ready:
        raise HTTPException(
            503, "AnyAccomp public origin does not match promoted deployment"
        )
    return {
        "provider": SPEC["provider"],
        "modelVersion": SPEC["model_version"],
        "checkpointSha256": SPEC["weights"]["checkpoint_set_sha256"],
        "revision": health["revision"],
        "modalImageId": health["modalImageId"],
        "sourceImageDigest": health["sourceImageDigest"],
        "cudaVersion": health["runtime"]["cudaVersion"],
        "pytorchVersion": health["runtime"]["pytorchVersion"],
        "gpu": health["runtime"]["gpu"],
        "smokeTested": health["smokeTested"],
        "candidates": [{
            "id": str(uuid4()),
            "artifact": {
                "name": "accompaniment.wav",
                "url": (
                    f"{base}/artifact/{name}"
                    f"?expires={expiry}&capability={cap}"
                ),
                "contentType": "audio/wav",
                "format": "wav",
                "bytes": output.stat().st_size,
                "sha256": digest(output),
                "durationSeconds": duration_seconds,
                "sampleRate": sample_rate,
                "channels": channels,
            },
            "sourceType": "provider-audio",
            "metadata": {
                "conditioning": "source vocal only",
                "textPromptUsed": False,
                "privateArtifact": True,
            },
        }],
    }


@app.get("/artifact/{job_id}/{filename}")
def artifact(job_id: str, filename: str, expires: int, capability: str):
    name = f"{job_id}/{filename}"
    expected = artifact_capability(name, expires)
    if (
        expires < int(time.time())
        or not hmac.compare_digest(capability, expected)
        or not job_id.isalnum()
        or filename != "accompaniment.wav"
    ):
        raise HTTPException(404, "artifact not found")
    path = ARTIFACTS / job_id / filename
    if not path.is_file():
        raise HTTPException(404, "artifact not found")
    return FileResponse(path, media_type="audio/wav")