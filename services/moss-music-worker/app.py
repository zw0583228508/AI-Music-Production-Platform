"""Bearer-protected MOSS musical semantic reasoning; never a canonical facts source."""
from __future__ import annotations
import base64, hashlib, hmac, importlib.metadata as metadata, json, os, subprocess, sys, time, uuid
from pathlib import Path
from typing import Any, Literal
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("MOSS_MUSIC_ASSET_ROOT", SPEC["asset_root"]))
SMOKE = Path(os.getenv("MOSS_MUSIC_SMOKE_ROOT", "/var/lib/moss-music/smoke"))
ARTIFACTS = Path(os.getenv("MOSS_MUSIC_ARTIFACT_ROOT", "/var/lib/moss-music/artifacts"))
def sha(path: Path) -> str:
    h=hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda:f.read(1048576),b""): h.update(b)
    return h.hexdigest()
def auth(request: Request) -> None:
    token=os.getenv("MOSS_MUSIC_API_TOKEN") or os.getenv("MUSIC_AI_WORKER_TOKEN")
    if not token: raise HTTPException(503,"MOSS-Music authentication is not configured")
    if not hmac.compare_digest(request.headers.get("Authorization",""),f"Bearer {token}"):
        raise HTTPException(401,"invalid bearer token")
def runtime_identity() -> dict[str,str]:
    import torch, torchaudio
    return {
        "python":".".join(str(part) for part in sys.version_info[:3]),
        "cuda":str(torch.version.cuda),
        "torch":torch.__version__,
        "torchaudio":torchaudio.__version__,
        "torchcodec":metadata.version("torchcodec"),
        "transformers":metadata.version("transformers"),
        "accelerate":metadata.version("accelerate"),
        "huggingfaceHub":metadata.version("huggingface-hub"),
        "gradio":metadata.version("gradio"),
        "pydantic":metadata.version("pydantic"),
        "fastapi":metadata.version("fastapi"),
        "cudnn":metadata.version(SPEC["runtime"]["cudnn"]["package"]),
        "ffmpeg":subprocess.check_output(["ffmpeg","-version"],text=True).splitlines()[0].split()[2],
    }
def runtime_state() -> tuple[bool,str]:
    try:
        source=subprocess.check_output(["git","-C","/opt/moss-music","rev-parse","HEAD"],text=True).strip()
        sglang=subprocess.check_output(["git","-C","/opt/moss-sglang","rev-parse","HEAD"],text=True).strip()
        packages=runtime_identity()
        ok=(
            packages["python"]==SPEC["runtime"]["python"]
            and packages["cuda"]==SPEC["runtime"]["cuda"]
            and source==SPEC["source"]["revision"]
            and sglang==SPEC["sglang"]["revision"]
            and packages["torch"]==SPEC["runtime"]["torch"]
            and packages["torchaudio"]==SPEC["runtime"]["torchaudio"]
            and packages["torchcodec"]==SPEC["runtime"]["torchcodec"]
            and packages["transformers"]==SPEC["runtime"]["transformers"]
            and packages["accelerate"]==SPEC["runtime"]["accelerate"]
            and packages["huggingfaceHub"]==SPEC["runtime"]["huggingfaceHub"]
            and packages["gradio"]==SPEC["runtime"]["gradio"]
            and packages["pydantic"]==SPEC["runtime"]["pydantic"]
            and packages["fastapi"]==SPEC["runtime"]["fastapi"]
            and packages["cudnn"]==SPEC["runtime"]["cudnn"]["version"]
            and packages["ffmpeg"]==SPEC["runtime"]["ffmpeg"]
        )
        return ok, "MOSS-Music runtime verified" if ok else "MOSS-Music package/runtime does not match pinned identity"
    except (ImportError,OSError,ValueError,IndexError,subprocess.CalledProcessError,metadata.PackageNotFoundError):
        return False,"MOSS-Music runtime evidence is unavailable"

def compatibility_state() -> tuple[bool,str,str|None]:
    path=SMOKE/SPEC["compatibility_evidence"]
    try:
        raw=path.read_bytes();evidence=json.loads(raw)
        preflight=evidence.get("mediaPreflight",{})
        expected_packages={key:SPEC["runtime"][key] for key in (
            "torch","torchaudio","torchcodec","transformers","accelerate",
            "huggingfaceHub","gradio","pydantic","fastapi",
        )}
        valid=(
            evidence.get("schemaVersion")==2
            and evidence.get("providerFamily")==SPEC["provider_family"]
            and evidence.get("imageEvidence")==os.getenv("MOSS_MUSIC_IMAGE_EVIDENCE")
            and evidence.get("source",{}).get("revision")==SPEC["source"]["revision"]
            and evidence.get("source",{}).get("install")=="base-package-without-torch-runtime-extra"
            and evidence.get("sglang",{}).get("revision")==SPEC["sglang"]["revision"]
            and evidence.get("sglang",{}).get("install")=="python[all]"
            and evidence.get("runtime")==SPEC["runtime"]
            and evidence.get("torchcodecWheel")==SPEC["runtime"]["torchcodec_wheel"]
            and evidence.get("pipCheck",{}).get("passed") is True
            and preflight.get("passed") is True
            and preflight.get("packages")==expected_packages
            and str(preflight.get("ffmpeg","")).startswith(f"ffmpeg version {SPEC['runtime']['ffmpeg']}")
            and set(preflight.get("formats",{}))=={"wav","mp3"}
            and preflight.get("tensorBatch",{}).get("device")=="cpu"
        )
        return valid, "MOSS-Music compatibility evidence verified" if valid else "MOSS-Music compatibility evidence does not match pinned identity", hashlib.sha256(raw).hexdigest()
    except (OSError,KeyError,TypeError,json.JSONDecodeError):
        return False,"MOSS-Music compatibility evidence is unavailable",None
def asset_state() -> tuple[bool,str,dict[str,Any]|None]:
    runtime,message=runtime_state()
    if not runtime:return False,message,None
    try: inv=json.loads((ASSETS/SPEC["asset_manifest"]).read_text())
    except (OSError,json.JSONDecodeError): return False,"MOSS-Music immutable asset inventory is unavailable",None
    if inv.get("schemaVersion")!=2 or inv.get("complete") is not True or inv.get("source")!=SPEC["source"] or inv.get("runtime")!=SPEC["runtime"]:
        return False,"MOSS-Music asset inventory identity is invalid",None
    for provider,wanted in SPEC["models"].items():
        item=inv.get("models",{}).get(provider)
        if not isinstance(item,dict) or item.get("repository")!=wanted["repository"] or item.get("revision")!=wanted["revision"]: return False,f"{provider} identity is invalid",None
        canonical=json.dumps(item.get("files",[]),separators=(",",":"),sort_keys=True).encode()
        if item.get("inventorySha256")!=hashlib.sha256(canonical).hexdigest():return False,f"{provider} inventory identity is invalid",None
        for entry in item.get("files",[]):
            path=ASSETS/item["path"]/entry.get("path","")
            if not path.is_file() or path.stat().st_size!=entry.get("bytes") or sha(path)!=entry.get("sha256"):return False,f"{provider} snapshot hash verification failed",None
        if not item.get("files"):return False,f"{provider} snapshot is empty",None
    return True,"MOSS-Music assets verified",inv
def smoke_state() -> tuple[bool,str]:
    ok,_,_=asset_state()
    try:
        raw=(SMOKE/SPEC["smoke_proof"]).read_bytes();proof=json.loads(raw)
        compatibility,_,compatibility_sha=compatibility_state()
        valid=(
            ok
            and compatibility
            and proof.get("schemaVersion")==2
            and proof.get("providerFamily")==SPEC["provider_family"]
            and proof.get("source")==SPEC["source"]
            and proof.get("imageEvidence")==os.getenv("MOSS_MUSIC_IMAGE_EVIDENCE")
            and proof.get("assetManifestSha256")==sha(ASSETS/SPEC["asset_manifest"])
            and proof.get("compatibilityEvidenceSha256")==compatibility_sha
            and proof.get("input")=={**SPEC["smoke_input"],"realSong":True}
            and set(proof.get("models",{}))==set(SPEC["models"])
        )
        if valid:
            for provider,wanted in SPEC["models"].items():
                item=proof["models"][provider];response=item.get("semanticReasoning","")
                encoded=response.encode() if isinstance(response,str) else b""
                valid=(
                    item.get("providerId")==provider
                    and item.get("repository")==wanted["repository"]
                    and item.get("revision")==wanted["revision"]
                    and item.get("role")==wanted["role"]
                    and item.get("realInference") is True
                    and item.get("outputChannel")=="MUSICAL_SEMANTIC_REASONING"
                    and len(encoded)>=20
                    and item.get("responseBytes")==len(encoded)
                    and item.get("responseSha256")==hashlib.sha256(encoded).hexdigest()
                )
                if not valid:break
    except (OSError,KeyError,TypeError,json.JSONDecodeError):valid=False
    return (True,"real inference smoke verified") if valid else (False,"real inference smoke proof is unavailable")
_loaded: dict[str,Any]={}
def infer(provider:str,audio:bytes,prompt:str,max_tokens:int,temperature:float,top_p:float,top_k:int)->str:
    if provider not in SPEC["models"]:raise ValueError("unknown MOSS-Music provider")
    import tempfile, torch
    from src.audio_io import load_audio
    from src.modeling_moss_music import MossMusicModel
    from src.processing_moss_music import MossMusicProcessor
    assets,_,inventory=asset_state()
    if not assets or inventory is None:raise RuntimeError("MOSS-Music assets are not verified")
    path=ASSETS/inventory["models"][provider]["path"]
    if provider not in _loaded:
        model=MossMusicModel.from_pretrained(str(path),trust_remote_code=True,torch_dtype="auto",device_map="cuda:0"); model.eval()
        _loaded[provider]=(model,MossMusicProcessor.from_pretrained(str(path),trust_remote_code=True,enable_time_marker=True))
    model,processor=_loaded[provider]
    with tempfile.NamedTemporaryFile(suffix=".audio") as f:
        f.write(audio);f.flush();raw=load_audio(f.name,sample_rate=processor.config.mel_sr)
    inputs=processor(text=prompt,audios=[raw],return_tensors="pt").to(model.device)
    if inputs.get("audio_data") is not None:inputs["audio_data"]=inputs["audio_data"].to(model.dtype)
    inputs["audio_input_mask"]=inputs["input_ids"]==processor.audio_token_id
    with torch.no_grad(): ids=model.generate(**inputs,max_new_tokens=max_tokens,do_sample=temperature>0,temperature=max(temperature,0.01),top_p=top_p,top_k=top_k,use_cache=True)
    return processor.decode(ids[0,inputs["input_ids"].shape[1]:],skip_special_tokens=True)
class ReasonRequest(BaseModel):
    provider:Literal["MOSS_MUSIC_INSTRUCT","MOSS_MUSIC_THINKING"]; prompt:str=Field(min_length=1,max_length=4000); audioBase64:str; maxTokens:int=Field(default=512,ge=1,le=2048); temperature:float=Field(default=0.0,ge=0,le=2); topP:float=Field(default=0.8,gt=0,le=1); topK:int=Field(default=50,ge=1,le=200)
app=FastAPI(title="MOSS-Music isolated semantic reasoning")
@app.get("/health")
def health(request:Request)->dict[str,Any]:
    auth(request);runtime,msg=runtime_state();compatibility,compatibility_msg,compatibility_sha=compatibility_state();assets,asset_msg,_=asset_state();smoke,smoke_msg=smoke_state();ready=runtime and compatibility and assets and smoke
    provider=request.query_params.get("provider")
    if provider is not None and provider not in SPEC["models"]: raise HTTPException(404,"unknown MOSS-Music provider")
    image_evidence=os.getenv("MOSS_MUSIC_IMAGE_EVIDENCE","")
    checksum=image_evidence.removeprefix("sha256:") if image_evidence.startswith("sha256:") else "unavailable"
    return {
        "provider":provider or "MOSS_MUSIC","providerFamily":"MOSS_MUSIC","providers":list(SPEC["models"]),
        "status":"ready" if ready else "blocked","healthy":ready,"runtimeReady":runtime,
        "checkpointReady":assets,"packageReady":runtime,"compatibilityReady":compatibility,
        "pipCheckPassed":compatibility,"mediaPreflightPassed":compatibility,"smokeTested":smoke,
        "version":SPEC["source"]["revision"],"modelVersion":SPEC["source"]["revision"],
        "sourceRevision":f"{SPEC['source']['repository']}@{SPEC['source']['revision']}",
        "sglangRevision":SPEC["sglang"]["revision"],
        "runtimePackages":runtime_identity() if runtime else {},
        "modelIdentities":SPEC["models"],"fixture":SPEC["smoke_input"],
        "checksum":checksum,"imageEvidence":image_evidence,
        "compatibilityEvidenceSha256":compatibility_sha if compatibility else "unavailable",
        "assetManifestSha256":sha(ASSETS/SPEC["asset_manifest"]) if assets else "unavailable",
        "smokeEvidenceSha256":sha(SMOKE/SPEC["smoke_proof"]) if smoke else "unavailable",
        "message":"ready" if ready else (msg if not runtime else compatibility_msg if not compatibility else asset_msg if not assets else smoke_msg),
        "semanticOnly":True,"canonicalTruth":False,
    }
@app.post("/reason")
def reason(payload:ReasonRequest,request:Request)->dict[str,Any]:
    auth(request);compatibility,_,_=compatibility_state();assets,_,inventory=asset_state();smoke,_=smoke_state()
    if not compatibility or not assets or not smoke or inventory is None:raise HTTPException(503,"MOSS-Music is BLOCKED until package, runtime, immutable assets, and real inference smoke verify")
    try: audio=base64.b64decode(payload.audioBase64,validate=True)
    except ValueError as exc:raise HTTPException(422,"audioBase64 is invalid") from exc
    if not audio:raise HTTPException(422,"audioBase64 is empty")
    result=infer(payload.provider,audio,payload.prompt,payload.maxTokens,payload.temperature,payload.topP,payload.topK)
    if not result.strip():raise HTTPException(502,"MOSS-Music returned an empty inference result")
    artifact={"provider":payload.provider,"semanticChannel":"MUSICAL_SEMANTIC_REASONING","canonicalTruth":False,"response":result,"prompt":payload.prompt,"createdAt":time.time(),"provenance":{"source":SPEC["source"],"model":inventory["models"][payload.provider]["repository"],"snapshotRevision":inventory["models"][payload.provider]["revision"],"runtime":SPEC["runtime"],"parameters":payload.model_dump(exclude={"audioBase64"})}}
    ident=uuid.uuid4().hex;ARTIFACTS.mkdir(mode=0o750,parents=True,exist_ok=True);path=ARTIFACTS/f"{ident}.json";path.write_text(json.dumps(artifact,sort_keys=True))
    return {**artifact,"artifactUrl":f"/artifacts/{ident}","artifactSha256":sha(path)}
@app.get("/artifacts/{artifact_id}")
def artifact(artifact_id:str,request:Request)->Response:
    auth(request)
    if not artifact_id.isalnum() or len(artifact_id)!=32:raise HTTPException(404,"artifact not found")
    path=ARTIFACTS/f"{artifact_id}.json"
    if not path.is_file():raise HTTPException(404,"artifact not found")
    return Response(path.read_bytes(),media_type="application/json",headers={"ETag":sha(path)})