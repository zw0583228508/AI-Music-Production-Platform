"""Bearer-protected, fail-closed SheetSage 0.2.1 production service."""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import platform
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any
from importlib.metadata import distribution, version

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from inference import InferenceError, run

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSET_ROOT = Path(os.getenv("SHEETSAGE_ASSET_ROOT", SPEC["asset_root"]))
ASSET_MANIFEST = ASSET_ROOT / SPEC["asset_manifest"]


def _token() -> str | None:
    return os.getenv("SHEETSAGE_API_TOKEN") or os.getenv("MUSIC_AI_WORKER_TOKEN")


def _auth(request: Request) -> None:
    token = _token()
    supplied = request.headers.get("Authorization", "")
    if not token:
        raise HTTPException(503, "SheetSage authentication is not configured")
    if not hmac.compare_digest(supplied, f"Bearer {token}"):
        raise HTTPException(401, "invalid bearer token")


def _digest(path: Path) -> str:
    hash_ = hashlib.sha256()
    with path.open("rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            hash_.update(part)
    return hash_.hexdigest()


def distribution_digest(name: str) -> str:
    installed = distribution(name)
    digest = hashlib.sha256()
    files = installed.files
    if not files:
        raise RuntimeError(f"{name} distribution file inventory is unavailable")
    for relative in sorted(files, key=str):
        if relative.suffix == ".pyc" or "__pycache__" in relative.parts:
            continue
        path = Path(installed.locate_file(relative))
        if not path.is_file():
            continue
        digest.update(str(relative).encode())
        digest.update(b"\0")
        with path.open("rb") as source:
            for part in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(part)
    return digest.hexdigest()


def runtime_identity() -> str:
    files = {
        name: _digest(ROOT / name)
        for name in ("app.py", "inference.py", "smoke.py", "model_manifest.json")
    }
    identity = {
        "files": files,
        "python": platform.python_version(),
        "packages": {
            name: {
                "version": version(name),
                "contentSha256": distribution_digest(name),
            }
            for name in ("sheetsage-infer", "jukebox-infer", "madmom-infer")
        },
    }
    return hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def sign_smoke_proof(value: dict[str, Any]) -> str:
    token = _token()
    if not token:
        raise RuntimeError("SheetSage authentication is not configured")
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(token.encode(), encoded, hashlib.sha256).hexdigest()


def asset_state() -> tuple[bool, str, dict[str, Any] | None]:
    if os.getenv(SPEC["license"]["acceptance_environment"]) != SPEC["license"]["required_value"]:
        return False, "SheetSage model license is not accepted", None
    try:
        inventory = json.loads(ASSET_MANIFEST.read_text())
        entries = inventory["assets"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return False, "SheetSage asset inventory is unavailable", None
    if inventory.get("package") != SPEC["package"] or not isinstance(entries, list) or not entries:
        return False, "SheetSage asset inventory identity is invalid", None
    actual_inventory = {
        entry.get("path"): entry.get("sha256") for entry in entries
        if isinstance(entry, dict)
    }
    if actual_inventory != SPEC["required_asset_sha256"]:
        return False, "SheetSage asset inventory does not match required checkpoints", None
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            return False, "SheetSage asset inventory is invalid", None
        path = ASSET_ROOT / entry["path"]
        if not path.is_file() or path.stat().st_size != entry.get("bytes") or _digest(path) != entry.get("sha256"):
            return False, "SheetSage asset hash verification failed", None
    return True, "SheetSage assets verified", inventory


def smoke_state() -> tuple[bool, str]:
    proof = ASSET_ROOT / "smoke-proof.json"
    ready, _, inventory = asset_state()
    if not ready or not inventory:
        return False, "assets unavailable"
    try:
        value = json.loads(proof.read_text())
        signature = value.pop("signature")
        valid = (
            value["realInference"] is True
            and value["package"] == SPEC["package"]
            and value["assetManifestSha256"] == _digest(ASSET_MANIFEST)
            and value["runtimeSha256"] == runtime_identity()
            and isinstance(value["fixtureSha256"], str)
            and isinstance(value["outputSha256"], str)
            and all(
                len(digest) == 64
                and all(character in "0123456789abcdef" for character in digest)
                for digest in (value["fixtureSha256"], value["outputSha256"])
            )
            and isinstance(signature, str)
            and hmac.compare_digest(signature, sign_smoke_proof(value))
        )
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        valid = False
    return (True, "real inference smoke proof verified") if valid else (False, "real inference smoke proof is unavailable")


def _number(value: Any, label: str, minimum: float = 0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise InferenceError(f"invalid {label}")
    return float(value)


def validate_evidence(value: dict[str, Any]) -> dict[str, Any]:
    melody, chords, timing, confidence = (value.get(key) for key in ("melody", "chords", "timing", "confidence"))
    if not all(isinstance(item, list) and item for item in (melody, chords, timing)):
        raise InferenceError("SheetSage returned incomplete musical evidence")
    _number(confidence, "confidence")
    if float(confidence) > 1:
        raise InferenceError("invalid confidence")
    for index, note in enumerate(melody):
        if not isinstance(note, dict):
            raise InferenceError(f"invalid melody event {index}")
        _number(note.get("start"), "melody start")
        end = _number(note.get("end"), "melody end")
        if end <= _number(note.get("start"), "melody start") or not isinstance(note.get("pitch"), int):
            raise InferenceError(f"invalid melody event {index}")
        _number(note.get("confidence"), "melody confidence")
        if float(note["confidence"]) > 1:
            raise InferenceError(f"invalid melody event {index}")
    for index, chord in enumerate(chords):
        if not isinstance(chord, dict) or not isinstance(chord.get("symbol"), str) or not chord["symbol"].strip():
            raise InferenceError(f"invalid chord event {index}")
        if _number(chord.get("end"), "chord end") <= _number(chord.get("start"), "chord start"):
            raise InferenceError(f"invalid chord event {index}")
        _number(chord.get("confidence"), "chord confidence")
        if float(chord["confidence"]) > 1:
            raise InferenceError(f"invalid chord event {index}")
    return {"provider": "SHEETSAGE", "modelVersion": SPEC["package"]["version"],
            "melody": melody, "chords": chords, "timing": timing, "confidence": confidence}


def _environment_integer(name: str, default: int, minimum: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}")
    return value


app = FastAPI(title="SheetSage 0.2.1")
MAX_AUDIO_BYTES = 512 * 1024 * 1024
TEMP_DIRECTORY = Path(os.getenv("SHEETSAGE_TEMP_DIR", tempfile.gettempdir()))
TEMP_DISK_HEADROOM_BYTES = _environment_integer(
    "SHEETSAGE_TEMP_DISK_HEADROOM_BYTES", 256 * 1024 * 1024, 0
)
MAX_SPOOLED_ANALYSES = _environment_integer(
    "SHEETSAGE_MAX_SPOOLED_ANALYSES", 1, 1
)
TEMP_DIRECTORY.mkdir(parents=True, exist_ok=True)
SUPPORTED_AUDIO_SUFFIXES = {
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-m4a": ".m4a",
    "audio/x-wav": ".wav",
}


class SpoolReservations:
    """Reserve worst-case temporary storage before consuming request bodies."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._uploads: dict[str, int] = {}

    def state(self) -> dict[str, int]:
        with self._lock:
            disk = shutil.disk_usage(TEMP_DIRECTORY)
            outstanding = sum(MAX_AUDIO_BYTES - written for written in self._uploads.values())
            reservable = max(0, disk.free - TEMP_DISK_HEADROOM_BYTES - outstanding)
            return {
                "temporaryDiskTotalBytes": disk.total,
                "temporaryDiskFreeBytes": disk.free,
                "temporaryDiskHeadroomBytes": TEMP_DISK_HEADROOM_BYTES,
                "temporaryDiskReservableBytes": reservable,
                "activeSpooledAnalyses": len(self._uploads),
                "maxSpooledAnalyses": MAX_SPOOLED_ANALYSES,
                "reservedUploadBytes": outstanding,
                "maxAudioBytes": MAX_AUDIO_BYTES,
            }

    def acquire(self) -> str | None:
        with self._lock:
            disk = shutil.disk_usage(TEMP_DIRECTORY)
            outstanding = sum(MAX_AUDIO_BYTES - written for written in self._uploads.values())
            if (
                len(self._uploads) >= MAX_SPOOLED_ANALYSES
                or disk.free - TEMP_DISK_HEADROOM_BYTES - outstanding < MAX_AUDIO_BYTES
            ):
                return None
            reservation = uuid.uuid4().hex
            self._uploads[reservation] = 0
            return reservation

    def record(self, reservation: str, written: int) -> None:
        with self._lock:
            if reservation in self._uploads:
                self._uploads[reservation] = min(written, MAX_AUDIO_BYTES)

    def release(self, reservation: str) -> None:
        with self._lock:
            self._uploads.pop(reservation, None)


SPOOL_RESERVATIONS = SpoolReservations()


@app.get("/health")
def health(request: Request) -> dict[str, Any]:
    _auth(request)
    assets, message, _ = asset_state()
    smoke, smoke_message = smoke_state()
    license_accepted = (
        os.getenv(SPEC["license"]["acceptance_environment"])
        == SPEC["license"]["required_value"]
    )
    return {"provider": "SHEETSAGE", "version": SPEC["package"]["version"],
            "sourceRevision": SPEC["package"]["source_revision"], "assetsVerified": assets,
            "runtimeReady": True, "checkpointReady": assets,
            "smokeTested": smoke, "smokeProofVerified": smoke,
            "healthy": assets and smoke,
            "checksum": _digest(ASSET_MANIFEST) if assets else "",
            "status": "ready" if assets and smoke else (
                "blocked" if not license_accepted else "unavailable"
            ),
            "message": "ready" if assets and smoke else (message if not assets else smoke_message),
            **SPOOL_RESERVATIONS.state()}


@app.post("/analyze")
async def analyze(request: Request) -> dict[str, Any]:
    _auth(request)
    assets, _, _ = asset_state()
    smoke, _ = smoke_state()
    if not assets or not smoke:
        raise HTTPException(503, "SheetSage is not ready for real inference")
    declared_length = request.headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > MAX_AUDIO_BYTES:
                raise HTTPException(413, "audio payload exceeds 512 MiB")
        except ValueError as exc:
            raise HTTPException(400, "invalid content length") from exc
    reservation = SPOOL_RESERVATIONS.acquire()
    if reservation is None:
        raise HTTPException(
            503,
            "SheetSage temporary upload capacity is busy; retry later",
            headers={"Retry-After": "30"},
        )
    path: Path | None = None
    try:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        suffix = SUPPORTED_AUDIO_SUFFIXES.get(content_type, ".audio")
        with tempfile.NamedTemporaryFile(
            prefix="sheetsage-", suffix=suffix, delete=False, dir=TEMP_DIRECTORY
        ) as target:
            path = Path(target.name)
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_AUDIO_BYTES:
                    raise HTTPException(413, "audio payload exceeds 512 MiB")
                target.write(chunk)
                SPOOL_RESERVATIONS.record(reservation, size)
        if size == 0:
            raise HTTPException(400, "audio payload is empty")
        evidence = await run_in_threadpool(run, path, ASSET_ROOT, 300)
        return validate_evidence(evidence)
    except InferenceError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        if path is not None:
            path.unlink(missing_ok=True)
        SPOOL_RESERVATIONS.release(reservation)
