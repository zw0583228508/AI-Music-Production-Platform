"""Isolated, bearer-only AnyAccomp V2A endpoint; blocked absent immutable proof."""
from __future__ import annotations
import base64, hashlib, hmac, io, json, os, socket, tempfile, uuid, time
import ipaddress
from urllib.parse import urlparse
from urllib.request import Request as UrlRequest, urlopen
from pathlib import Path
from typing import Any
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
from inference import InferenceError, run

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("ANYACCOMP_ASSET_ROOT", SPEC["asset_root"]))
ARTIFACTS = Path(os.getenv("ANYACCOMP_ARTIFACT_ROOT", SPEC["artifact_root"]))

def sha(path: Path) -> str:
    item = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""): item.update(block)
    return item.hexdigest()

def auth(request: Request) -> None:
    token = os.getenv("ANYACCOMP_API_TOKEN")
    if not token: raise HTTPException(503, "AnyAccomp authentication is not configured")
    if not hmac.compare_digest(request.headers.get("Authorization", ""), f"Bearer {token}"):
        raise HTTPException(401, "invalid bearer token")

def artifact_capability(artifact: str, expires: int) -> str:
    token = os.getenv("ANYACCOMP_API_TOKEN", "")
    return hmac.new(token.encode(), f"{artifact}:{expires}".encode(), hashlib.sha256).hexdigest()

def state() -> tuple[bool, str, dict[str, Any] | None]:
    try: inventory = json.loads((ASSETS / SPEC["asset_manifest"]).read_text())
    except (OSError, ValueError): return False, "immutable AnyAccomp asset inventory is unavailable", None
    source, weights = inventory.get("source"), inventory.get("weights")
    if not isinstance(source, dict) or not isinstance(weights, dict) or source.get("repository") != SPEC["source"]["repository"]:
        return False, "AnyAccomp asset identity is invalid", None
    if source.get("revision") != SPEC["source"]["revision"] or source.get("checkedOutRevision") != source.get("revision") or weights.get("revision") != SPEC["weights"]["revision"]:
        return False, "AnyAccomp source or checkpoint revision does not match the reviewed manifest", None
    if not (ASSETS / "source" / SPEC["source"]["subdirectory"]).is_dir():
        return False, "AnyAccomp reviewed source checkout is unavailable", None
    entries = weights.get("files")
    if not isinstance(entries, list) or not entries: return False, "AnyAccomp checkpoint inventory is empty", None
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str): return False, "AnyAccomp inventory is invalid", None
        path = ASSETS / "weights" / entry["path"]
        if not path.is_file() or path.stat().st_size != entry.get("bytes") or sha(path) != entry.get("sha256"):
            return False, "AnyAccomp checkpoint hash verification failed", None
    return True, "AnyAccomp assets verified", inventory

def smoke() -> tuple[bool, str]:
    ready, _, _ = state()
    try:
        proof = json.loads((ASSETS / SPEC["smoke_proof"]).read_text())
        valid = ready and proof["realSourceConditionedInference"] is True and proof["nonSilent"] is True and proof["notSourceCopy"] is True and proof["assetManifestSha256"] == sha(ASSETS / SPEC["asset_manifest"])
    except (OSError, KeyError, ValueError, TypeError): valid = False
    return (True, "real source-conditioned non-copy smoke verified") if valid else (False, "real source-conditioned non-copy smoke proof is unavailable")

class Generate(BaseModel):
    vocalWavBase64: str | None = Field(default=None, min_length=1, max_length=50_000_000)
    vocalSource: dict[str, str] | None = None
    prompt: str = Field(default="", max_length=4000)

def private_vocal(url: str) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(422, "vocalSource must be an HTTPS signed private artifact URL")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise ValueError
    except (OSError, ValueError):
        raise HTTPException(422, "vocalSource host is not a public artifact host")
    try:
        with urlopen(UrlRequest(url, headers={"User-Agent": "AnyAccomp/1.0"}), timeout=30) as response:
            if response.geturl() != url or int(response.headers.get("Content-Length", "0")) > 50_000_000:
                raise ValueError
            data = response.read(50_000_000 + 1)
    except (OSError, ValueError):
        raise HTTPException(422, "vocalSource could not be fetched as a bounded private artifact")
    if not data or len(data) > 50_000_000:
        raise HTTPException(422, "vocalSource is empty or too large")
    return data

app = FastAPI(title="AnyAccomp isolated V2A provider")
@app.get("/health")
def health(request: Request) -> dict[str, Any]:
    auth(request); assets, message, inventory = state(); smoked, smoke_message = smoke()
    return {"provider": "ANYACCOMP", "modelVersion": SPEC["model_version"], "status": "blocked",
            "healthy": False, "runtimeReady": False, "checkpointReady": assets, "smokeTested": smoked,
            "assetManifestSha256": sha(ASSETS / SPEC["asset_manifest"]) if inventory else None,
            "message": "AnyAccomp is intentionally BLOCKED; promotion must independently attest runtime and commercial authorization." if assets and smoked else (message if not assets else smoke_message)}

@app.post("/generate")
def generate(payload: Generate, request: Request) -> dict[str, Any]:
    auth(request); assets, _, inventory = state(); smoked, _ = smoke()
    if not assets or not smoked: raise HTTPException(503, "AnyAccomp is BLOCKED until immutable assets and real non-copy smoke proof verify")
    if bool(payload.vocalWavBase64) == bool(payload.vocalSource):
        raise HTTPException(422, "provide exactly one of vocalWavBase64 or vocalSource")
    try:
        vocal = (base64.b64decode(payload.vocalWavBase64, validate=True)
                 if payload.vocalWavBase64 else private_vocal(payload.vocalSource["url"]))
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, "vocal input is invalid") from exc
    try: source_audio, source_rate = sf.read(io.BytesIO(vocal), always_2d=True)
    except RuntimeError as exc: raise HTTPException(422, "vocalWavBase64 must be a decodable WAV") from exc
    if len(source_audio) < source_rate // 10 or float(abs(source_audio).max()) < 1e-5: raise HTTPException(422, "vocal input is silent or too short")
    with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
        source, output = Path(temporary) / "vocal.wav", Path(temporary) / "accompaniment.wav"; source.write_bytes(vocal)
        try: run(source, output, payload.prompt, ASSETS)
        except InferenceError as exc: raise HTTPException(503, str(exc)) from exc
        try: generated, rate = sf.read(str(output), always_2d=True)
        except RuntimeError as exc: raise HTTPException(502, "AnyAccomp returned an invalid WAV") from exc
        if len(generated) == 0 or float(abs(generated).max()) < 1e-5 or sha(source) == sha(output): raise HTTPException(502, "AnyAccomp output failed non-silence/non-copy verification")
        artifact = uuid.uuid4().hex; ARTIFACTS.mkdir(parents=True, exist_ok=True); destination = ARTIFACTS / f"{artifact}.wav"; destination.write_bytes(output.read_bytes())
    expires = int(time.time()) + 600
    public_base = str(request.base_url).replace("http://", "https://", 1).rstrip("/")
    artifact_url = public_base + f"/artifacts/{artifact}?expires={expires}&capability={artifact_capability(artifact, expires)}"
    rendered_duration = len(generated) / rate
    result = {"provider": "ANYACCOMP", "modelVersion": SPEC["model_version"],
            "checkpointSha256": sha(ASSETS / SPEC["asset_manifest"]),
            "candidates": [{"label": "Source-conditioned accompaniment", "score": 0.5, "confidence": 0.5,
            "summary": "AnyAccomp accompaniment generated from the supplied isolated vocal.",
            "artifact": {"name": "anyaccomp-accompaniment.wav", "url": artifact_url, "contentType": "audio/wav",
                         "format": "wav", "bytes": destination.stat().st_size, "sha256": sha(destination),
                         "durationSeconds": rendered_duration, "sampleRate": rate, "channels": generated.shape[1]}}],
            "sourceSha256": hashlib.sha256(vocal).hexdigest(), "sampleRate": rate,
            "checkpointRevision": inventory["weights"]["revision"], "sourceRevision": inventory["source"]["revision"],
            "provenance": {"sourceConditioned": True, "nonSilentVerified": True, "notSourceCopyVerified": True}}
    return result

@app.get("/artifacts/{artifact}")
def artifact(artifact: str, request: Request) -> Response:
    supplied = request.headers.get("Authorization", "")
    expires, capability = request.query_params.get("expires"), request.query_params.get("capability")
    token = os.getenv("ANYACCOMP_API_TOKEN")
    valid_capability = False
    try:
        valid_capability = bool(token and expires and capability and int(expires) >= int(time.time()) and
                                hmac.compare_digest(capability, artifact_capability(artifact, int(expires))))
    except ValueError:
        valid_capability = False
    if not valid_capability:
        auth(request)
    if not artifact.isalnum() or len(artifact) != 32: raise HTTPException(404, "artifact not found")
    path = ARTIFACTS / f"{artifact}.wav"
    if not path.is_file(): raise HTTPException(404, "artifact not found")
    return Response(path.read_bytes(), media_type="audio/wav", headers={"ETag": sha(path)})