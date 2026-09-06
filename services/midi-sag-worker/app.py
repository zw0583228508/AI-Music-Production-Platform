"""Bearer-protected, fail-closed MIDI-SAG and MuseControlLite service."""
from __future__ import annotations
import base64
import hmac
import json
import os
import subprocess
from pathlib import Path
from typing import Any, Literal
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from inference import ROOT, SPEC, UPSTREAM, run_pipeline, sha256, valid_midi

ASSET_ROOT = Path(os.getenv("MIDI_SAG_ASSET_ROOT", SPEC["assetRoot"]))

def auth(request: Request) -> None:
    # Both registry identities can deliberately terminate at this packaged
    # worker, but neither gets an unauthenticated compatibility path.
    token = os.getenv("MIDI_SAG_API_TOKEN") or os.getenv("MUSE_CONTROL_LITE_API_TOKEN")
    if not token: raise HTTPException(503, "MIDI-SAG authentication is not configured")
    if not hmac.compare_digest(request.headers.get("Authorization", ""), f"Bearer {token}"):
        raise HTTPException(401, "invalid bearer token")

def state() -> tuple[bool, str, dict[str, Any] | None]:
    try:
        if subprocess.check_output(["git", "-C", str(UPSTREAM), "rev-parse", "HEAD"], text=True).strip() != SPEC["code"]["revision"]:
            return False, "pinned MIDI-SAG source identity failed", None
        manifest = json.loads((ASSET_ROOT / SPEC["assetManifest"]).read_text())
        if manifest.get("provider") != "MIDI_SAG" or manifest.get("modelVersion") != SPEC["modelVersion"]:
            return False, "MIDI-SAG asset manifest identity failed", None
        if {asset.get("id") for asset in manifest.get("assets", [])} != {asset["id"] for asset in SPEC["assets"]}:
            return False, "MIDI-SAG asset inventory does not match the required manifest", None
        for asset in manifest["assets"]:
            files = asset["files"]
            if not files: return False, f"{asset.get('id')} inventory is empty", None
            for entry in files:
                file = ASSET_ROOT / asset["path"] / entry["path"]
                if not file.is_file() or file.stat().st_size != entry["bytes"] or sha256(file) != entry["sha256"]:
                    return False, f"{asset.get('id')} checksum verification failed", None
        proof = json.loads((ASSET_ROOT / SPEC["smokeProof"]).read_text())
        if not (proof["realInference"] is True and proof["assetManifestSha256"] == sha256(ASSET_ROOT / SPEC["assetManifest"])
                and proof["midi"]["validNonempty"] is True and proof["midi"]["bytes"] > 32
                and proof["museControlLite"]["nonemptyWav"] is True and proof["museControlLite"]["bytes"] > 0):
            return False, "real MIDI-SAG/MuseControlLite smoke evidence is incomplete", None
        return True, "pinned source, assets, and real smoke evidence verified", manifest
    except (OSError, KeyError, TypeError, json.JSONDecodeError, subprocess.CalledProcessError):
        return False, "MIDI-SAG provenance or smoke evidence is unavailable", None

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
    auth(request)
    ok, message, _ = state()
    if provider not in ("MIDI_SAG", "MUSE_CONTROL_LITE"): ok, message = False, "unknown provider identity"
    return {"provider": provider, "status": "ready" if ok else "blocked", "healthy": ok, "runtimeReady": ok,
            "checkpointReady": ok, "packageReady": ok, "smokeTested": ok, "modelVersion": SPEC["modelVersion"],
            "message": message, "provenance": {"code": SPEC["code"], "runtime": SPEC["runtime"]}}

@app.post("/arrange")
def arrange(payload: ArrangeRequest, request: Request) -> dict[str, Any]:
    auth(request)
    ok, message, manifest = state()
    if not ok or manifest is None: raise HTTPException(503, f"MIDI-SAG is BLOCKED: {message}")
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