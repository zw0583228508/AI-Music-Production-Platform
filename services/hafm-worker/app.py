"""HAFM isolated real-vocal-to-instrumental worker."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import uuid

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

from inference import infer

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
AUTHORIZATION = json.loads((ROOT / SPEC["fixture_authorization"]).read_text())
ASSET_ROOT = Path(os.getenv("HAFM_ASSET_ROOT", SPEC["asset_root"]))
SMOKE_ROOT = Path(os.getenv("HAFM_SMOKE_ROOT", "/var/lib/hafm/smoke"))
OUTPUT_ROOT = Path(os.getenv("HAFM_ARTIFACT_ROOT", "/var/lib/hafm/artifacts"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def authenticate(request: Request) -> None:
    token = os.getenv("HAFM_API_TOKEN") or os.getenv("MUSIC_AI_WORKER_TOKEN")
    if not token:
        raise HTTPException(503, "HAFM authentication is not configured")
    if not hmac.compare_digest(
        request.headers.get("authorization", ""),
        f"Bearer {token}",
    ):
        raise HTTPException(401, "invalid bearer token")


def state() -> tuple[bool, bool, bool, dict[str, object] | None]:
    try:
        manifest_path = ASSET_ROOT / SPEC["asset_manifest"]
        manifest = json.loads(manifest_path.read_text())
        assets_ok = (
            manifest["model"] == {
                "repository": SPEC["model"]["repository"],
                "revision": SPEC["model"]["revision"],
            }
            and manifest["treeSha256"] == SPEC["model"]["treeSha256"]
            and all(
                (
                    ASSET_ROOT / manifest["path"] / entry["path"]
                ).is_file()
                and sha256(
                    ASSET_ROOT / manifest["path"] / entry["path"]
                ) == entry["sha256"]
                for entry in manifest["files"]
            )
        )
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return False, False, False, None
    try:
        compatibility_path = SMOKE_ROOT / SPEC["compatibility_evidence"]
        compatibility = json.loads(compatibility_path.read_text())
        compatible = (
            compatibility.get("compatible") is True
            and compatibility.get("imageEvidence")
            == os.getenv("HAFM_SOURCE_IMAGE_DIGEST")
        )
    except (OSError, TypeError, json.JSONDecodeError):
        compatible = False
    try:
        proof = json.loads((SMOKE_ROOT / SPEC["smoke_proof"]).read_text())
        smoke_ok = (
            proof.get("realInference") is True
            and proof.get("plausibleAccompaniment") is True
            and proof.get("distinctFromInput") is True
            and proof.get("privateAudioCommittedToGit") is False
            and proof.get("input", {}).get("sha256")
            == AUTHORIZATION["derivedFixture"]["sha256"]
            and proof.get("output", {}).get("allSamplesFinite") is True
            and proof.get("output", {}).get("nonSilent") is True
            and proof.get("assetManifestSha256") == sha256(manifest_path)
            and proof.get("compatibilityEvidenceSha256")
            == sha256(compatibility_path)
        )
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        smoke_ok = False
    return assets_ok, compatible, smoke_ok, manifest


class AccompanyRequest(BaseModel):
    vocalWavBase64: str = Field(min_length=16)


app = FastAPI(title="HAFM isolated provider")


@app.get("/health")
def health(request: Request) -> dict[str, object]:
    authenticate(request)
    assets_ok, compatible, smoke_ok, manifest = state()
    ready = assets_ok and compatible and smoke_ok
    message = (
        "ready"
        if ready
        else (
            "blocked-upstream: published HAFM source lacks the required "
            "architecture, config, and audio utility modules"
        )
    )
    return {
        "provider": "HAFM",
        "status": "ready" if ready else "blocked",
        "ready": ready,
        "healthy": ready,
        "runtimeReady": ready,
        "checkpointReady": assets_ok,
        "packageReady": compatible,
        "smokeTested": smoke_ok,
        "gpuReady": ready,
        "modelVersion": SPEC["model"]["revision"],
        "checkpointSha256": (
            manifest.get("treeSha256")
            if manifest and assets_ok
            else None
        ),
        "revision": (
            f"{SPEC['model']['repository']}@{SPEC['model']['revision']}"
        ),
        "sourceRevision": SPEC["source"]["revision"],
        "sourceImageDigest": os.getenv("HAFM_SOURCE_IMAGE_DIGEST"),
        "modalAppId": os.getenv("HAFM_MODAL_APP_ID"),
        "modalDeploymentId": os.getenv("HAFM_MODAL_DEPLOYMENT_ID"),
        "modalFunctionId": os.getenv("HAFM_MODAL_FUNCTION_ID"),
        "modalImageId": os.getenv("HAFM_MODAL_IMAGE_ID"),
        "runtime": {
            "pythonVersion": SPEC["runtime"]["python"],
            "ready": ready,
            "gpuReady": ready,
        },
        "framework": {
            "cuda_image": SPEC["runtime"]["cudaImage"],
            "cuda": SPEC["runtime"]["cuda"],
            "pytorch": "UNRESOLVED_UPSTREAM",
            "torchvision": "UNRESOLVED_UPSTREAM",
            "torchaudio": "UNRESOLVED_UPSTREAM",
            "torch_index_url": "UNRESOLVED_UPSTREAM",
            "transformers": "UNRESOLVED_UPSTREAM",
            "accelerate": "UNRESOLVED_UPSTREAM",
        },
        "licenseStatus": "Apache-2.0",
        "message": message,
    }


@app.post("/accompany")
def accompany(
    payload: AccompanyRequest,
    request: Request,
) -> dict[str, object]:
    authenticate(request)
    assets_ok, compatible, smoke_ok, manifest = state()
    if not assets_ok or not compatible or not smoke_ok or manifest is None:
        raise HTTPException(
            503,
            "HAFM is BLOCKED until compatibility, assets, and persisted "
            "real-audio smoke evidence verify",
        )
    try:
        vocal = base64.b64decode(payload.vocalWavBase64, validate=True)
    except ValueError as error:
        raise HTTPException(
            422,
            "vocalWavBase64 is invalid",
        ) from error
    OUTPUT_ROOT.mkdir(mode=0o750, parents=True, exist_ok=True)
    identifier = uuid.uuid4().hex
    output = OUTPUT_ROOT / f"{identifier}.wav"
    infer(vocal, output, ASSET_ROOT)
    return {
        "provider": "HAFM",
        "artifactUrl": f"/artifacts/{identifier}",
        "wavBase64": base64.b64encode(output.read_bytes()).decode(),
        "artifactSha256": sha256(output),
        "checkpointSha256": manifest["treeSha256"],
        "modelVersion": SPEC["model"]["revision"],
        "sourceRevision": SPEC["source"]["revision"],
    }


@app.get("/artifacts/{identifier}")
def artifact(identifier: str, request: Request) -> Response:
    authenticate(request)
    path = OUTPUT_ROOT / f"{identifier}.wav"
    if (
        not identifier.isalnum()
        or len(identifier) != 32
        or not path.is_file()
    ):
        raise HTTPException(404, "artifact not found")
    return Response(
        path.read_bytes(),
        media_type="audio/wav",
        headers={"ETag": sha256(path)},
    )