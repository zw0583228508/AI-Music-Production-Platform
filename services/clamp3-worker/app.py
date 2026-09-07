from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from inference import (
    AssetsUnavailable,
    MODEL_REVISION,
    SOURCE_REVISION,
    similarity,
    verified_installation_identity,
)


class Item(BaseModel):
    model_config = ConfigDict(extra="forbid")
    modality: str
    text: str | None = None
    dataBase64: str | None = None


class SimilarityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    left: Item
    right: Item


app = FastAPI(title="CLaMP 3 research worker", version="1.0.0")


def authorize(authorization: str | None) -> None:
    expected = os.environ.get("MUSIC_AI_WORKER_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="worker authentication is not configured")
    if not hmac.compare_digest(authorization or "", f"Bearer {expected}"):
        raise HTTPException(status_code=401, detail="invalid bearer token")


@app.get("/health")
def health(authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    ready = False
    blockers: list[str] = []
    identity = {}
    try:
        identity = verified_installation_identity()
        ready = True
    except (AssetsUnavailable, OSError, ValueError) as exc:
        blockers = [str(exc)]
    proof_path = Path("/models/clamp3/smoke-proof.json")
    inventory_path = Path("/models/clamp3/asset_inventory.json")
    smoke_tested = False
    if ready:
        try:
            proof = json.loads(proof_path.read_text(encoding="utf-8"))
            comparisons = proof["comparisons"]
            smoke_tested = (
                proof["ok"] is True
                and proof["realInference"] is True
                and proof["device"]["type"] == "cuda"
                and proof["device"]["accelerateDevice"].startswith("cuda")
                and proof["crossModal"] == ["text-audio", "midi-audio"]
                and comparisons["textAudio"]["matching"] > comparisons["textAudio"]["mismatched"]
                and comparisons["midiAudio"]["matching"] > comparisons["midiAudio"]["mismatched"]
                and proof["installationIdentity"] == identity
                and proof["assetInventorySha256"] == hashlib.sha256(inventory_path.read_bytes()).hexdigest()
            )
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            smoke_tested = False
    if not smoke_tested:
        blockers.append("real cross-modal GPU smoke proof is absent or invalid")
    return {
        "ok": ready and smoke_tested,
        "ready": ready and smoke_tested,
        "classification": "RESEARCH_READY" if ready and smoke_tested else "BLOCKED_NO_WEIGHTS",
        "smokeTested": smoke_tested,
        "sourceRevision": SOURCE_REVISION,
        "modelRevision": MODEL_REVISION,
        **identity,
        "blockers": blockers,
    }


@app.post("/v1/similarity")
def compare(request: SimilarityRequest, authorization: str | None = Header(default=None)) -> dict:
    authorize(authorization)
    try:
        return similarity(request.left.model_dump(exclude_none=True), request.right.model_dump(exclude_none=True))
    except AssetsUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc