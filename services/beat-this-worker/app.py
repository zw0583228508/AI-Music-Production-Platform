"""Dedicated, authenticated Beat This GPU inference boundary."""
from __future__ import annotations
import base64, hashlib, hmac, ipaddress, json, os, platform, re, socket, tempfile, threading, time
from http.client import HTTPConnection, HTTPSConnection
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from urllib.parse import urlparse
import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, HttpUrl

HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "model_manifest.json").read_text())
ASSET_ROOT = Path(os.getenv("BEAT_THIS_ASSET_ROOT", "/var/lib/beat-this")).resolve()
CHECKPOINT = ASSET_ROOT / MANIFEST["checkpointPath"]
READINESS = ASSET_ROOT / ".readiness" / "beat_this.json"
MAX_BYTES = 25 * 1024 * 1024
TRACKER = None
TRACKER_LOCK = threading.Lock()
app = FastAPI(title="Beat This Worker", version="1.1.0")

def auth(request: Request) -> None:
    token = (
        os.getenv("BEAT_THIS_WORKER_TOKEN")
        or os.getenv("MUSIC_AI_WORKER_TOKEN")
        or ""
    ).strip()
    if not token or not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {token}"):
        raise HTTPException(401, "worker authentication is required")

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""): digest.update(block)
    return digest.hexdigest()

def asset_ready() -> bool:
    return CHECKPOINT.is_file() and sha256(CHECKPOINT) == MANIFEST["checkpointSha256"]

def runtime_ready() -> bool:
    try:
        import torch
        return (version("beat-this") == MANIFEST["version"] and
                platform.python_version() == MANIFEST["runtime"]["python"] and
                torch.__version__ == MANIFEST["runtime"]["pytorch"] and
                all(version(name) == MANIFEST["runtime"][name] for name in (
                    "torchvision", "torchaudio", "transformers", "accelerate"
                )) and
                ".".join(str(torch.version.cuda or "").split(".")[:2]) ==
                    ".".join(MANIFEST["runtime"]["cuda"].split(".")[:2]) and
                torch.cuda.is_available())
    except (ImportError, PackageNotFoundError): return False

def smoke_ready() -> bool:
    try: proof = json.loads(READINESS.read_text())
    except (OSError, json.JSONDecodeError): return False
    return (proof.get("provider") == "BEAT_THIS" and proof.get("featureExecutionSucceeded") is True and
            proof.get("checkpoint", {}).get("sha256") == MANIFEST["checkpointSha256"] and
            proof.get("torch") == MANIFEST["runtime"]["pytorch"] and
            proof.get("torchaudio") == MANIFEST["runtime"]["torchaudio"])

def tracker():
    global TRACKER
    if not asset_ready(): raise RuntimeError("verified final0 checkpoint is unavailable; downloads are disabled")
    with TRACKER_LOCK:
        if TRACKER is None:
            from beat_this.inference import File2Beats
            TRACKER = File2Beats(checkpoint_path=str(CHECKPOINT), device="cuda", dbn=False)
    return TRACKER

def analyze_path(path: Path) -> dict:
    beats, downbeats = tracker()(str(path))
    beats, downbeats = np.asarray(beats, float), np.asarray(downbeats, float)
    if beats.size < 2 or not np.isfinite(beats).all() or not np.isfinite(downbeats).all():
        raise ValueError("Beat This produced insufficient evidence")
    intervals = np.diff(beats)
    confidence = float(np.clip(1 - np.std(intervals) / max(np.mean(intervals), 1e-9), 0, 1))
    return {"beats": beats.round(6).tolist(), "downbeats": downbeats.round(6).tolist(),
            "confidence": round(confidence, 6), "version": MANIFEST["version"]}

def fetch(url: str, directory: Path) -> Path:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(400, "sourceUrl must be a public http(s) URL")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise HTTPException(400, "sourceUrl must resolve only to global addresses")
    family, _, _, _, address = addresses[0]
    connection = (HTTPSConnection if parsed.scheme == "https" else HTTPConnection)(parsed.hostname, port, timeout=30)
    sock = socket.socket(family, socket.SOCK_STREAM); sock.settimeout(30); sock.connect(address)
    if isinstance(connection, HTTPSConnection): sock = connection._context.wrap_socket(sock, server_hostname=parsed.hostname)
    connection.sock = sock
    try:
        connection.request("GET", (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else ""))
        response = connection.getresponse()
        if not 200 <= response.status < 300: raise HTTPException(400, "source server returned an unsuccessful response")
        target, total = directory / "source.audio", 0
        with target.open("wb") as output:
            while block := response.read(65536):
                total += len(block)
                if total > MAX_BYTES: raise HTTPException(413, "source exceeds download size limit")
                output.write(block)
        return target
    finally: connection.close()

class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    provider: str
    source_url: HttpUrl | None = Field(default=None, alias="sourceUrl")
    audio_base64: str | None = Field(default=None, alias="audioBase64")

@app.get("/health", dependencies=[Depends(auth)])
def health(provider: str = "BEAT_THIS") -> dict:
    if provider != "BEAT_THIS": raise HTTPException(404, "provider is not exposed")
    package_ready, assets, smoke = runtime_ready(), asset_ready(), smoke_ready()
    ready = package_ready and assets and smoke
    modal_image_id = os.getenv("MODAL_IMAGE_ID", "").strip()
    modal_app_id = os.getenv("BEAT_THIS_MODAL_APP_ID", "").strip()
    modal_deployment_id = os.getenv("BEAT_THIS_MODAL_DEPLOYMENT_ID", "").strip()
    modal_function_id = os.getenv("BEAT_THIS_MODAL_FUNCTION_ID", "").strip()
    source_revision = os.getenv("BEAT_THIS_SOURCE_REVISION", "").strip()
    source_image_digest = os.getenv("BEAT_THIS_SOURCE_IMAGE_DIGEST", "").strip().lower()
    identity_ready = (
        bool(modal_app_id and modal_deployment_id and modal_function_id)
        and bool(re.fullmatch(r"im-[A-Za-z0-9]+", modal_image_id))
        and bool(re.fullmatch(r"[a-f0-9]{40}", source_revision))
        and bool(re.fullmatch(r"sha256:[a-f0-9]{64}", source_image_digest))
    )
    ready = package_ready and assets and smoke and identity_ready
    runtime = MANIFEST["runtime"]
    return {"provider": "BEAT_THIS", "status": "ready" if ready else "not_ready", "ready": ready,
            "modelVersion": MANIFEST["version"], "checksum": MANIFEST["checkpointSha256"],
            "checkpointSha256": MANIFEST["checkpointSha256"],
            "revision": MANIFEST["sourceCommit"],
            "sourceRevision": source_revision,
            "sourceImageDigest": source_image_digest,
            "modalAppId": modal_app_id, "modalDeploymentId": modal_deployment_id,
            "modalFunctionId": modal_function_id, "modalImageId": modal_image_id,
            "runtime": {"pythonVersion": runtime["python"]},
            "framework": {
                "python": runtime["python"], "cuda_image": runtime["cudaImage"],
                "cuda": runtime["cuda"], "pytorch": runtime["pytorch"],
                "torchvision": runtime["torchvision"], "torchaudio": runtime["torchaudio"],
                "torch_index_url": runtime["torchIndexUrl"],
                "transformers": runtime["transformers"], "accelerate": runtime["accelerate"],
            },
            "packageName": "beat-this", "packageVersion": MANIFEST["version"],
            "packageReady": package_ready, "assetReady": assets, "featureExecutionReady": smoke,
            "runtimeReady": package_ready, "checkpointReady": assets, "smokeTested": smoke,
            "gpuReady": package_ready, "identityReady": identity_ready,
            "reason": None if ready else "reviewed runtime, final0, real-audio smoke proof, and complete deployment identity are required"}

@app.post("/analyze", dependencies=[Depends(auth)])
def analyze(request: AnalyzeRequest) -> dict:
    if request.provider != "BEAT_THIS": raise HTTPException(422, "provider must be BEAT_THIS")
    if bool(request.source_url) == bool(request.audio_base64): raise HTTPException(422, "exactly one audio source is required")
    if not runtime_ready() or not asset_ready(): raise HTTPException(503, "Beat This runtime is not attested")
    with tempfile.TemporaryDirectory(prefix="beat-this-") as tmp:
        directory = Path(tmp)
        if request.audio_base64:
            try: raw = base64.b64decode(request.audio_base64, validate=True)
            except Exception as exc: raise HTTPException(422, "audioBase64 is invalid") from exc
            if not raw or len(raw) > MAX_BYTES: raise HTTPException(413, "audioBase64 exceeds size limit")
            path = directory / "source.wav"; path.write_bytes(raw)
        else: path = fetch(str(request.source_url), directory)
        try:
            info = sf.info(path)
            if not 0 < info.duration <= 300: raise ValueError("duration")
            result = analyze_path(path)
        except Exception as exc: raise HTTPException(503, "BEAT_THIS feature execution failed") from exc
    return {"provider": "BEAT_THIS", "status": "ok", "result": result, "executedAt": int(time.time())}