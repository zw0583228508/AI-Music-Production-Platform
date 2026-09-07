"""Isolated Stable Audio 3 Small/Medium service with fail-closed immutable readiness."""
from __future__ import annotations
import base64, hashlib, hmac, io, json, os, subprocess, sys, tempfile, uuid
from pathlib import Path
from typing import Any, Literal
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field, model_validator
from inference import InferenceError, run

ROOT=Path(__file__).parent; SPEC=json.loads((ROOT/"model_manifest.json").read_text())
ASSETS=Path(os.getenv("STABLE_AUDIO3_ASSET_ROOT",SPEC["asset_root"])); OUT=Path(os.getenv("STABLE_AUDIO3_ARTIFACT_ROOT",SPEC["artifact_root"]))
def sha(p: Path) -> str:
 d=hashlib.sha256()
 with p.open("rb") as f:
  for b in iter(lambda:f.read(1024*1024),b""): d.update(b)
 return d.hexdigest()
def auth(r: Request) -> None:
 token=os.getenv("STABLE_AUDIO3_API_TOKEN")
 if not token: raise HTTPException(503,"Stable Audio 3 authentication is not configured")
 if not hmac.compare_digest(r.headers.get("Authorization",""),f"Bearer {token}"): raise HTTPException(401,"invalid bearer token")
def runtime_state() -> tuple[bool,str]:
 if sys.version_info < (3,10): return False,"Stable Audio 3 requires Python 3.10 or newer"
 try:
  pinned=os.getenv("STABLE_AUDIO3_PYTHON","/opt/stable-audio3-venv/bin/python")
  versions=json.loads(subprocess.check_output([pinned,"-c","import json,torch,torchaudio;print(json.dumps({'torch':torch.__version__,'torchaudio':torchaudio.__version__}))"],text=True))
  source=Path(os.getenv("STABLE_AUDIO3_SOURCE_ROOT",str(ASSETS/"source")))
  revision=subprocess.check_output(["git","-C",str(source),"rev-parse","HEAD"],text=True).strip()
 except (OSError,subprocess.CalledProcessError,json.JSONDecodeError,KeyError): return False,"Stable Audio 3 pinned runtime evidence is unavailable"
 if versions["torch"].split("+",1)[0]!="2.7.1" or versions["torchaudio"].split("+",1)[0]!="2.7.1" or revision!=SPEC["source"]["revision"]:
  return False,"Stable Audio 3 package/runtime does not match its immutable identity"
 return True,"Stable Audio 3 runtime verified"
def state(identity: str | None=None) -> tuple[bool,str,dict[str,Any]|None]:
 if os.getenv(SPEC["license"]["acceptance_environment"]) != SPEC["license"]["required_value"]: return False,"Stability license acceptance is required",None
 runtime_ok,runtime_message=runtime_state()
 if not runtime_ok:return False,runtime_message,None
 try: inventory=json.loads((ASSETS/SPEC["asset_manifest"]).read_text()); source=inventory["source"]
 except (OSError,KeyError,TypeError,json.JSONDecodeError): return False,"immutable Stable Audio 3 asset inventory is unavailable",None
 if source.get("repository")!=SPEC["source"]["repository"] or source.get("revision")!=SPEC["source"]["revision"] or source.get("checkedOutRevision")!=source.get("revision"): return False,"Stable Audio 3 source identity is invalid",None
 for key, wanted in SPEC["models"].items():
  if identity and key != identity: continue
  item=inventory.get("models",{}).get(key)
  if not isinstance(item,dict) or item.get("repository")!=wanted["repository"] or item.get("revision")!=wanted["revision"] or item.get("resolvedRevision")!=wanted["revision"]: return False,f"{key} snapshot pin is invalid",None
  for entry in item.get("files",[]):
   p=ASSETS/item["path"]/entry.get("path","")
   if not p.is_file() or p.stat().st_size!=entry.get("bytes") or sha(p)!=entry.get("sha256"): return False,f"{key} checkpoint verification failed",None
  if not item.get("files"): return False,f"{key} checkpoint inventory is empty",None
 return True,"Stable Audio 3 immutable assets verified",inventory
def smoke(identity: str | None=None) -> bool:
 ready,_,_=state(identity)
 try:
  proof=json.loads((ASSETS/SPEC["smoke_proof"]).read_text())
  chosen=[identity] if identity else list(SPEC["models"])
  required={"textToAudio","audioToAudio","continuation","inpainting"}
  return ready and proof["schemaVersion"]==2 and proof["networkAccessDenied"] is True and proof["assetManifestSha256"]==sha(ASSETS/SPEC["asset_manifest"]) and all(
   proof["models"][x]["realInference"] is True and proof["models"][x]["nonSilent"] is True
   and required <= set(proof["models"][x]["modes"])
   and proof["models"][x]["modes"]["continuation"]["extendedBeyondSource"] is True
   and proof["models"][x]["modes"]["inpainting"]["outsideMaskBitExact"] is True
   for x in chosen)
 except (OSError,KeyError,TypeError,json.JSONDecodeError): return False
class Generate(BaseModel):
 provider: Literal["STABLE_AUDIO_3_SMALL_MUSIC","STABLE_AUDIO_3_MEDIUM"]
 prompt: str=Field(min_length=1,max_length=4000); duration: float=Field(gt=0,le=180)
 initAudio: str|None=None; initNoiseLevel: float=Field(default=0.0,ge=0,le=1)
 inpaintStart: float|None=Field(default=None,ge=0); inpaintEnd: float|None=Field(default=None,ge=0)
 @model_validator(mode="after")
 def controls(self):
  if (self.inpaintStart is None)!=(self.inpaintEnd is None) or (self.inpaintEnd is not None and self.inpaintEnd<=self.inpaintStart): raise ValueError("inpaintStart and inpaintEnd must be an ordered pair")
  if self.inpaintEnd is not None and self.inpaintEnd>self.duration: raise ValueError("inpaint range exceeds duration")
  if (self.inpaintStart is not None or self.initNoiseLevel>0) and not self.initAudio: raise ValueError("audio conditioning requires initAudio")
  return self
app=FastAPI(title="Stable Audio 3 isolated provider")
@app.get("/health")
def health(request:Request,provider:str|None=None):
 auth(request); identity=provider if provider in SPEC["models"] else None; ok,msg,inv=state(identity); tested=smoke(identity)
 return {"provider":identity or "STABLE_AUDIO_3","status":"ready" if ok and tested else "blocked","healthy":ok and tested,"runtimeReady":ok and tested,"packageReady":ok and tested,"checkpointReady":ok,"smokeTested":tested,"networkAccessDenied":tested,"modelVersion":SPEC["models"][identity]["model_version"] if identity else None,"checkpointSha256":sha(ASSETS/SPEC["asset_manifest"]) if inv else None,"licenseStatus":"Stability license accepted" if ok else "blocked","message":"ready" if ok and tested else msg}
@app.post("/generate")
def generate(payload:Generate,request:Request):
 auth(request); ok,_,inv=state(payload.provider); tested=smoke(payload.provider)
 if not ok or not tested or inv is None: raise HTTPException(503,"Stable Audio 3 is BLOCKED until license, immutable assets, and non-silent smoke proof verify")
 with tempfile.TemporaryDirectory(dir="/tmp") as directory:
  output=Path(directory)/"output.wav"; init=None
  if payload.initAudio:
   try: data=base64.b64decode(payload.initAudio,validate=True); audio,rate=sf.read(io.BytesIO(data),always_2d=True)
   except (ValueError,RuntimeError): raise HTTPException(422,"initAudio must be a decodable base64 WAV")
   if len(audio)<rate//10 or float(abs(audio).max())<1e-5: raise HTTPException(422,"initAudio is silent or too short")
   init=Path(directory)/"init.wav"; init.write_bytes(data)
  try: run(payload.provider,payload.prompt,payload.duration,init,payload.initNoiseLevel,payload.inpaintStart,payload.inpaintEnd,None,1,output,ASSETS)
  except InferenceError as exc: raise HTTPException(503,str(exc)) from exc
  try: rendered,rate=sf.read(str(output),always_2d=True)
  except RuntimeError as exc: raise HTTPException(502,"Stable Audio 3 returned an invalid WAV") from exc
  if len(rendered)==0 or float(abs(rendered).max())<1e-5 or (init and sha(init)==sha(output)): raise HTTPException(502,"Stable Audio 3 output failed non-silence/non-copy verification")
  OUT.mkdir(mode=0o750,parents=True,exist_ok=True); ident=uuid.uuid4().hex; destination=OUT/f"{ident}.wav"; destination.write_bytes(output.read_bytes()); destination.chmod(0o640)
 return {"provider":payload.provider,"modelVersion":SPEC["models"][payload.provider]["model_version"],"checkpointSha256":sha(ASSETS/SPEC["asset_manifest"]),"artifactUrl":f"/artifacts/{ident}","artifactSha256":sha(destination),"durationSeconds":len(rendered)/rate,"sampleRate":rate,"controls":payload.model_dump(),"provenance":{"sourceRevision":SPEC["source"]["revision"],"snapshotRevision":SPEC["models"][payload.provider]["revision"],"nonSilentVerified":True}}
@app.get("/artifacts/{ident}")
def artifact(ident:str,request:Request):
 auth(request)
 if not ident.isalnum() or len(ident)!=32 or not (path:=OUT/f"{ident}.wav").is_file(): raise HTTPException(404,"artifact not found")
 return Response(path.read_bytes(),media_type="audio/wav",headers={"ETag":sha(path)})