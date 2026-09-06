"""HAFM isolated real-vocal-to-instrumental worker."""
from __future__ import annotations
import base64,hashlib,hmac,json,os,uuid
from pathlib import Path
from fastapi import FastAPI,HTTPException,Request,Response
from pydantic import BaseModel,Field
from inference import infer
ROOT=Path(__file__).parent;SPEC=json.loads((ROOT/"model_manifest.json").read_text());A=Path(os.getenv("HAFM_ASSET_ROOT",SPEC["asset_root"]));S=Path(os.getenv("HAFM_SMOKE_ROOT","/var/lib/hafm/smoke"));OUT=Path(os.getenv("HAFM_ARTIFACT_ROOT","/var/lib/hafm/artifacts"))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def auth(r):
 token=os.getenv("HAFM_API_TOKEN") or os.getenv("MUSIC_AI_WORKER_TOKEN")
 if not token:raise HTTPException(503,"HAFM authentication is not configured")
 if not hmac.compare_digest(r.headers.get("authorization",""),f"Bearer {token}"):raise HTTPException(401,"invalid bearer token")
def state():
 try:
  i=json.loads((A/SPEC["asset_manifest"]).read_text())
  assets_ok=i["model"]["revision"]==SPEC["model"]["revision"] and all((A/i["path"]/x["path"]).is_file() and sha(A/i["path"]/x["path"])==x["sha256"] for x in i["files"])
 except (OSError,KeyError,TypeError,json.JSONDecodeError):return False,False,None
 if not assets_ok:return False,False,i
 try:
  p=json.loads((S/SPEC["smoke_proof"]).read_text())
  smoke_ok=p["realInference"] is True and p["assetManifestSha256"]==sha(A/SPEC["asset_manifest"])
 except (OSError,KeyError,TypeError,json.JSONDecodeError):smoke_ok=False
 return True,smoke_ok,i
class AccompanyRequest(BaseModel):vocalWavBase64:str=Field(min_length=16)
app=FastAPI(title="HAFM isolated provider")
@app.get("/health")
def health(request:Request):
 auth(request);assets_ok,smoke_ok,i=state();ok=assets_ok and smoke_ok
 message="ready" if ok else ("provisioned-not-ready: an independently sourced real vocal fixture must pass smoke inference" if assets_ok else "HAFM immutable assets and persisted real-audio smoke evidence are required")
 return {"provider":"HAFM","status":"ready" if ok else "blocked","healthy":ok,"runtimeReady":ok,"checkpointReady":assets_ok,"packageReady":assets_ok,"smokeTested":smoke_ok,"gpuReady":ok,"modelVersion":SPEC["model"]["revision"],"checkpointSha256":i.get("treeSha256") if i and assets_ok else None,"licenseStatus":"Apache-2.0","message":message}
@app.post("/accompany")
def accompany(payload:AccompanyRequest,request:Request):
 auth(request);assets_ok,smoke_ok,i=state()
 if not assets_ok or not smoke_ok or i is None:raise HTTPException(503,"HAFM is BLOCKED until runtime, assets, and persisted real-audio smoke evidence verify")
 try:vocal=base64.b64decode(payload.vocalWavBase64,validate=True)
 except ValueError as e:raise HTTPException(422,"vocalWavBase64 is invalid") from e
 OUT.mkdir(mode=0o750,parents=True,exist_ok=True);ident=uuid.uuid4().hex;out=OUT/f"{ident}.wav";infer(vocal,out,A)
 return {"provider":"HAFM","artifactUrl":f"/artifacts/{ident}","wavBase64":base64.b64encode(out.read_bytes()).decode(),"artifactSha256":sha(out),"checkpointSha256":i["treeSha256"],"modelVersion":SPEC["model"]["revision"],"sourceRevision":SPEC["source"]["revision"]}
@app.get("/artifacts/{ident}")
def artifact(ident:str,request:Request):
 auth(request);path=OUT/f"{ident}.wav"
 if not ident.isalnum() or len(ident)!=32 or not path.is_file():raise HTTPException(404,"artifact not found")
 return Response(path.read_bytes(),media_type="audio/wav",headers={"ETag":sha(path)})