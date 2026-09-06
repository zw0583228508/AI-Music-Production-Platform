"""Fail-closed, bearer-protected real MusicGen text and melody inference."""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text(encoding="utf-8"))
ASSET_ROOT = Path(os.getenv("MUSICGEN_ASSET_ROOT", SPEC["asset_root"]))
ARTIFACT_ROOT = Path(os.getenv("MUSICGEN_ARTIFACT_ROOT", "/var/lib/musicgen/artifacts"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _auth(request: Request) -> None:
    expected = os.getenv("MUSICGEN_API_TOKEN")
    if not expected:
        raise HTTPException(503, "MusicGen authentication is not configured")
    if not hmac.compare_digest(request.headers.get("Authorization", ""), f"Bearer {expected}"):
        raise HTTPException(401, "invalid bearer token")


def runtime_state() -> tuple[bool, str]:
    """Verify the actual process/runtime rather than trusting the image label."""
    if sys.version_info[:2] != (3, 9):
        return False, "MusicGen Python runtime does not match the pinned 3.9 runtime"
    try:
        import torch
        torch_ok = torch.__version__.split("+", 1)[0] == "2.1.0"
        source = subprocess.check_output(
            ["git", "-C", "/opt/audiocraft", "rev-parse", "HEAD"], text=True
        ).strip()
        ffmpeg = subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]
        major = int(ffmpeg.split("version", 1)[1].strip().split(".", 1)[0])
    except (ImportError, OSError, ValueError, subprocess.CalledProcessError, IndexError):
        return False, "MusicGen pinned runtime evidence is unavailable"
    if not torch_ok or source != SPEC["source"]["revision"] or major >= SPEC["runtime"]["ffmpeg_major_less_than"]:
        return False, "MusicGen package/runtime does not match its pinned identity"
    return True, "MusicGen package/runtime verified"


def asset_state() -> tuple[bool, str, dict[str, Any] | None]:
    if os.getenv(SPEC["license"]["acceptance_environment"]) != SPEC["license"]["required_value"]:
        return False, "MusicGen CC-BY-NC-4.0 weights have not been explicitly accepted", None
    runtime_ok, runtime_message = runtime_state()
    if not runtime_ok:
        return False, runtime_message, None
    try:
        inventory = json.loads((ASSET_ROOT / SPEC["asset_manifest"]).read_text(encoding="utf-8"))
        models = inventory["models"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return False, "MusicGen immutable model inventory is unavailable", None
    for mode, wanted in SPEC["models"].items():
        if wanted.get("status") == "BLOCKED_NO_WEIGHTS":
            continue
        item = models.get(mode)
        if not isinstance(item, dict) or item.get("repository") != wanted["repository"]:
            return False, f"MusicGen {mode} inventory identity is invalid", None
        revision = item.get("resolvedRevision")
        if not isinstance(revision, str) or len(revision) != 40 or item.get("requestedRevision") != wanted["requested_revision"]:
            return False, f"MusicGen {mode} immutable revision is invalid", None
        files = item.get("files")
        if not isinstance(files, list) or not files:
            return False, f"MusicGen {mode} inventory is empty", None
        for entry in files:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                return False, f"MusicGen {mode} inventory entry is invalid", None
            path = ASSET_ROOT / str(item["path"]) / entry["path"]
            if not path.is_file() or path.stat().st_size != entry.get("bytes") or _sha256(path) != entry.get("sha256"):
                return False, f"MusicGen {mode} checkpoint file verification failed", None
    for name, wanted in SPEC.get("dependencies", {}).items():
        item = inventory.get("dependencies", {}).get(name)
        if (
            not isinstance(item, dict)
            or item.get("repository") != wanted["repository"]
            or item.get("resolvedRevision") != wanted["resolved_revision"]
            or not item.get("files")
        ):
            return False, f"MusicGen {name} dependency inventory is invalid", None
        for entry in item["files"]:
            path = ASSET_ROOT / item["path"] / entry["path"]
            if not path.is_file() or path.stat().st_size != entry.get("bytes") or _sha256(path) != entry.get("sha256"):
                return False, f"MusicGen {name} dependency verification failed", None
    return True, "MusicGen assets verified", inventory


def smoke_state() -> tuple[bool, str]:
    assets, _, inventory = asset_state()
    if not assets or inventory is None:
        return False, "assets unavailable"
    try:
        proof = json.loads((ASSET_ROOT / SPEC["smoke_proof"]).read_text(encoding="utf-8"))
        valid = (proof["realInference"] is True and proof["text"]["nonSilent"] is True
                 and proof["melody"]["nonSilent"] is True and proof["melody"]["notSourceCopy"] is True
                 and proof["assetManifestSha256"] == _sha256(ASSET_ROOT / SPEC["asset_manifest"]))
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        valid = False
    return (True, "real MusicGen text and melody smoke verified") if valid else (False, "real MusicGen smoke proof is unavailable")


def _load_model(mode: str):
    from audiocraft.models import MusicGen
    # The directory was retrieved under a verified immutable SHA during
    # provisioning; this call cannot select main or an alternate model.
    return MusicGen.get_pretrained(str(ASSET_ROOT / mode), device="cuda")


def _wave_bytes(wav: Any, sample_rate: int) -> bytes:
    import torchaudio
    stream = io.BytesIO()
    torchaudio.save(stream, wav.detach().cpu(), sample_rate, format="wav")
    return stream.getvalue()


def _wav_duration(wav: bytes) -> float:
    import soundfile
    info = soundfile.info(io.BytesIO(wav))
    if info.samplerate <= 0 or info.frames <= 0:
        raise RuntimeError("MusicGen produced an invalid WAV artifact")
    return info.frames / info.samplerate


def _generate(mode: str, prompt: str, duration: float, seed: int, temperature: float,
              top_k: int, top_p: float, guidance: float, melody_wav: Optional[bytes] = None) -> tuple[bytes, int]:
    import torch
    model = _load_model(mode)
    model.set_generation_params(duration=duration, use_sampling=True, temperature=temperature,
                                top_k=top_k, top_p=top_p, cfg_coef=guidance)
    torch.manual_seed(seed)
    if melody_wav is None:
        output = model.generate([prompt])
    else:
        import torchaudio
        source, rate = torchaudio.load(io.BytesIO(melody_wav))
        output = model.generate_with_chroma([prompt], source[None].cuda(), rate)
    return _wave_bytes(output[0], model.sample_rate), model.sample_rate


class GenerateRequest(BaseModel):
    mode: Literal["text", "melody"]
    providerId: Optional[Literal["MUSICGEN_LARGE", "MUSICGEN_MELODY_LARGE", "JASCO_CHORDS_DRUMS_MELODY"]] = None
    prompt: str = Field(min_length=1, max_length=1000)
    duration: float = Field(default=8, gt=0, le=30)
    seed: int = Field(default=0, ge=0, le=2**31 - 1)
    temperature: float = Field(default=1.0, gt=0, le=2)
    topK: int = Field(default=250, ge=0, le=1000)
    topP: float = Field(default=0.0, ge=0, le=1)
    guidance: float = Field(default=3.0, ge=0, le=10)
    melodyWavBase64: Optional[str] = None
    drumsWavBase64: Optional[str] = None
    chroma: Optional[list[list[float]]] = None


app = FastAPI(title="MusicGen isolated provider")


@app.get("/providers")
def providers(request: Request) -> dict[str, Any]:
    _auth(request)
    registry = {
        provider_id: {**details, "status": SPEC["models"][details["model_key"]].get("status", "AVAILABLE")}
        for provider_id, details in SPEC["provider_registry"].items()
    }
    return {"providerFamily": "AUDIOCRAFT_GENERATION", "providers": registry}


@app.get("/health")
def health(request: Request) -> dict[str, Any]:
    _auth(request)
    assets, message, _ = asset_state()
    smoke, smoke_message = smoke_state()
    runtime_ok, runtime_message = runtime_state()
    return {"provider": "MUSICGEN", "status": "ready" if assets and smoke else "blocked",
            "healthy": runtime_ok and assets and smoke, "runtimeVerified": runtime_ok,
            "assetsVerified": assets, "smokeTested": smoke,
            "message": "ready" if runtime_ok and assets and smoke else (
                runtime_message if not runtime_ok else (message if not assets else smoke_message)),
            "runtime": SPEC["runtime"], "source": SPEC["source"],
            "imageEvidence": os.getenv("MUSICGEN_IMAGE_EVIDENCE", "unavailable")}


@app.post("/generate")
def generate(payload: GenerateRequest, request: Request) -> dict[str, Any]:
    _auth(request)
    assets, _, inventory = asset_state()
    smoke, _ = smoke_state()
    if not assets or not smoke or inventory is None:
        raise HTTPException(503, "MusicGen is BLOCKED until package, runtime, assets, and real smoke verify")
    expected_provider = "MUSICGEN_LARGE" if payload.mode == "text" else "MUSICGEN_MELODY_LARGE"
    if payload.providerId and payload.providerId != expected_provider:
        raise HTTPException(422, "providerId does not match the requested MusicGen mode; use /jasco for JASCO")
    melody = None
    if payload.mode == "melody":
        if not payload.melodyWavBase64:
            raise HTTPException(422, "melody mode requires melodyWavBase64")
        try:
            melody = base64.b64decode(payload.melodyWavBase64, validate=True)
        except ValueError as exc:
            raise HTTPException(422, "melodyWavBase64 is invalid") from exc
    elif payload.melodyWavBase64 is not None:
        raise HTTPException(422, "text mode must not include melody audio")
    wav, sample_rate = _generate(payload.mode, payload.prompt, payload.duration, payload.seed,
                                 payload.temperature, payload.topK, payload.topP, payload.guidance, melody)
    artifact_id = uuid.uuid4().hex
    ARTIFACT_ROOT.mkdir(mode=0o750, parents=True, exist_ok=True)
    path = ARTIFACT_ROOT / f"{artifact_id}.wav"
    path.write_bytes(wav)
    checkpoint = inventory["models"][payload.mode]["resolvedRevision"]
    return {"provider": "MUSICGEN", "mode": payload.mode, "wavBase64": base64.b64encode(wav).decode("ascii"),
            "artifactUrl": f"/artifacts/{artifact_id}", "sampleRate": sample_rate, "duration": _wav_duration(wav),
            "seed": payload.seed, "temperature": payload.temperature, "topK": payload.topK, "topP": payload.topP,
            "guidance": payload.guidance, "checkpointSha": checkpoint, "artifactSha256": _sha256(path),
            "runtime": SPEC["runtime"], "imageEvidence": os.getenv("MUSICGEN_IMAGE_EVIDENCE", "unavailable")}


@app.post("/jasco")
def jasco(payload: GenerateRequest, request: Request) -> dict[str, Any]:
    """Reject JASCO until a reviewed immutable checkpoint is provisioned."""
    _auth(request)
    if SPEC["models"]["jasco"].get("status") == "BLOCKED_NO_WEIGHTS":
        raise HTTPException(
            503,
            "JASCO is BLOCKED_NO_WEIGHTS: no reviewed immutable checkpoint is provisioned; execution is disabled",
        )
    raise HTTPException(503, "JASCO execution is not implemented")


@app.get("/artifacts/{artifact_id}")
def artifact(artifact_id: str, request: Request) -> Response:
    _auth(request)
    if not artifact_id.isalnum() or len(artifact_id) != 32:
        raise HTTPException(404, "artifact not found")
    path = ARTIFACT_ROOT / f"{artifact_id}.wav"
    if not path.is_file():
        raise HTTPException(404, "artifact not found")
    return Response(path.read_bytes(), media_type="audio/wav", headers={"ETag": _sha256(path)})