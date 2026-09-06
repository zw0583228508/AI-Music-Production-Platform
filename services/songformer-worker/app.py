"""Fail-closed SongFormer boundary. Bootstrap and smoke are separate operations."""
import hmac, json, os
from pathlib import Path
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, HttpUrl

ROOT = Path(os.environ.get("SONGFORMER_ASSET_ROOT", "/var/lib/songformer/assets"))
MANIFEST = json.loads((Path(__file__).with_name("model_manifest.json")).read_text())
app = FastAPI(title="Isolated SongFormer Worker")

def auth(request: Request):
    token = (
        os.environ.get("SONGFORMER_WORKER_TOKEN", "").strip()
        or os.environ.get("MUSIC_AI_WORKER_TOKEN", "").strip()
    )
    if not token or not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {token}"):
        raise HTTPException(401, "worker authentication is required")

def attested() -> bool:
    try:
        record = json.loads((ROOT / "asset-attestation.json").read_text())
        smoke = json.loads((ROOT / ".readiness" / "songformer.json").read_text())
    except (OSError, json.JSONDecodeError): return False
    return (record.get("sourceCommit") == MANIFEST["source"]["commit"] and
            record.get("modelRevision") == MANIFEST["huggingFace"]["revision"] and
            smoke.get("provider") == "SONGFORMER" and smoke.get("featureExecutionSucceeded") is True)

@app.get("/health", dependencies=[Depends(auth)])
def health():
    ready = attested()
    return {"provider": "SONGFORMER", "status": "ready" if ready else "not_ready", "ready": ready,
            "modelVersion": MANIFEST["huggingFace"]["revision"], "runtimeReady": False,
            "checkpointReady": ready, "smokeTested": ready,
            "reason": None if ready else "immutable assets and persisted real-audio execution proof are required"}

class AnalyzeRequest(BaseModel):
    provider: str
    sourceUrl: HttpUrl

@app.post("/analyze", dependencies=[Depends(auth)])
def analyze(request: AnalyzeRequest):
    if request.provider != "SONGFORMER": raise HTTPException(422, "provider must be SONGFORMER")
    # Do not fabricate sections: the adapter is unavailable until the pinned
    # upstream inference path is executed and a persisted real-audio proof exists.
    raise HTTPException(503, "SONGFORMER is fail-closed pending bootstrap and real-audio smoke attestation")