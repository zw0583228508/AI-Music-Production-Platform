"""Bearer-protected, fail-closed DiffRhythm 2 lyric/rhythm generation worker."""
from __future__ import annotations
import base64, hashlib, hmac, importlib.metadata, json, os, re, subprocess, sys, uuid
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
from contract import MAX_DURATION_SECONDS
from inference import infer

ROOT=Path(__file__).parent; SPEC=json.loads((ROOT/"model_manifest.json").read_text())
CODEC_EVIDENCE=ROOT/"codec-threshold-evidence.json"
ASSETS=Path(os.getenv("DIFFRHYTHM2_ASSET_ROOT",SPEC["asset_root"]))
OUT=Path(os.getenv("DIFFRHYTHM2_ARTIFACT_ROOT","/var/lib/diffrhythm2/artifacts"))
def sha(p:Path)->str:return hashlib.sha256(p.read_bytes()).hexdigest()
def auth(r:Request):
 token=(os.getenv("DIFFRHYTHM2_API_TOKEN") or "").strip() or (os.getenv("MUSIC_AI_WORKER_TOKEN") or "").strip()
 if not token: raise HTTPException(503,"DiffRhythm 2 authentication is not configured")
 if not hmac.compare_digest(r.headers.get("authorization",""),f"Bearer {token}"): raise HTTPException(401,"invalid bearer token")
def runtime_state():
    try:
        revision = subprocess.check_output(
            ["git", "-C", "/opt/diffrhythm2", "rev-parse", "HEAD"], text=True
        ).strip()
        import torch

        observed = {
            "python": ".".join(map(str, sys.version_info[:2])),
            "pytorch": torch.__version__,
            "torchvision": importlib.metadata.version("torchvision"),
            "torchaudio": importlib.metadata.version("torchaudio"),
            "transformers": importlib.metadata.version("transformers"),
            "cuda": torch.version.cuda,
        }
        expected = SPEC["runtime"]
        return (
            revision == SPEC["source"]["revision"]
            and torch.cuda.is_available()
            and all(observed[key] == expected[key] for key in observed)
        )
    except (
        ImportError,
        OSError,
        subprocess.CalledProcessError,
        importlib.metadata.PackageNotFoundError,
    ):
        return False


def state():
    try:
        if not runtime_state():
            return False, None
        codec_evidence=json.loads(CODEC_EVIDENCE.read_text())
        if (codec_evidence.get("passed") is not True
                or codec_evidence.get("audioRetained") is not False
                or len(codec_evidence.get("cases",[])) != 12
                or not all(case.get("passed") is True for case in codec_evidence["cases"])):
            return False, None
        inventory = json.loads((ASSETS / SPEC["asset_manifest"]).read_text())
        if inventory["source"] != SPEC["source"] or inventory["license"] != SPEC["license"]:
            return False, None
        for model in inventory["models"]:
            if (
                not isinstance(model.get("resolvedRevision"), str)
                or len(model["resolvedRevision"]) != 40
            ):
                return False, None
            for item in model["files"]:
                path = ASSETS / model["path"] / item["path"]
                if (
                    not path.is_file()
                    or path.stat().st_size != item["bytes"]
                    or sha(path) != item["sha256"]
                ):
                    return False, None
        proof = json.loads((ASSETS / SPEC["smoke_proof"]).read_text())
        valid = (
            SPEC["license"]["status"] == "RESEARCH_ONLY"
            and SPEC["license"]["commercial_use_permitted"] is False
            and proof["realInference"] is True
            and proof["nonSilent"] is True
            and proof["notSourceCopy"] is True
            and proof["lyricsConditioned"] is True
            and proof["rhythmConditioned"] is True
            and proof["assetManifestSha256"] == sha(ASSETS / SPEC["asset_manifest"])
        )
        return valid, inventory
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return False, None
class Generate(BaseModel):
 lyrics:str=Field(min_length=1,max_length=12000); rhythmWavBase64:str=Field(min_length=16)
 stylePrompt:str=Field(min_length=1,max_length=1000); duration:float=Field(default=30,gt=0,le=MAX_DURATION_SECONDS)
 steps:int=Field(default=16,ge=1,le=100); guidance:float=Field(default=2,ge=0,le=10)
app=FastAPI(title="DiffRhythm 2 isolated provider")
@app.get("/health")
def health(request:Request):
 auth(request); ok,inventory=state()
 app_id=os.getenv("MUSIC_GPU_MODAL_APP_ID",""); deployment_id=os.getenv("MUSIC_GPU_MODAL_DEPLOYMENT_ID","")
 function_id=os.getenv("MUSIC_GPU_MODAL_FUNCTION_ID",""); image_id=os.getenv("MODAL_IMAGE_ID","")
 identity_ok=(re.fullmatch(r"ap-[A-Za-z0-9]+",app_id) is not None
              and re.fullmatch(r"v[1-9][0-9]*",deployment_id) is not None
              and re.fullmatch(r"fu-[A-Za-z0-9]+",function_id) is not None
              and re.fullmatch(r"im-[A-Za-z0-9]+",image_id) is not None)
 ready=ok and identity_ok
 runtime=SPEC["runtime"]
 checkpoint=sha(ASSETS/SPEC["asset_manifest"]) if inventory else None
 codec_evidence=json.loads(CODEC_EVIDENCE.read_text()) if CODEC_EVIDENCE.is_file() else None
 return {"provider":"DIFFRHYTHM_2","status":"ready" if ready else "blocked","ready":ready,
         "healthy":ready,"retryable":False,"retryAfterSeconds":None,
         "runtimeReady":ok,"checkpointReady":ok,"packageReady":ok,"smokeTested":ok,
         "identityReady":identity_ok,"gpuReady":runtime_state(),
         "modelVersion":SPEC["source"]["revision"],"version":SPEC["source"]["revision"],
         "revision":SPEC["models"][0]["requested_revision"],"sourceRevision":SPEC["source"]["revision"],
         "checkpointSha256":checkpoint,"checksum":checkpoint,
         "sourceImageDigest":os.getenv("MUSIC_GPU_CONTAINER_DIGEST",""),
         "containerDigest":os.getenv("MUSIC_GPU_CONTAINER_DIGEST",""),
         "codecThresholdEvidence":({
             **codec_evidence,
             "sourceImageDigest":os.getenv("MUSIC_GPU_CONTAINER_DIGEST",""),
             "modalImageId":image_id,
         } if codec_evidence else None),
         "modalImageId":image_id,"modalAppId":app_id,"modalDeploymentId":deployment_id,
         "modalFunctionId":function_id,
         "runtime":{"pythonVersion":runtime["python"],"pytorchVersion":runtime["pytorch"],
                    "cudaVersion":runtime["cuda"],"gpu":"NVIDIA L40S","gpuReady":runtime_state()},
         "framework":{"python":runtime["python"],"cuda_image":runtime["cuda_image"],
                      "cuda":runtime["cuda"],"pytorch":runtime["pytorch"],
                      "torchvision":runtime["torchvision"],"torchaudio":runtime["torchaudio"],
                      "torch_index_url":runtime["torch_index_url"],
                      "transformers":runtime["transformers"],"accelerate":runtime["accelerate"]},
         "licenseStatus":"RESEARCH_ONLY","commercialUsePermitted":False,
         "message":"research endpoint ready" if ready else "immutable assets, identity, and persisted real smoke evidence are required"}
@app.post("/generate")
def generate(payload:Generate,request:Request):
 auth(request); ok,inventory=state()
 if not ok or inventory is None: raise HTTPException(503,"DiffRhythm 2 is BLOCKED until pinned runtime, assets, and real smoke verify")
 try: rhythm=base64.b64decode(payload.rhythmWavBase64,validate=True)
 except ValueError as e: raise HTTPException(422,"rhythmWavBase64 is invalid") from e
 OUT.mkdir(mode=0o750,parents=True,exist_ok=True); ident=uuid.uuid4().hex; target=OUT/f"{ident}.mp3"
 infer(lyrics=payload.lyrics,rhythm_wav=rhythm,output=target,style_prompt=payload.stylePrompt,duration=payload.duration,steps=payload.steps,guidance=payload.guidance)
 return {"provider":"DIFFRHYTHM_2","artifactUrl":f"/artifacts/{ident}","artifactSha256":sha(target),"lyricsConditioned":True,"rhythmConditioned":True,"sourceRevision":SPEC["source"]["revision"],"modelRevisions":{m["repository"]:m["resolvedRevision"] for m in inventory["models"]},"licenseStatus":"RESEARCH_ONLY","commercialUsePermitted":False,"license":"Apache-2.0 source and DiffRhythm2 weights; CC-BY-NC-4.0 MuQ-MuLan and MuQ weights"}
@app.get("/artifacts/{ident}")
def artifact(ident:str,request:Request):
 auth(request); p=OUT/f"{ident}.mp3"
 if not ident.isalnum() or len(ident)!=32 or not p.is_file(): raise HTTPException(404,"artifact not found")
 return Response(p.read_bytes(),media_type="audio/mpeg",headers={"ETag":sha(p)})
