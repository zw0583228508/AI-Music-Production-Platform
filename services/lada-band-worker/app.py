"""Bearer-protected, fail-closed LaDA-Band research-only accompaniment API."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

from inference import infer
from license_gate import authorization_state

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("LADA_BAND_ASSET_ROOT", SPEC["asset_root"]))
SMOKE = Path(os.getenv("LADA_BAND_SMOKE_ROOT", "/var/lib/lada-band/smoke"))
OUT = Path(os.getenv("LADA_BAND_ARTIFACT_ROOT", "/var/lib/lada-band/artifacts"))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def auth(request: Request) -> None:
    token = os.getenv("LADA_BAND_API_TOKEN") or os.getenv("MUSIC_AI_WORKER_TOKEN")
    if not token:
        raise HTTPException(503, "LaDA-Band authentication is not configured")
    if not hmac.compare_digest(
        request.headers.get("authorization", ""),
        f"Bearer {token}",
    ):
        raise HTTPException(401, "invalid bearer token")


def state() -> tuple[bool, str, dict | None]:
    authorized, license_message = authorization_state()
    if not authorized:
        return False, license_message, None
    try:
        inventory = json.loads((ASSETS / SPEC["asset_manifest"]).read_text())
        proof = json.loads((SMOKE / SPEC["smoke_proof"]).read_text())
        valid = (
            inventory["model"]["revision"] == SPEC["model"]["revision"]
            and all(
                (ASSETS / inventory["path"] / item["path"]).is_file()
                and sha(ASSETS / inventory["path"] / item["path"])
                == item["sha256"]
                for item in inventory["files"]
            )
            and proof["realInference"] is True
            and proof["assetManifestSha256"]
            == sha(ASSETS / SPEC["asset_manifest"])
        )
        return (
            valid,
            "ready" if valid else "immutable assets or real-audio smoke proof failed",
            inventory,
        )
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return False, "immutable assets or real-audio smoke proof unavailable", None


class AccompanyRequest(BaseModel):
    vocalWavBase64: str = Field(min_length=16)
    prompt: str | None = Field(default=None, max_length=1000)
    style: str | None = Field(default=None, max_length=300)


app = FastAPI(title="LaDA-Band isolated research worker")


@app.get("/health")
def health(request: Request):
    auth(request)
    ok, message, inventory = state()
    return {
        "provider": "LADA_BAND",
        "status": "ready" if ok else "blocked",
        "healthy": ok,
        "runtimeReady": ok,
        "checkpointReady": ok,
        "packageReady": ok,
        "smokeTested": ok,
        "gpuReady": ok,
        "modelVersion": SPEC["model"]["revision"],
        "checkpointSha256": inventory.get("treeSha256") if inventory else None,
        "licenseStatus": "RESEARCH_ONLY" if ok else "UNVERIFIED",
        "message": message,
    }


@app.post("/accompany")
def accompany(payload: AccompanyRequest, request: Request):
    auth(request)
    ok, message, inventory = state()
    if not ok or inventory is None:
        raise HTTPException(503, message)
    try:
        vocal = base64.b64decode(payload.vocalWavBase64, validate=True)
    except ValueError as exc:
        raise HTTPException(422, "vocalWavBase64 is invalid") from exc
    artifact = uuid.uuid4().hex
    OUT.mkdir(mode=0o750, parents=True, exist_ok=True)
    path = OUT / f"{artifact}.wav"
    infer(vocal, path, ASSETS, payload.prompt, payload.style)
    wav = path.read_bytes()
    return {
        "provider": "LADA_BAND",
        "licenseStatus": "RESEARCH_ONLY",
        "artifactUrl": f"/artifacts/{artifact}",
        "wavBase64": base64.b64encode(wav).decode(),
        "artifactSha256": sha(path),
        "checkpointSha256": inventory["treeSha256"],
        "modelVersion": SPEC["model"]["revision"],
        "sourceRevision": SPEC["source"]["revision"],
    }


@app.get("/artifacts/{artifact}")
def artifact(artifact: str, request: Request):
    auth(request)
    path = OUT / f"{artifact}.wav"
    if not artifact.isalnum() or len(artifact) != 32 or not path.is_file():
        raise HTTPException(404, "artifact not found")
    return Response(
        path.read_bytes(),
        media_type="audio/wav",
        headers={"ETag": sha(path)},
    )