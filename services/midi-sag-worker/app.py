"""Bearer-protected, fail-closed MIDI-SAG and MuseControlLite service."""
from __future__ import annotations
import base64
import hmac
import json
import os
from pathlib import Path
from typing import Any, Literal
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from inference import ROOT, SPEC, run_pipeline, sha256, valid_midi

ASSET_ROOT = Path(os.getenv("MIDI_SAG_ASSET_ROOT", SPEC["assetRoot"]))
PROVIDERS = ("MIDI_SAG", "MUSE_CONTROL_LITE")


def auth(request: Request, provider: str) -> None:
    """Authenticate only against the token assigned to this provider identity."""
    token = os.getenv(f"{provider}_API_TOKEN")
    if not token:
        raise HTTPException(503, f"{provider} authentication is not configured")
    if not hmac.compare_digest(request.headers.get("Authorization", ""), f"Bearer {token}"):
        raise HTTPException(401, "invalid bearer token")


def state(provider: str) -> dict[str, Any]:
    """Return the reviewed terminal state, never infer one provider from another."""
    if provider not in PROVIDERS:
        return {"provider": provider, "status": "BLOCKED_UNKNOWN_PROVIDER",
                "message": "unknown provider identity", "readiness": {}}
    try:
        review = json.loads((ROOT / "installation-status.json").read_text())
        record = review["providers"][provider]
        terminal = record["terminal"]
        if (record["classification"] != terminal["status"]
                or terminal["ready"] is not False
                or not str(terminal["status"]).startswith("BLOCKED_")):
            raise ValueError("terminal state is not fail-closed")
        return {"provider": provider, **terminal}
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return {"provider": provider, "status": "BLOCKED_REVIEW_UNAVAILABLE",
                "message": "reviewed terminal status is unavailable", "readiness": {}}

class ArrangeRequest(BaseModel):
    vocalWavBase64: str = Field(min_length=4)
    vocalMidiBase64: str | None = None
    mode: Literal["detected", "ground_truth"] = "detected"
    melody: list[dict[str, Any]] | None = None
    chromaHarmony: list[float] | None = None
    rhythm: float | None = Field(default=None, gt=0)
    dynamics: float | None = Field(default=None, ge=0, le=1)
    referenceAudioBase64: str | None = None

app = FastAPI(title="MIDI-SAG / MuseControlLite isolated worker")
@app.get("/health")
def health(request: Request, provider: str = "MIDI_SAG") -> dict[str, Any]:
    if provider not in PROVIDERS:
        raise HTTPException(404, "unknown provider identity")
    auth(request, provider)
    terminal = state(provider)
    readiness = terminal.get("readiness", {})
    return {"provider": provider, "status": terminal["status"], "healthy": False, "runtimeReady": False,
            "checkpointReady": False, "packageReady": False, "smokeTested": False,
            "modelVersion": terminal.get("modelVersion", SPEC["modelVersion"]), "message": terminal["message"],
            "findings": terminal.get("findings", []), "readiness": readiness}

@app.post("/arrange")
def arrange(payload: ArrangeRequest, request: Request) -> dict[str, Any]:
    auth(request, "MIDI_SAG")
    terminal = state("MIDI_SAG")
    # This guard deliberately precedes decoding and the upstream runner.
    if terminal["status"].startswith("BLOCKED_"):
        raise HTTPException(503, f"MIDI-SAG is BLOCKED: {terminal['message']}")
    try:
        vocal = base64.b64decode(payload.vocalWavBase64, validate=True)
        source_midi = base64.b64decode(payload.vocalMidiBase64, validate=True) if payload.vocalMidiBase64 else None
    except ValueError as exc: raise HTTPException(422, "audio or MIDI base64 is invalid") from exc
    if payload.mode == "ground_truth" and source_midi is None: raise HTTPException(422, "ground_truth mode requires vocalMidiBase64")
    artifacts = run_pipeline(vocal, payload.model_dump(exclude={"vocalWavBase64", "vocalMidiBase64"}), source_midi)
    if not valid_midi(artifacts["midi"]): raise HTTPException(502, "upstream returned invalid MIDI")
    return {"provider": "MIDI_SAG", "rendererProvider": "MUSE_CONTROL_LITE", "mode": payload.mode,
            "midiBase64": base64.b64encode(artifacts["midi"]).decode(), "backingWavBase64": base64.b64encode(artifacts["wav"]).decode(),
            "midiSha256": __import__("hashlib").sha256(artifacts["midi"]).hexdigest(), "modelVersion": SPEC["modelVersion"],
            "assetManifestSha256": sha256(ASSET_ROOT / SPEC["assetManifest"])}