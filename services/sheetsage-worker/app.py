"""Bearer-protected, fail-closed SheetSage 0.2.1 production service."""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from inference import InferenceError, run

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSET_ROOT = Path(os.getenv("SHEETSAGE_ASSET_ROOT", SPEC["asset_root"]))
ASSET_MANIFEST = ASSET_ROOT / SPEC["asset_manifest"]


def _auth(request: Request) -> None:
    token = os.getenv("SHEETSAGE_API_TOKEN")
    supplied = request.headers.get("Authorization", "")
    if not token:
        raise HTTPException(503, "SheetSage authentication is not configured")
    if not hmac.compare_digest(supplied, f"Bearer {token}"):
        raise HTTPException(401, "invalid bearer token")


def _digest(path: Path) -> str:
    hash_ = hashlib.sha256()
    with path.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            hash_.update(part)
    return hash_.hexdigest()


def asset_state() -> tuple[bool, str, dict[str, Any] | None]:
    if os.getenv(SPEC["license"]["acceptance_environment"]) != SPEC["license"]["required_value"]:
        return False, "SheetSage model license is not accepted", None
    try:
        inventory = json.loads(ASSET_MANIFEST.read_text())
        entries = inventory["assets"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return False, "SheetSage asset inventory is unavailable", None
    if inventory.get("package") != SPEC["package"] or not isinstance(entries, list) or not entries:
        return False, "SheetSage asset inventory identity is invalid", None
    actual_inventory = {
        entry.get("path"): entry.get("sha256") for entry in entries
        if isinstance(entry, dict)
    }
    if actual_inventory != SPEC["required_asset_sha256"]:
        return False, "SheetSage asset inventory does not match required checkpoints", None
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            return False, "SheetSage asset inventory is invalid", None
        path = ASSET_ROOT / entry["path"]
        if not path.is_file() or path.stat().st_size != entry.get("bytes") or _digest(path) != entry.get("sha256"):
            return False, "SheetSage asset hash verification failed", None
    return True, "SheetSage assets verified", inventory


def smoke_state() -> tuple[bool, str]:
    proof = ASSET_ROOT / "smoke-proof.json"
    ready, _, inventory = asset_state()
    if not ready or not inventory:
        return False, "assets unavailable"
    try:
        value = json.loads(proof.read_text())
        valid = (value["realInference"] is True and value["package"] == SPEC["package"]
                 and value["assetManifestSha256"] == _digest(ASSET_MANIFEST)
                 and isinstance(value["outputSha256"], str))
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        valid = False
    return (True, "real inference smoke proof verified") if valid else (False, "real inference smoke proof is unavailable")


def _number(value: Any, label: str, minimum: float = 0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise InferenceError(f"invalid {label}")
    return float(value)


def validate_evidence(value: dict[str, Any]) -> dict[str, Any]:
    melody, chords, timing, confidence = (value.get(key) for key in ("melody", "chords", "timing", "confidence"))
    if not all(isinstance(item, list) and item for item in (melody, chords, timing)):
        raise InferenceError("SheetSage returned incomplete musical evidence")
    _number(confidence, "confidence")
    if float(confidence) > 1:
        raise InferenceError("invalid confidence")
    for index, note in enumerate(melody):
        if not isinstance(note, dict):
            raise InferenceError(f"invalid melody event {index}")
        _number(note.get("start"), "melody start")
        end = _number(note.get("end"), "melody end")
        if end <= _number(note.get("start"), "melody start") or not isinstance(note.get("pitch"), int):
            raise InferenceError(f"invalid melody event {index}")
        _number(note.get("confidence"), "melody confidence")
        if float(note["confidence"]) > 1:
            raise InferenceError(f"invalid melody event {index}")
    for index, chord in enumerate(chords):
        if not isinstance(chord, dict) or not isinstance(chord.get("symbol"), str) or not chord["symbol"].strip():
            raise InferenceError(f"invalid chord event {index}")
        if _number(chord.get("end"), "chord end") <= _number(chord.get("start"), "chord start"):
            raise InferenceError(f"invalid chord event {index}")
        _number(chord.get("confidence"), "chord confidence")
        if float(chord["confidence"]) > 1:
            raise InferenceError(f"invalid chord event {index}")
    return {"provider": "SHEETSAGE", "modelVersion": SPEC["package"]["version"],
            "melody": melody, "chords": chords, "timing": timing, "confidence": confidence}


class AnalyzeRequest(BaseModel):
    audio_base64: str = Field(alias="audioBase64", min_length=1)


app = FastAPI(title="SheetSage 0.2.1")


@app.get("/health")
def health(request: Request) -> dict[str, Any]:
    _auth(request)
    assets, message, _ = asset_state()
    smoke, smoke_message = smoke_state()
    license_accepted = (
        os.getenv(SPEC["license"]["acceptance_environment"])
        == SPEC["license"]["required_value"]
    )
    return {"provider": "SHEETSAGE", "version": SPEC["package"]["version"],
            "sourceRevision": SPEC["package"]["source_revision"], "assetsVerified": assets,
            "smokeTested": smoke, "healthy": assets and smoke,
            "status": "ready" if assets and smoke else (
                "blocked" if not license_accepted else "unavailable"
            ),
            "message": "ready" if assets and smoke else (message if not assets else smoke_message)}


@app.post("/analyze")
def analyze(payload: AnalyzeRequest, request: Request) -> dict[str, Any]:
    _auth(request)
    assets, _, _ = asset_state()
    smoke, _ = smoke_state()
    if not assets or not smoke:
        raise HTTPException(503, "SheetSage is not ready for real inference")
    try:
        return validate_evidence(run(payload.audio_base64, ASSET_ROOT, 300))
    except InferenceError as exc:
        raise HTTPException(422, str(exc)) from exc