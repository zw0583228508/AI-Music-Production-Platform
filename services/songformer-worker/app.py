"""Authenticated, fail-closed SongFormer boundary."""
import hmac
import json
import os
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, HttpUrl

MANIFEST = json.loads((Path(__file__).with_name("model_manifest.json")).read_text())
LICENSE_GATE = MANIFEST["licenseGate"]
app = FastAPI(title="Isolated SongFormer Worker")


def auth(request: Request):
    token = (
        os.environ.get("SONGFORMER_WORKER_TOKEN", "").strip()
        or os.environ.get("MUSIC_AI_WORKER_TOKEN", "").strip()
    )
    if not token or not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {token}"):
        raise HTTPException(401, "worker authentication is required")


def attested() -> bool:
    return False

@app.get("/health", dependencies=[Depends(auth)])
def health():
    return {
        "provider": "SONGFORMER",
        "status": "blocked_license",
        "ready": False,
        "runtimeReady": False,
        "checkpointReady": False,
        "smokeTested": False,
        "sourceRevision": MANIFEST["source"]["commit"],
        "modelRevision": MANIFEST["modelSources"]["songformer"]["revision"],
        "reason": LICENSE_GATE["reason"],
    }

class AnalyzeRequest(BaseModel):
    provider: str
    sourceUrl: HttpUrl


@app.post("/analyze", dependencies=[Depends(auth)])
def analyze(request: AnalyzeRequest):
    if request.provider != "SONGFORMER":
        raise HTTPException(422, "provider must be SONGFORMER")
    raise HTTPException(
        503,
        "SONGFORMER is blocked because required checkpoint rights are not verified",
    )