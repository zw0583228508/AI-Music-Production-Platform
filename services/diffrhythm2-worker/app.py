"""Bearer-protected, fail-closed DiffRhythm 2 lyric/rhythm generation worker."""
from __future__ import annotations
import base64, hashlib, hmac, json, os, subprocess, sys, uuid
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
from inference import infer

ROOT=Path(__file__).parent; SPEC=json.loads((ROOT/"model_manifest.json").read_text())
ASSETS=Path(os.getenv("DIFFRHYTHM2_ASSET_ROOT",SPEC["asset_root"]))
OUT=Path(os.getenv("DIFFRHYTHM2_ARTIFACT_ROOT","/var/lib/diffrhythm2/artifacts"))
def sha(p:Path)->str:return hashlib.sha256(p.read_bytes()).hexdigest()
def auth(r:Request):
 token=(os.getenv("DIFFRHYTHM2_API_TOKEN") or "").strip() or (os.getenv("MUSIC_AI_WORKER_TOKEN") or "").strip()
 if not token: raise HTTPException(503,"DiffRhythm 2 authentication is not configured")
 if not hmac.compare_digest(r.headers.get("authorization",""),f"Bearer {token}"): raise HTTPException(401,"invalid bearer token")
def runtime_state():
 try:
  revision=subprocess.check_output(["git","-C","/opt/diffrhythm2","rev-parse","HEAD"],text=True).strip()
  import torch
  return revision==SPEC["source"]["revision"] and torch.__version__.split("+",1)[0]==SPEC["runtime"]["pytorch"]
 except (ImportError,OSError,subprocess.CalledProcessError): return False
def state():
 try:
  if not runtime_state(): return False,None
  inventory=json.loads((ASSETS/SPEC["asset_manifest"]).read_text())
  if inventory["source"] != SPEC["source"] or inventory["license"] != SPEC["license"]: return False,None
  for model in inventory["models"]:
   if not isinstance(model.get("resolvedRevision"),str) or len(model["resolvedRevision"]) != 40: return False,None
   for f in model["files"]:
    p=ASSETS/model["path"]/f["path"]
    if not p.is_file() or p.stat().st_size != f["bytes"] or sha(p) != f["sha256"]: return False,None
  proof=json.loads((ASSETS/SPEC["smoke_proof"]).read_text())
  valid=proof["realInference"] is True and proof["nonSilent"] is True and proof["notSourceCopy"] is True and proof["lyricsConditioned"] is True and proof["rhythmConditioned"] is True and proof["assetManifestSha256"]==sha(ASSETS/SPEC["asset_manifest"])
  return valid,inventory
 except (OSError,KeyError,TypeError,json.JSONDecodeError): return False,None
class Generate(BaseModel):
 lyrics:str=Field(min_length=1,max_length=12000); rhythmWavBase64:str=Field(min_length=16)
 stylePrompt:str=Field(min_length=1,max_length=1000); duration:float=Field(default=30,gt=0,le=210)
 steps:int=Field(default=16,ge=1,le=100); guidance:float=Field(default=2,ge=0,le=10)
app=FastAPI(title="DiffRhythm 2 isolated provider")
@app.get("/health")
def health(request:Request):
 auth(request); ok,inventory=state()
 return {"provider":"DIFFRHYTHM_2","status":"ready" if ok else "blocked","healthy":ok,"runtimeReady":ok,"checkpointReady":ok,"packageReady":ok,"smokeTested":ok,"modelVersion":SPEC["source"]["revision"],"checkpointSha256":sha(ASSETS/SPEC["asset_manifest"]) if inventory else None,"licenseStatus":"Apache-2.0","message":"ready" if ok else "immutable assets and persisted non-silent/non-copy real lyric/rhythm smoke evidence are required"}
@app.post("/generate")
def generate(payload:Generate,request:Request):
 auth(request); ok,inventory=state()
 if not ok or inventory is None: raise HTTPException(503,"DiffRhythm 2 is BLOCKED until pinned runtime, assets, and real smoke verify")
 try: rhythm=base64.b64decode(payload.rhythmWavBase64,validate=True)
 except ValueError as e: raise HTTPException(422,"rhythmWavBase64 is invalid") from e
 OUT.mkdir(mode=0o750,parents=True,exist_ok=True); ident=uuid.uuid4().hex; target=OUT/f"{ident}.mp3"
 infer(lyrics=payload.lyrics,rhythm_wav=rhythm,output=target,style_prompt=payload.stylePrompt,duration=payload.duration,steps=payload.steps,guidance=payload.guidance)
 return {"provider":"DIFFRHYTHM_2","artifactUrl":f"/artifacts/{ident}","artifactSha256":sha(target),"lyricsConditioned":True,"rhythmConditioned":True,"sourceRevision":SPEC["source"]["revision"],"modelRevisions":{m["repository"]:m["resolvedRevision"] for m in inventory["models"]},"license":"Apache-2.0"}
@app.get("/artifacts/{ident}")
def artifact(ident:str,request:Request):
 auth(request); p=OUT/f"{ident}.mp3"
 if not ident.isalnum() or len(ident)!=32 or not p.is_file(): raise HTTPException(404,"artifact not found")
 return Response(p.read_bytes(),media_type="audio/mpeg",headers={"ETag":sha(p)})