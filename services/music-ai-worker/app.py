"""Bounded, CPU-only music model worker. Run with `uv run uvicorn app:app`."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import ipaddress
import json
import copy
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from importlib.metadata import PackageNotFoundError, version as installed_version
from pathlib import Path
from typing import Literal
from http.client import HTTPConnection, HTTPSConnection
from urllib.parse import urlparse

import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request as FastAPIRequest, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field, HttpUrl

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())
MAX_DOWNLOAD_BYTES = int(os.getenv("MUSIC_AI_MAX_SOURCE_BYTES", 25 * 1024 * 1024))
MAX_INPUT_BYTES = int(os.getenv("MUSIC_AI_MAX_INPUT_BYTES", 25 * 1024 * 1024))
MAX_DURATION_SECONDS = float(os.getenv("MUSIC_AI_MAX_DURATION_SECONDS", "300"))
DOWNLOAD_TIMEOUT = float(os.getenv("MUSIC_AI_DOWNLOAD_TIMEOUT_SECONDS", "20"))
INFERENCE_TIMEOUT = float(os.getenv("MUSIC_AI_INFERENCE_TIMEOUT_SECONDS", "540"))
MAX_STEM_BYTES = min(int(os.getenv("MUSIC_AI_MAX_STEM_BYTES", 250 * 1024 * 1024)), 511 * 1024 * 1024)
MAX_SEPARATION_OUTPUT_BYTES = min(
    int(os.getenv("MUSIC_AI_MAX_SEPARATION_OUTPUT_BYTES", 500 * 1024 * 1024)),
    511 * 1024 * 1024,
)
MAX_SEPARATION_JSON_BYTES = 32 * 1024 * 1024
ARTIFACT_TTL_SECONDS = float(os.getenv("MUSIC_AI_ARTIFACT_TTL_SECONDS", "900"))
ARTIFACTS = ROOT / ".artifacts"
ARTIFACT_ID = re.compile(r"^[A-Za-z0-9_-]{32,}$")
ASSET_ROOT = Path(os.getenv("MUSIC_AI_ASSET_ROOT", "/var/lib/music-ai/assets")).resolve()
ASSET_MANIFEST_PATH = Path(
    os.getenv("MUSIC_AI_ASSET_MANIFEST", str(ASSET_ROOT / "licensed_assets.json"))
).resolve()
MAX_RENDER_SECONDS = float(os.getenv("MUSIC_AI_MAX_RENDER_SECONDS", "300"))
MAX_ASSET_UPLOAD_BYTES = int(os.getenv("MUSIC_AI_MAX_ASSET_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024)))
ASSET_STATE_FILENAME = ".licensed_asset_state.json"
ASSET_STATE_LOCK = threading.Lock()
NATIVE_ADAPTER_REQUIREMENTS = {
    "VST3": [
        "an approved executable native MIDI host",
        "a compatible licensed VST3 asset",
        "asset and host SHA-256 values in the private manifest",
        "approved instrument/control mappings",
        "canonical TrackModel smoke evidence with host and output attestation",
    ],
    "SFIZZ_VSCO2_CE": [
        "an approved executable sfizz native host",
        "a compatible licensed VSCO/SFZ library",
        "library and host SHA-256 values in the private manifest",
        "approved instrument/control mappings",
        "canonical TrackModel smoke evidence with host and output attestation",
    ],
}

app = FastAPI(title="Music AI Worker", version="1.0.0")


@app.middleware("http")
async def request_size_limit(request: FastAPIRequest, call_next):
    """Reject declared oversized JSON before FastAPI buffers and parses it."""
    length = request.headers.get("content-length")
    is_asset_upload = request.url.path == "/admin/assets/stage"
    if length:
        try:
            maximum = (
                MAX_ASSET_UPLOAD_BYTES + 1024 * 1024
                if is_asset_upload
                else MAX_INPUT_BYTES * 2
            )
            if int(length) > maximum:
                detail = (
                    "licensed asset upload exceeds the configured size limit"
                    if is_asset_upload
                    else "request exceeds size limit"
                )
                return JSONResponse({"detail": detail}, status_code=413)
        except ValueError:
            return JSONResponse({"detail": "invalid content-length"}, status_code=400)
    elif is_asset_upload:
        return JSONResponse(
            {"detail": "content-length is required for licensed asset uploads"},
            status_code=411,
        )
    return await call_next(request)


def _require_auth(request: FastAPIRequest) -> None:
    """Protect every provider capability endpoint, even if configuration drifts."""
    token = (os.getenv("MUSIC_AI_WORKER_TOKEN") or "").strip()
    authorization = request.headers.get("Authorization")
    if not token or not authorization or not secrets.compare_digest(
        authorization, f"Bearer {token}"
    ):
        raise HTTPException(401, "worker authentication is required")


def _require_admin_auth(request: FastAPIRequest) -> None:
    token = os.getenv("MUSIC_AI_WORKER_TOKEN")
    if not token or request.headers.get("Authorization") != f"Bearer {token}":
        raise HTTPException(401, "licensed asset administration requires worker authentication")


def _resolve_public_addresses(host: str, port: int) -> list[tuple[int, tuple]]:
    """Resolve once and retain only addresses safe to connect to.

    Rejecting the entire result if even one answer is non-global prevents a
    round-robin DNS record from bypassing the check.  The resulting sockaddr is
    passed to connect directly, so no later name resolution can be rebound.
    """
    try:
        answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(400, "source_url host could not be resolved") from exc
    vetted: list[tuple[int, tuple]] = []
    for family, _, _, _, sockaddr in answers:
        try:
            if not ipaddress.ip_address(sockaddr[0]).is_global:
                raise HTTPException(400, "source_url must resolve only to global addresses")
        except ValueError as exc:
            raise HTTPException(400, "source_url resolution returned an invalid address") from exc
        vetted.append((family, sockaddr))
    if not vetted:
        raise HTTPException(400, "source_url host could not be resolved")
    return vetted


class _VettedConnectionMixin:
    def __init__(self, host: str, port: int, vetted: tuple[int, tuple], timeout: float):
        self._vetted_family, self._vetted_sockaddr = vetted
        super().__init__(host, port=port, timeout=timeout)

    def _connect_vetted(self):
        sock = socket.socket(self._vetted_family, socket.SOCK_STREAM)
        try:
            sock.settimeout(self.timeout)
            sock.connect(self._vetted_sockaddr)
            self.sock = sock
        except Exception:
            sock.close()
            raise

    def connect(self):
        self._connect_vetted()


class VettedHTTPConnection(_VettedConnectionMixin, HTTPConnection):
    """HTTP connection whose peer is already DNS-vetted."""


class VettedHTTPSConnection(_VettedConnectionMixin, HTTPSConnection):
    """HTTPS connection retaining certificate validation and SNI for hostname."""

    def connect(self):
        self._connect_vetted()
        # HTTPSConnection.host remains the original URL hostname, never the IP.
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise HTTPException(408, "source download timed out")
    return remaining


def download_source(url: str, directory: Path) -> Path:
    parsed = urlparse(url)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or
            parsed.username is not None or parsed.password is not None):
        raise HTTPException(400, "source_url must be a public http(s) URL")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise HTTPException(400, "source_url has an invalid port") from exc
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT
    vetted = _resolve_public_addresses(parsed.hostname, port)
    connection_type = VettedHTTPSConnection if parsed.scheme == "https" else VettedHTTPConnection
    connection = connection_type(parsed.hostname, port, vetted[0], _remaining(deadline))
    try:
        target_path = parsed.path or "/"
        if parsed.query:
            target_path += f"?{parsed.query}"
        connection.request("GET", target_path, headers={"User-Agent": "music-ai-worker/1.0"})
        connection.sock.settimeout(_remaining(deadline))
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise HTTPException(400, "redirects are not permitted for source_url")
        if response.status < 200 or response.status >= 300:
            raise HTTPException(400, "source server returned an unsuccessful response")
        length = response.headers.get("Content-Length")
        if length and int(length) > MAX_DOWNLOAD_BYTES:
            raise HTTPException(413, "source exceeds download size limit")
        content_type = response.headers.get_content_type().lower()
        suffix = {
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/flac": ".flac",
            "audio/mpeg": ".mp3",
            "audio/mp4": ".m4a",
            "audio/ogg": ".ogg",
        }.get(content_type, Path(parsed.path).suffix.lower())
        if suffix not in {".wav", ".flac", ".mp3", ".m4a", ".ogg", ".aif", ".aiff"}:
            suffix = ".wav"
        target = directory / f"source{suffix}"
        total = 0
        with response, target.open("wb") as output:
            while True:
                connection.sock.settimeout(_remaining(deadline))
                block = response.read(64 * 1024)
                if not block:
                    break
                total += len(block)
                if total > MAX_DOWNLOAD_BYTES:
                    raise HTTPException(413, "source exceeds download size limit")
                output.write(block)
        return target
    except HTTPException:
        raise
    except (OSError, ValueError, TimeoutError) as exc:
        raise HTTPException(400, "unable to download source") from exc
    finally:
        connection.close()


def validate_audio(path: Path) -> None:
    try:
        info = sf.info(path)
    except RuntimeError as exc:
        raise HTTPException(415, "source is not decodable audio") from exc
    if not info.samplerate or info.duration <= 0 or info.duration > MAX_DURATION_SECONDS:
        raise HTTPException(413, "audio duration is outside permitted bounds")


def decode_audio(value: str, directory: Path) -> Path:
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise HTTPException(422, "audio_base64 is invalid") from exc
    if not raw or len(raw) > MAX_INPUT_BYTES:
        raise HTTPException(413, "audio_base64 exceeds size limit")
    target = directory / "input.wav"
    target.write_bytes(raw)
    validate_audio(target)
    return target


def wav_b64(audio: np.ndarray, sample_rate: int) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav") as handle:
        sf.write(handle.name, audio, sample_rate, subtype="PCM_16")
        return base64.b64encode(Path(handle.name).read_bytes()).decode("ascii")


class SourceRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    provider: Literal["BASIC_PITCH", "DEMUCS"]
    source_url: HttpUrl = Field(alias="sourceUrl")
    source_type: str | None = Field(default=None, alias="sourceType")
    duration_seconds: float | None = Field(default=None, alias="durationSeconds", gt=0)


class ProcessRequest(BaseModel):
    provider: Literal["PEDALBOARD_BUILTIN"]
    audio_base64: str = Field(min_length=4, max_length=MAX_INPUT_BYTES * 2)
    gain_db: float = Field(default=0, ge=-36, le=36)
    threshold_db: float = Field(default=-12, ge=-60, le=0)


class RenderRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    contract_version: Literal["1.0"] = Field(default="1.0", alias="contractVersion")
    provider: Literal["VST3", "SFIZZ_VSCO2_CE"]
    track_model: dict | None = Field(default=None, alias="trackModel")
    sample_rate: int = Field(default=44100, alias="sampleRate", ge=8000, le=192000)
    duration_seconds: float = Field(default=8, alias="durationSeconds", gt=0, le=MAX_RENDER_SECONDS)
    # Kept only for old effect-render clients. Instrument rendering requires a
    # canonical TrackModel and never treats arbitrary audio as musical evidence.
    audio_base64: str | None = Field(default=None, min_length=4, max_length=MAX_INPUT_BYTES * 2)


def _asset_state_path() -> Path:
    return ASSET_ROOT / ASSET_STATE_FILENAME


@contextmanager
def _asset_file_lock():
    ASSET_ROOT.mkdir(parents=True, exist_ok=True)
    with (ASSET_ROOT / ".licensed_asset.lock").open("a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _atomic_write_json(path: Path, value: dict, *, indent: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    with temporary.open("w") as handle:
        json.dump(value, handle, sort_keys=True, separators=None if indent else (",", ":"), indent=indent)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _read_asset_state() -> dict:
    try:
        value = json.loads(_asset_state_path().read_text())
    except (OSError, json.JSONDecodeError):
        value = {}
    if not isinstance(value, dict) or not isinstance(value.get("candidates", {}), dict):
        value = {}
    value["candidates"] = value.get("candidates", {})
    history = value.get("history")
    if not isinstance(history, dict):
        history = {}
    value["history"] = {
        kind: history.get(kind, [])
        if isinstance(history.get(kind, []), list)
        else []
        for kind in ("vst3", "sfz")
    }
    return value

def _read_asset_manifest() -> dict:
    try:
        value = json.loads(ASSET_MANIFEST_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}
def _write_asset_state(state: dict) -> None:
    _atomic_write_json(_asset_state_path(), state)


def _asset_candidate_response(candidate: dict) -> dict:
    return {
        key: value
        for key, value in candidate.items()
        if key not in {"path", "libraryPath", "rendererPath", "candidateRoot"}
    }


def _safe_upload_name(value: str, label: str) -> Path:
    if not value or "\x00" in value:
        raise HTTPException(400, f"{label} has an invalid filename")
    path = Path(value.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise HTTPException(400, f"{label} has an invalid filename")
    parts = tuple(part for part in path.parts if part not in {"", "."})
    if not parts:
        raise HTTPException(400, f"{label} has an invalid filename")
    return Path(*parts)


async def _write_upload(upload: UploadFile, destination: Path, remaining: list[int]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with destination.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                remaining[0] -= len(chunk)
                if remaining[0] < 0:
                    raise HTTPException(413, "licensed asset upload exceeds the configured size limit")
                handle.write(chunk)
    finally:
        await upload.close()


def _require_approved_native_host(
    kind: Literal["vst3", "sfz"],
    identity: str,
    checksum: str,
) -> None:
    raw = os.getenv("MUSIC_AI_APPROVED_NATIVE_HOSTS", "[]")
    try:
        approved = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(503, "approved native host registry is invalid") from exc
    if not isinstance(approved, list):
        raise HTTPException(503, "approved native host registry is invalid")
    matched = any(
        isinstance(item, dict)
        and item.get("kind") == kind
        and item.get("identity") == identity
        and isinstance(item.get("sha256"), str)
        and secrets.compare_digest(item["sha256"].lower(), checksum.lower())
        for item in approved
    )
    if not matched:
        raise HTTPException(
            403,
            "native host identity and checksum are not in the approved host registry",
        )


def _require_approved_vst3_asset(
    asset_id: str,
    identity: str,
    checksum: str,
) -> None:
    raw = os.getenv("MUSIC_AI_APPROVED_VST3_ASSETS", "[]")
    try:
        approved = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(503, "approved VST3 asset registry is invalid") from exc
    if not isinstance(approved, list):
        raise HTTPException(503, "approved VST3 asset registry is invalid")
    matched = any(
        isinstance(item, dict)
        and item.get("assetId") == asset_id
        and item.get("identity") == identity
        and isinstance(item.get("sha256"), str)
        and secrets.compare_digest(item["sha256"].lower(), checksum.lower())
        for item in approved
    )
    if not matched:
        raise HTTPException(
            403,
            "VST3 identity and checksum are not in the approved asset registry",
        )


def _sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _sha256_tree(path: Path) -> str | None:
    """Hash a file or directory without exposing a private storage path."""
    if path.is_file():
        return _sha256(path)
    if not path.is_dir():
        return None
    digest = hashlib.sha256()
    files = sorted(candidate for candidate in path.rglob("*") if candidate.is_file())
    if not files:
        return None
    for candidate in files:
        digest.update(str(candidate.relative_to(path)).encode("utf-8"))
        digest.update(b"\0")
        with candidate.open("rb") as handle:
            while block := handle.read(1024 * 1024):
                digest.update(block)
    return digest.hexdigest()


def _safe_asset_path(value: object, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} path is missing")
    path = Path(value).expanduser().resolve()
    try:
        path.relative_to(ASSET_ROOT)
    except ValueError as exc:
        raise ValueError(f"{label} must be inside MUSIC_AI_ASSET_ROOT") from exc
    return path


def _asset_from_entry(kind: Literal["vst3", "sfz"], entry: object) -> dict:
    if not isinstance(entry, dict):
        raise ValueError(f"licensed {kind} asset is not selected")
    for required in ("id", "identity", "licenseOwner", "licenseReference", "sha256"):
        if not isinstance(entry.get(required), str) or not entry[required].strip():
            raise ValueError(f"licensed {kind} asset is missing {required}")
    path_key = "path" if kind == "vst3" else "libraryPath"
    path = _safe_asset_path(entry.get(path_key), kind)
    if (kind == "vst3" and not (path.is_file() or path.is_dir())) or (kind == "sfz" and not path.is_dir()):
        raise ValueError(f"licensed {kind} asset is not present at the selected path")
    checksum = _sha256_tree(path)
    if not checksum or checksum != entry["sha256"].lower():
        raise ValueError(f"licensed {kind} asset checksum does not match its manifest")
    asset = {
        "id": entry["id"].strip(),
        "identity": entry["identity"].strip(),
        "licenseOwner": entry["licenseOwner"].strip(),
        "licenseReference": entry["licenseReference"].strip(),
        "sha256": checksum,
        "path": path,
    }
    renderer_label = "VST3 MIDI host" if kind == "vst3" else "sfizz renderer"
    renderer = _safe_asset_path(entry.get("rendererPath"), renderer_label)
    if not renderer.is_file() or not os.access(renderer, os.X_OK):
        raise ValueError(f"native {renderer_label} is missing or not executable")
    for required in ("rendererIdentity", "rendererSha256"):
        if not isinstance(entry.get(required), str) or not entry[required].strip():
            raise ValueError(f"licensed {kind} asset is missing {required}")
    renderer_checksum = _sha256_tree(renderer)
    if renderer_checksum != entry["rendererSha256"].lower():
        raise ValueError(f"native {renderer_label} checksum does not match its manifest")
    asset["rendererPath"] = renderer
    asset["rendererIdentity"] = entry["rendererIdentity"].strip()
    asset["rendererSha256"] = renderer_checksum
    if isinstance(entry.get("smokeEvidence"), dict):
        asset["smokeEvidence"] = entry["smokeEvidence"]
    if kind == "sfz":
        asset["libraryPath"] = path
    return asset


def _licensed_asset(kind: Literal["vst3", "sfz"]) -> dict:
    """Return an attested active asset, never a path supplied by a render request."""
    try:
        ASSET_MANIFEST_PATH.relative_to(ASSET_ROOT)
    except ValueError as exc:
        raise ValueError("licensed asset manifest must be inside MUSIC_AI_ASSET_ROOT") from exc
    try:
        manifest = json.loads(ASSET_MANIFEST_PATH.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("licensed asset manifest is missing or invalid") from exc
    if not isinstance(manifest, dict):
        raise ValueError("licensed asset manifest must be a JSON object")
    return _asset_from_entry(kind, manifest.get(kind))


async def _stage_asset_candidate(
    kind: Literal["vst3", "sfz"],
    asset_id: str,
    identity: str,
    license_owner: str,
    license_reference: str,
    renderer_identity: str,
    asset_files: list[UploadFile],
    renderer_file: UploadFile,
    asset_relative_paths: list[str] | None = None,
) -> dict:
    fields = {
        "assetId": asset_id,
        "identity": identity,
        "licenseOwner": license_owner,
        "licenseReference": license_reference,
        "rendererIdentity": renderer_identity,
    }
    for label, value in fields.items():
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 500:
            raise HTTPException(400, f"{label} is required")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{1,127}", asset_id.strip()):
        raise HTTPException(400, "assetId must contain only letters, numbers, dots, dashes, or underscores")
    if not asset_files:
        raise HTTPException(400, "at least one licensed asset file is required")
    if not renderer_file or not renderer_file.filename:
        raise HTTPException(400, "an approved native host is required")

    candidate_id = secrets.token_urlsafe(18)
    candidate_root = ASSET_ROOT / ".staged" / candidate_id
    asset_root = candidate_root / "asset"
    renderer_path = candidate_root / "renderer" / "native-host"
    remaining = [MAX_ASSET_UPLOAD_BYTES]
    try:
        normalized_names: list[Path] = []
        if asset_relative_paths and len(asset_relative_paths) != len(asset_files):
            raise HTTPException(400, "assetRelativePaths must match assetFiles")
        for index, upload in enumerate(asset_files):
            upload_name = (
                asset_relative_paths[index]
                if asset_relative_paths
                else upload.filename or ""
            )
            relative_name = _safe_upload_name(upload_name, "asset file")
            normalized_names.append(relative_name)
            await _write_upload(upload, asset_root / relative_name, remaining)
        await _write_upload(renderer_file, renderer_path, remaining)
        top_levels = {name.parts[0] for name in normalized_names}
        if kind == "vst3" and len(asset_files) == 1:
            asset_path = asset_root / normalized_names[0]
        elif kind == "vst3" and len(top_levels) == 1 and next(iter(top_levels)).lower().endswith(".vst3"):
            asset_path = asset_root / next(iter(top_levels))
        else:
            asset_path = asset_root
        entry = {
            "id": asset_id.strip(),
            "identity": identity.strip(),
            "licenseOwner": license_owner.strip(),
            "licenseReference": license_reference.strip(),
            "rendererIdentity": renderer_identity.strip(),
            "rendererPath": str(renderer_path),
            "path" if kind == "vst3" else "libraryPath": str(asset_path),
        }
        renderer_checksum = _sha256_tree(renderer_path)
        if not renderer_checksum:
            raise HTTPException(400, "approved native host upload is empty")
        _require_approved_native_host(
            kind,
            renderer_identity.strip(),
            renderer_checksum,
        )
        asset_checksum = _sha256_tree(asset_path)
        if not asset_checksum:
            raise HTTPException(400, "licensed asset upload is empty")
        if kind == "vst3":
            _require_approved_vst3_asset(
                asset_id.strip(),
                identity.strip(),
                asset_checksum,
            )
        renderer_path.chmod(0o755)
        verified_asset = _asset_from_entry(kind, {
            **entry,
            "sha256": asset_checksum,
            "rendererSha256": renderer_checksum,
        })
        evidence = run_renderer_smoke(
            "VST3" if kind == "vst3" else "SFIZZ_VSCO2_CE",
            asset=verified_asset,
        )
        if not evidence.get("audible") or not evidence.get("canonicalSensitivity"):
            raise HTTPException(503, "licensed asset failed canonical TrackModel smoke evidence")
        candidate = {
            "candidateId": candidate_id,
            "kind": kind,
            "assetId": verified_asset["id"],
            "identity": verified_asset["identity"],
            "licenseOwner": verified_asset["licenseOwner"],
            "licenseReference": verified_asset["licenseReference"],
            "rendererIdentity": verified_asset["rendererIdentity"],
            "sha256": verified_asset["sha256"],
            "rendererSha256": verified_asset["rendererSha256"],
            "path": str(asset_path),
            "libraryPath": str(asset_path),
            "rendererPath": str(renderer_path),
            "status": "verified",
            "smokeEvidence": evidence,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        with ASSET_STATE_LOCK, _asset_file_lock():
            state = _read_asset_state()
            state["candidates"][candidate_id] = candidate
            _write_asset_state(state)
        return _asset_candidate_response(candidate)
    except Exception:
        shutil.rmtree(candidate_root, ignore_errors=True)
        raise


def _candidate_entry(candidate: dict) -> dict:
    entry = {
        "id": candidate["assetId"],
        "identity": candidate["identity"],
        "licenseOwner": candidate["licenseOwner"],
        "licenseReference": candidate["licenseReference"],
        "rendererIdentity": candidate["rendererIdentity"],
        "rendererSha256": candidate["rendererSha256"],
        "sha256": candidate["sha256"],
        "rendererPath": candidate["rendererPath"],
        "smokeEvidence": candidate["smokeEvidence"],
    }
    for optional in ("candidateId", "createdAt", "activatedAt"):
        if candidate.get(optional):
            entry[optional] = candidate[optional]
    entry["path" if candidate["kind"] == "vst3" else "libraryPath"] = candidate["path"]
    return entry

def _validate_verified_asset(
    kind: Literal["vst3", "sfz"],
    entry: dict,
    *,
    label: str,
) -> dict:
    try:
        asset = _asset_from_entry(kind, entry)
    except ValueError as exc:
        raise HTTPException(409, f"{label} changed after verification: {exc}") from exc
    evidence = entry.get("smokeEvidence")
    if (
        not isinstance(evidence, dict)
        or evidence.get("assetId") != asset["id"]
        or evidence.get("sha256") != asset["sha256"]
        or evidence.get("rendererSha256") != asset["rendererSha256"]
        or evidence.get("nativeHostAttested") is not True
        or evidence.get("canonicalSensitivity") is not True
        or evidence.get("audible") is not True
    ):
        raise HTTPException(
            409,
            f"{label} no longer matches its canonical TrackModel smoke evidence",
        )
    return asset
def _activate_asset_candidate(candidate_id: str) -> dict:
    with ASSET_STATE_LOCK, _asset_file_lock():
        try:
            ASSET_MANIFEST_PATH.relative_to(ASSET_ROOT)
        except ValueError as exc:
            raise HTTPException(500, "licensed asset manifest must be inside MUSIC_AI_ASSET_ROOT") from exc
        state = _read_asset_state()
        candidate = state["candidates"].get(candidate_id)
        if not isinstance(candidate, dict) or candidate.get("status") != "verified":
            raise HTTPException(409, "candidate is not verified and cannot be activated")
        kind = candidate.get("kind")
        if kind not in {"vst3", "sfz"}:
            raise HTTPException(409, "candidate has an invalid asset kind")
        current = _read_asset_manifest().get(kind)
        if isinstance(current, dict) and current.get("candidateId") == candidate_id:
            raise HTTPException(409, "candidate is already active")
        return _activate_verified_entry(
            kind,
            _candidate_entry(candidate),
            state,
            response_id=candidate_id,
            label="candidate",
        )

def _reactivate_asset_history(history_id: str) -> dict:
    with ASSET_STATE_LOCK, _asset_file_lock():
        try:
            ASSET_MANIFEST_PATH.relative_to(ASSET_ROOT)
        except ValueError as exc:
            raise HTTPException(500, "licensed asset manifest must be inside MUSIC_AI_ASSET_ROOT") from exc
        state = _read_asset_state()
        current, manifest_existed = _read_asset_manifest_for_update()
        if not manifest_existed:
            raise HTTPException(404, "historical instrument pack not found")
        state["history"] = _rotation_history(current, state)
        found: tuple[Literal["vst3", "sfz"], dict] | None = None
        for kind in ("vst3", "sfz"):
            record = next(
                (
                    item
                    for item in state["history"][kind]
                    if isinstance(item, dict) and item.get("historyId") == history_id
                ),
                None,
            )
            if record:
                found = (kind, record)
                break
        if not found:
            raise HTTPException(404, "historical instrument pack not found")
        kind, record = found
        if record.get("status") != "verified":
            raise HTTPException(409, "historical instrument pack is unavailable")
        return _activate_verified_entry(
            kind,
            record,
            state,
            response_id=record.get("candidateId", history_id),
            label="historical pack",
            remove_history_id=history_id,
        )
@app.get("/admin/assets", dependencies=[Depends(_require_admin_auth)])
def list_asset_candidates() -> dict:
    state = _read_asset_state()
    manifest = _read_asset_manifest()
    state["history"] = _rotation_history(manifest, state)
    active_candidate_ids = {
        entry.get("candidateId")
        for kind in ("vst3", "sfz")
        if isinstance((entry := manifest.get(kind)), dict)
        and isinstance(entry.get("candidateId"), str)
    }
    active: dict[str, dict] = {}
    for kind in ("vst3", "sfz"):
        try:
            asset = _asset_candidate_response(_licensed_asset(kind))
            active[kind] = {
                **asset,
                "assetId": asset["id"],
                "kind": kind,
                "status": "active",
            }
        except ValueError:
            active[kind] = {"status": "unavailable"}
    candidates = [
        _asset_candidate_response(candidate)
        for candidate in state["candidates"].values()
        if isinstance(candidate, dict)
        and candidate.get("status") == "verified"
        and candidate.get("candidateId") not in active_candidate_ids
    ]
    history: dict[str, list[dict]] = {}
    for kind in ("vst3", "sfz"):
        history[kind] = []
        for record in state["history"][kind]:
            if not isinstance(record, dict):
                continue
            visible = _asset_candidate_response(record)
            try:
                _validate_verified_asset(kind, record, label="historical pack")
                visible["status"] = "verified"
            except HTTPException:
                # Do not expose private paths or an exception that could leak
                # storage details. A missing/tampered pack is reviewable but
                # never eligible for reactivation.
                visible["status"] = "unavailable"
                visible["unavailableReason"] = "Historical bytes are missing or changed"
            history[kind].append(visible)
        history[kind].sort(
            key=lambda item: item.get("deactivatedAt") or item.get("activatedAt") or "",
            reverse=True,
        )
    return {
        "active": active,
        "candidates": sorted(
            candidates, key=lambda item: item.get("createdAt", ""), reverse=True
        ),
        "history": history,
    }


@app.post("/admin/assets/stage", dependencies=[Depends(_require_admin_auth)])
async def stage_asset(
    kind: Literal["vst3", "sfz"] = Form(...),
    asset_id: str = Form(..., alias="assetId"),
    identity: str = Form(...),
    license_owner: str = Form(..., alias="licenseOwner"),
    license_reference: str = Form(..., alias="licenseReference"),
    renderer_identity: str = Form(..., alias="rendererIdentity"),
    asset_files: list[UploadFile] = File(..., alias="assetFiles"),
    renderer_file: UploadFile = File(..., alias="rendererFile"),
    asset_relative_paths: list[str] | None = Form(None, alias="assetRelativePaths"),
) -> dict:
    return await _stage_asset_candidate(
        kind,
        asset_id,
        identity,
        license_owner,
        license_reference,
        renderer_identity,
        asset_files,
        renderer_file,
        asset_relative_paths,
    )


@app.post("/admin/assets/{candidate_id}/activate", dependencies=[Depends(_require_admin_auth)])
def activate_asset(candidate_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,}", candidate_id):
        raise HTTPException(404, "candidate not found")
    return _activate_asset_candidate(candidate_id)

@app.post(
    "/admin/assets/history/{history_id}/activate",
    dependencies=[Depends(_require_admin_auth)],
)
def reactivate_asset(history_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,}", history_id):
        raise HTTPException(404, "historical instrument pack not found")
    return _reactivate_asset_history(history_id)
def _canonical_track_model(value: object) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(422, "trackModel must be a canonical TrackModel object")
    required = ("id", "instrument", "role", "notes", "cc", "articulations", "automation")
    if any(not value.get(key) and key in ("id", "instrument", "role") for key in required):
        raise HTTPException(422, "trackModel is missing identity fields")
    if any(not isinstance(value.get(key), list) for key in required[3:]):
        raise HTTPException(422, "trackModel event collections are invalid")
    notes = value["notes"]
    for note in notes:
        if not isinstance(note, dict):
            raise HTTPException(422, "trackModel contains an invalid note")
        if not all(isinstance(note.get(key), (int, float)) for key in ("start", "duration", "pitch", "velocity")):
            raise HTTPException(422, "trackModel note is missing numeric timing or pitch")
        if note["start"] < 0 or note["duration"] <= 0 or not 0 <= note["pitch"] <= 127:
            raise HTTPException(422, "trackModel contains an unplayable note")
    return value


def _validate_render_audio(audio: np.ndarray, sample_rate: int, duration_seconds: float) -> None:
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]
    if audio.ndim != 2 or audio.shape[0] not in (1, 2):
        raise HTTPException(503, "native renderer returned an invalid channel layout")
    expected = int(round(sample_rate * duration_seconds))
    if abs(audio.shape[1] - expected) > max(1, sample_rate // 100):
        raise HTTPException(503, "native renderer returned an invalid duration")
    if not np.isfinite(audio).all():
        raise HTTPException(503, "native renderer returned non-finite audio")
    if float(np.max(np.abs(audio))) < 0.0005:
        raise HTTPException(503, "native renderer returned silent audio")


def _render_native_track(
    kind: Literal["vst3", "sfz"],
    track: dict,
    sample_rate: int,
    duration_seconds: float,
    asset: dict | None = None,
) -> tuple[np.ndarray, dict]:
    if asset is None:
        try:
            asset = _licensed_asset(kind)
        except ValueError as exc:
            raise HTTPException(503, str(exc)) from exc
    if kind == "vst3":
        try:
            from pedalboard import load_plugin
            plugin_name = os.getenv("MUSIC_AI_VST3_PLUGIN_NAME") or None
            load_plugin(str(asset["path"]), plugin_name=plugin_name)
        except Exception as exc:
            raise HTTPException(503, f"configured VST3 plugin could not be loaded: {exc}") from exc
    with tempfile.TemporaryDirectory(prefix=f"music-ai-{kind}-") as tmp:
        request_path = Path(tmp) / "track-model.json"
        output_path = Path(tmp) / "render.wav"
        attestation_path = Path(tmp) / "render-attestation.json"
        request_path.write_text(json.dumps({
            "trackModel": track,
            "sampleRate": sample_rate,
            "durationSeconds": duration_seconds,
            "assetPath": str(asset["path"]),
            "outputPath": str(output_path),
        }, sort_keys=True, separators=(",", ":")))
        track_model_sha256 = _sha256_tree(request_path)
        command = [
            str(asset["rendererPath"]),
            "--track-model", str(request_path),
            "--sample-rate", str(sample_rate),
            "--duration-seconds", str(duration_seconds),
            "--output", str(output_path),
            "--attestation", str(attestation_path),
            "--asset-identity", asset["identity"],
        ]
        command.extend(
            ["--plugin", str(asset["path"])]
            if kind == "vst3"
            else ["--library", str(asset["path"])]
        )
        try:
            subprocess.run(
                command,
                check=True,
                capture_output=True,
                timeout=INFERENCE_TIMEOUT,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(
                504,
                f"configured {kind} renderer timed out after {INFERENCE_TIMEOUT:g} seconds",
            ) from exc
        except (OSError, subprocess.CalledProcessError) as exc:
            raise HTTPException(503, f"configured {kind} renderer could not render TrackModel") from exc
        if not output_path.is_file():
            raise HTTPException(503, f"native {kind} renderer did not produce a WAV")
        try:
            host_attestation = json.loads(attestation_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise HTTPException(
                503, f"native {kind} renderer did not attest the selected asset"
            ) from exc
        expected_event_counts = {
            "notes": len(track["notes"]),
            "cc": len(track["cc"]),
            "articulations": len(track["articulations"]),
            "automation": len(track["automation"]),
        }
        expected_host_attestation = {
            "provider": kind,
            "assetIdentity": asset["identity"],
            "assetSha256": asset["sha256"],
            "rendererSha256": asset["rendererSha256"],
            "trackModelSha256": track_model_sha256,
            "eventCounts": expected_event_counts,
            "outputSha256": _sha256_tree(output_path),
        }
        if host_attestation != expected_host_attestation:
            raise HTTPException(
                503, f"native {kind} renderer returned invalid asset/render attestation"
            )
        max_wav_bytes = int(sample_rate * duration_seconds * 2 * 4) + 1024 * 1024
        if output_path.stat().st_size > max_wav_bytes:
            raise HTTPException(503, f"native {kind} renderer produced an oversized WAV")
        try:
            audio, output_rate = sf.read(output_path, always_2d=True, dtype="float32")
        except RuntimeError as exc:
            raise HTTPException(503, f"native {kind} renderer returned an undecodable WAV") from exc
    if output_rate != sample_rate:
        raise HTTPException(503, f"native {kind} renderer returned the wrong sample rate")
    audio = np.asarray(audio, dtype=np.float32).T
    _validate_render_audio(audio, sample_rate, duration_seconds)
    return audio, {
        key: value
        for key, value in asset.items()
        if key not in ("path", "libraryPath", "rendererPath")
    }


def _render_vst3_track(
    track: dict,
    sample_rate: int,
    duration_seconds: float,
    asset: dict | None = None,
) -> tuple[np.ndarray, dict]:
    return _render_native_track("vst3", track, sample_rate, duration_seconds, asset)


def _render_sfizz_track(
    track: dict,
    sample_rate: int,
    duration_seconds: float,
    asset: dict | None = None,
) -> tuple[np.ndarray, dict]:
    return _render_native_track("sfz", track, sample_rate, duration_seconds, asset)


def renderer_health(provider: str) -> dict:
    """Attest the selected licensed asset and native smoke evidence."""
    kind = "vst3" if provider == "VST3" else "sfz"
    try:
        asset = _licensed_asset(kind)
        if provider == "VST3":
            # Loading is deliberately part of health; package presence alone is
            # not proof that this plugin can be instantiated.
            from pedalboard import load_plugin
            plugin_name = os.getenv("MUSIC_AI_VST3_PLUGIN_NAME") or None
            load_plugin(str(asset["path"]), plugin_name=plugin_name)
            package_version = installed_version("pedalboard")
        else:
            package_version = "native-command"
        marker = asset.get("smokeEvidence") or _readiness_marker().get(
            "vst3" if provider == "VST3" else "sfizz"
        )
        smoke_tested = (
            isinstance(marker, dict)
            and marker.get("assetId") == asset["id"]
            and marker.get("sha256") == asset["sha256"]
            and marker.get("rendererSha256") == asset["rendererSha256"]
            and marker.get("audible") is True
            and marker.get("trackModelRendered") is True
            and marker.get("canonicalSensitivity") is True
            and marker.get("nativeHostAttested") is True
        )
        return {
            "contractVersion": "1.0",
            "status": "ok" if smoke_tested else "unhealthy",
            "healthy": smoke_tested,
            "provider": provider,
            "runtimeReady": smoke_tested,
            "checkpointReady": True,
            "packageReady": True,
            "modelVersion": package_version,
            "runtimeIdentity": f"music-ai-worker/python-3.11/{package_version}",
            "checksum": asset["sha256"],
            "smokeTested": smoke_tested,
            "asset": {
                "id": asset["id"],
                "identity": asset["identity"],
                "licenseOwner": asset["licenseOwner"],
                "licenseReference": asset["licenseReference"],
                "sha256": asset["sha256"],
                "rendererIdentity": asset["rendererIdentity"],
                "rendererSha256": asset["rendererSha256"],
            },
            "smokeEvidence": marker if isinstance(marker, dict) else None,
            "runtime": {"ready": smoke_tested, "python": "3.11", "device": "cpu"},
        }
    except Exception as exc:
        return {
            "status": "unavailable",
            "healthy": False,
            "provider": provider,
            "optionalAdapter": True,
            "runtimeReady": False,
            "checkpointReady": False,
            "packageReady": False,
            "modelVersion": None,
            "checksum": None,
            "smokeTested": False,
            "reason": str(exc),
            "requirements": NATIVE_ADAPTER_REQUIREMENTS[provider],
            "error": str(exc),
            "asset": None,
            "smokeEvidence": None,
            "runtime": {"ready": False, "python": "3.11", "device": "cpu"},
        }


def canonical_render_smoke_track() -> dict:
    """Small but genuine TrackModel used for native renderer attestation."""
    return {
        "id": "renderer-smoke",
        "instrument": "strings",
        "role": "harmony",
        "instrumentDefinition": {"id": "strings"},
        "notes": [{
            "id": "renderer-smoke-note",
            "start": 0.05,
            "duration": 0.7,
            "pitch": 60,
            "velocity": 96,
            "voice": "harmony",
        }],
        "cc": [{"controller": 11, "time": 0, "value": 100}],
        "articulations": [{"time": 0.05, "name": "sustain", "intensity": 0.75}],
        "automation": [],
    }


def run_renderer_smoke(
    provider: Literal["VST3", "SFIZZ_VSCO2_CE"],
    asset: dict | None = None,
) -> dict:
    track = _canonical_track_model(canonical_render_smoke_track())
    sample_rate = 22050
    duration_seconds = 1.0
    render = _render_vst3_track if provider == "VST3" else _render_sfizz_track
    audio, rendered_asset = render(track, sample_rate, duration_seconds, asset)
    pitch_variant = copy.deepcopy(track)
    pitch_variant["notes"][0]["pitch"] += 7
    pitch_audio, pitch_asset = render(pitch_variant, sample_rate, duration_seconds, asset)
    expression_variant = copy.deepcopy(track)
    expression_variant["cc"][0]["value"] = 24
    expression_variant["articulations"][0]["name"] = "staccato"
    expression_audio, expression_asset = render(
        expression_variant, sample_rate, duration_seconds, asset
    )
    if rendered_asset["id"] != pitch_asset["id"] or rendered_asset["id"] != expression_asset["id"]:
        raise HTTPException(503, "native renderer changed assets during smoke test")
    audio_hash = hashlib.sha256(audio.tobytes()).hexdigest()
    pitch_hash = hashlib.sha256(pitch_audio.tobytes()).hexdigest()
    expression_hash = hashlib.sha256(expression_audio.tobytes()).hexdigest()
    canonical_sensitivity = len({audio_hash, pitch_hash, expression_hash}) == 3
    if not canonical_sensitivity:
        raise HTTPException(
            503,
            "native renderer did not respond to TrackModel pitch and expression changes",
        )
    peak = float(np.max(np.abs(audio)))
    return {
        "assetId": rendered_asset["id"],
        "sha256": rendered_asset["sha256"],
        "rendererIdentity": rendered_asset["rendererIdentity"],
        "rendererSha256": rendered_asset["rendererSha256"],
        "trackModelRendered": True,
        "audible": peak >= 0.0005,
        "canonicalSensitivity": canonical_sensitivity,
        "nativeHostAttested": True,
        "outputSha256": audio_hash,
        "pitchVariantSha256": pitch_hash,
        "expressionVariantSha256": expression_hash,
        "peak": round(peak, 6),
        "sampleRate": sample_rate,
        "durationSeconds": duration_seconds,
        "format": "wav/pcm_s16le",
    }


def _readiness_marker() -> dict:
    marker = ROOT / ".readiness" / f"{MANIFEST['readiness_key']}.json"
    try:
        return json.loads(marker.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _package_is_pinned(details: dict) -> bool:
    """Check the installed distribution, rather than trusting manifest text."""
    try:
        version_ready = installed_version(details["package"]) == details["version"]
    except PackageNotFoundError:
        return False
    expected_tree = details.get("package_tree_sha256")
    module = details.get("module", details["package"].replace("-", "_"))
    return version_ready and (
        not expected_tree or _installed_package_tree_sha256(module) == expected_tree
    )


def _installed_package_tree_sha256(package: str) -> str | None:
    """Hash every installed package file except generated interpreter caches."""
    try:
        root = Path(__import__(package).__file__).resolve().parent
    except (AttributeError, ImportError, TypeError):
        return None
    sources = sorted(
        path for path in root.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix not in {".pyc", ".pyo"}
    )
    if not sources:
        return None
    digest = hashlib.sha256()
    for path in sources:
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            while block := handle.read(1024 * 1024):
                digest.update(block)
    return digest.hexdigest()


def _installed_runtime_packages(details: dict) -> dict[str, str | None]:
    installed = {}
    for package in details.get("runtime_packages", {}):
        try:
            installed[package] = installed_version(package)
        except PackageNotFoundError:
            installed[package] = None
    return installed


def _runtime_packages_are_pinned(details: dict) -> bool:
    return _installed_runtime_packages(details) == details.get("runtime_packages", {})


def _clean_expired_artifacts() -> None:
    """Best-effort cleanup; artifacts are never required to outlive their TTL."""
    if not ARTIFACTS.is_dir():
        return
    cutoff = time.time() - ARTIFACT_TTL_SECONDS
    for candidate in ARTIFACTS.iterdir():
        try:
            if candidate.is_dir() and candidate.stat().st_mtime < cutoff:
                for child in candidate.iterdir():
                    child.unlink()
                candidate.rmdir()
        except OSError:
            # A concurrent one-time download may be deleting this directory.
            continue


def _delete_served_artifact(path: Path, directory: Path) -> None:
    """Consume one stem without invalidating its sibling capability URL."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        return
    try:
        if not any(directory.iterdir()):
            directory.rmdir()
    except OSError:
        # Concurrent downloads may both try to remove the now-empty directory.
        pass


def _store_stems(vocal: Path, accompaniment: Path) -> tuple[str, list[dict]]:
    sizes = [vocal.stat().st_size, accompaniment.stat().st_size]
    if any(size > MAX_STEM_BYTES for size in sizes) or sum(sizes) > MAX_SEPARATION_OUTPUT_BYTES:
        raise HTTPException(413, "Demucs output exceeds artifact size limit")
    _clean_expired_artifacts()
    ARTIFACTS.mkdir(mode=0o700, parents=True, exist_ok=True)
    artifact_id = secrets.token_urlsafe(32)
    directory = ARTIFACTS / artifact_id
    directory.mkdir(mode=0o700)
    result = []
    for source, name, role in (
        (vocal, "vocals.flac", "lead_vocal"),
        (accompaniment, "instrumental.flac", "instrumental"),
    ):
        target = directory / name
        # Same filesystem, and the directory mode prevents unrelated local users
        # from reading a capability URL's backing file.
        shutil.copyfile(source, target)
        target.chmod(0o600)
        result.append({
            "role": role,
            "confidence": 0.0,
            "contentType": "audio/flac",
            "extension": "flac",
            "name": name,
        })
    return artifact_id, result


@app.get("/health", dependencies=[Depends(_require_auth)])
def health(provider: str | None = None) -> dict:
    providers = {
        "BASIC_PITCH",
        "DEMUCS",
        "PEDALBOARD_BUILTIN",
        "VST3",
        "SFIZZ_VSCO2_CE",
    }
    if provider and provider not in providers:
        raise HTTPException(404, "unknown provider")
    selected = provider or "BASIC_PITCH"
    if selected in {"VST3", "SFIZZ_VSCO2_CE"}:
        return renderer_health(selected)
    manifest_key = {"BASIC_PITCH": "basic_pitch", "DEMUCS": "demucs",
                    "PEDALBOARD_BUILTIN": "pedalboard"}[selected]
    details = MANIFEST[manifest_key]
    marker = _readiness_marker()
    package_module = details.get("module", details["package"].replace("-", "_"))
    package_tree_sha256 = (
        _installed_package_tree_sha256(package_module)
        if details.get("package_tree_sha256")
        else None
    )
    runtime_packages = _installed_runtime_packages(details)
    package_ready = _package_is_pinned(details) and _runtime_packages_are_pinned(details)
    if selected == "BASIC_PITCH":
        checkpoint = Path(__import__(package_module).__file__).resolve().parent / details["checkpoint"]
        checksum = _sha256_tree(checkpoint)
        checkpoint_ready = checksum == details["checkpoint_tree_sha256"]
        smoke_tested = (
            marker.get("basic_pitch") is True
            and marker.get("basic_pitch_backend") == details["inference_backend"]
            and marker.get("basic_pitch_checkpoint_sha256") == checksum
        )
    elif selected == "DEMUCS":
        import torch
        checkpoint = Path(torch.hub.get_dir()) / "checkpoints" / details["checkpoint_file"]
        checksum = _sha256(checkpoint)
        checkpoint_ready = checksum == details["checkpoint_sha256"]
        smoke_tested = marker.get("demucs") is True
    elif selected == "PEDALBOARD_BUILTIN":
        checksum = f"builtin:{details['package']}:{details['version']}"
        checkpoint_ready = True
        smoke_tested = marker.get("pedalboard") is True
    ready = package_ready and checkpoint_ready and smoke_tested
    return {
        "status": "ok" if ready else "unhealthy",
        "healthy": ready,
        "provider": selected,
        "runtimeReady": ready,
        "checkpointReady": checkpoint_ready,
        "packageReady": package_ready,
        "modelVersion": details["version"],
        "checksum": checksum,
        "smokeTested": smoke_tested,
        **({
            "sourceRepository": details["source_repository"],
            "sourceRevision": details["source_revision"],
            "license": details["source_license"],
            "licenseSha256": details["license_sha256"],
            "packageArtifactSha256": details["package_artifact_sha256"],
            "packageTreeSha256": package_tree_sha256,
            **({
                "noticeSha256": details["notice_sha256"],
                "inferenceBackend": details["inference_backend"],
                "runtimePackages": runtime_packages,
            } if selected == "BASIC_PITCH" else {}),
        } if selected in {"BASIC_PITCH", "DEMUCS"} else {}),
        "runtime": {
            "ready": ready,
            "python": f"{sys.version_info.major}.{sys.version_info.minor}",
            "device": "cpu",
            **({"engine": details["inference_backend"]} if selected == "BASIC_PITCH" else {}),
        },
        "checkpoint": {
            "ready": checkpoint_ready,
            "name": details.get("checkpoint", "builtin"),
            "checksum": checksum,
        },
    }


@app.post("/analyze", dependencies=[Depends(_require_auth)])
def analyze(payload: SourceRequest) -> dict:
    if payload.provider != "BASIC_PITCH":
        raise HTTPException(422, "analyze supports BASIC_PITCH only")
    if not health("BASIC_PITCH")["healthy"]:
        raise HTTPException(503, "Basic Pitch runtime identity is not ready")
    from basic_pitch.inference import predict
    details = MANIFEST["basic_pitch"]
    checkpoint = (
        Path(__import__(details["module"]).__file__).resolve().parent
        / details["checkpoint"]
    )
    with tempfile.TemporaryDirectory(prefix="music-ai-") as tmp:
        source = download_source(str(payload.source_url), Path(tmp))
        validate_audio(source)
        _, _, events = predict(source, checkpoint)
    notes = []
    for start, end, pitch, amplitude, _ in events:
        item_confidence = float(max(0, min(1, amplitude)))
        notes.append({
            "start": float(start),
            "end": float(end),
            "pitch": int(pitch),
            "velocity": max(1, int(round(item_confidence * 127))),
            "confidence": item_confidence,
        })
    notes.sort(key=lambda note: (note["start"], note["end"], note["pitch"]))
    overall = float(np.mean([note["confidence"] for note in notes])) if notes else 0.0
    return {
        "contractVersion": "1.0",
        "provider": payload.provider,
        "version": MANIFEST["basic_pitch"]["version"],
        "confidence": overall,
        "notes": notes,
    }


@app.post("/separate", dependencies=[Depends(_require_auth)])
def separate(payload: SourceRequest, request: FastAPIRequest) -> dict:
    if payload.provider != "DEMUCS":
        raise HTTPException(422, "separate supports DEMUCS only")
    if not health("DEMUCS")["healthy"]:
        raise HTTPException(503, "Demucs runtime identity is not ready")
    with tempfile.TemporaryDirectory(prefix="music-ai-") as tmp:
        root = Path(tmp)
        source = download_source(str(payload.source_url), root)
        validate_audio(source)
        output = root / "output"
        # Argument vector only: no shell invocation or interpolation.
        try:
            subprocess.run(
                [
                    sys.executable, "-m", "demucs", "-n", "htdemucs", "-d", "cpu",
                    "--two-stems", "vocals", "--flac", "--shifts", "1",
                    "-o", str(output), str(source),
                ],
                check=True,
                capture_output=True,
                timeout=INFERENCE_TIMEOUT,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(504, "Demucs inference timed out") from exc
        except subprocess.CalledProcessError as exc:
            raise HTTPException(503, "Demucs inference failed") from exc
        stems = output / "htdemucs" / source.stem
        vocal, accompaniment = stems / "vocals.flac", stems / "no_vocals.flac"
        if not vocal.is_file() or not accompaniment.is_file():
            raise HTTPException(503, "Demucs did not produce expected two stems")
        artifact_id, result = _store_stems(vocal, accompaniment)
    base_url = str(request.base_url).rstrip("/")
    for stem in result:
        stem["downloadUrl"] = f"{base_url}/artifacts/{artifact_id}/{stem.pop('name')}"
    response = {
        "provider": payload.provider,
        "version": MANIFEST["demucs"]["version"],
        "confidence": 0.0,
        "stems": result,
    }
    if len(json.dumps(response, separators=(",", ":")).encode()) >= MAX_SEPARATION_JSON_BYTES:
        # URLs should make this unreachable, but retain the contract even with
        # an unexpectedly large externally supplied base URL.
        raise HTTPException(500, "separation response exceeds JSON size limit")
    return response


@app.get("/artifacts/{artifact_id}/{name}")
def download_artifact(artifact_id: str, name: str):
    """Download a capability artifact once, then remove it.

    This intentionally does not require MUSIC_AI_WORKER_TOKEN: existing Node
    clients do not attach bearer credentials when dereferencing stem URLs.
    Security is provided by a 256-bit unguessable, short-lived, one-use URL.
    """
    _clean_expired_artifacts()
    if not ARTIFACT_ID.fullmatch(artifact_id) or name not in {"vocals.flac", "instrumental.flac"}:
        raise HTTPException(404, "artifact not found")
    directory = ARTIFACTS / artifact_id
    path = directory / name
    if not path.is_file():
        raise HTTPException(404, "artifact not found")
    return FileResponse(
        path,
        media_type="audio/flac",
        filename=name,
        background=BackgroundTask(_delete_served_artifact, path, directory),
    )


@app.post("/process", dependencies=[Depends(_require_auth)])
def process(payload: ProcessRequest) -> dict:
    from pedalboard import Compressor, Gain, Limiter, Pedalboard
    with tempfile.TemporaryDirectory(prefix="music-ai-") as tmp:
        audio_path = decode_audio(payload.audio_base64, Path(tmp))
        audio, rate = sf.read(audio_path, always_2d=True, dtype="float32")
        processed = Pedalboard([Compressor(threshold_db=payload.threshold_db), Gain(gain_db=payload.gain_db),
                               Limiter(threshold_db=-1)])(audio.T, rate).T
        encoded = wav_b64(processed, rate)
    return {"provider": payload.provider, "version": MANIFEST["pedalboard"]["version"],
            "audio_base64": encoded, "format": "wav", "encoding": "pcm_s16le"}


@app.post("/render", dependencies=[Depends(_require_auth)])
def render(payload: RenderRequest) -> dict:
    try:
        asset = _licensed_asset("vst3" if payload.provider == "VST3" else "sfz")
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc
    marker = asset.get("smokeEvidence") or _readiness_marker().get(
        "vst3" if payload.provider == "VST3" else "sfizz"
    )
    if not (
        isinstance(marker, dict)
        and marker.get("assetId") == asset["id"]
        and marker.get("sha256") == asset["sha256"]
        and marker.get("rendererSha256") == asset["rendererSha256"]
        and marker.get("trackModelRendered") is True
        and marker.get("audible") is True
        and marker.get("canonicalSensitivity") is True
        and marker.get("nativeHostAttested") is True
    ):
        raise HTTPException(503, "selected native asset has not passed its smoke attestation")
    if payload.track_model is None:
        raise HTTPException(422, "instrument rendering requires a canonical TrackModel")
    track = _canonical_track_model(payload.track_model)
    audio, asset = (
        _render_vst3_track(track, payload.sample_rate, payload.duration_seconds)
        if payload.provider == "VST3"
        else _render_sfizz_track(track, payload.sample_rate, payload.duration_seconds)
    )
    encoded_audio = wav_b64(audio.T, payload.sample_rate)
    audio_bytes = base64.b64decode(encoded_audio, validate=True)
    track_model_bytes = json.dumps(
        payload.track_model,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return {
        "contractVersion": "1.0",
        "provider": payload.provider,
        "version": asset["id"],
        "asset": asset,
        "audio_base64": encoded_audio,
        "outputSha256": hashlib.sha256(audio_bytes).hexdigest(),
        "trackModelSha256": hashlib.sha256(track_model_bytes).hexdigest(),
        "performedMaterialSha256": hashlib.sha256(json.dumps({
            "id": track["id"],
            "instrument": track["instrument"],
            "role": track["role"],
            "notes": track["notes"],
            "cc": track["cc"],
            "articulations": track["articulations"],
            "automation": track["automation"],
            "mapping": track.get("mapping"),
        }, separators=(",", ":"), sort_keys=True).encode("utf-8")).hexdigest(),
        "sampleRate": payload.sample_rate,
        "frameCount": int(audio.shape[1]),
        "durationSeconds": payload.duration_seconds,
        "format": "wav",
        "encoding": "pcm_s16le",
        "trackModelId": track["id"],
    }


@app.exception_handler(HTTPException)
async def errors(_, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

def _activate_verified_entry(
    kind: Literal["vst3", "sfz"],
    entry: dict,
    state: dict,
    *,
    response_id: str,
    label: str,
    remove_history_id: str | None = None,
) -> dict:
    _validate_verified_asset(kind, entry, label=label)
    current, manifest_existed = _read_asset_manifest_for_update()
    state["history"] = _rotation_history(
        current,
        state,
        allow_state_fallback=manifest_existed,
    )
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _archive_current_asset(kind, current, state, now)
    if remove_history_id:
        state["history"][kind] = [
            record
            for record in state["history"][kind]
            if not (
                isinstance(record, dict)
                and record.get("historyId") == remove_history_id
            )
        ]
    manifest_entry = {
        key: entry[key]
        for key in (
            "id",
            "identity",
            "licenseOwner",
            "licenseReference",
            "rendererIdentity",
            "sha256",
            "rendererSha256",
            "rendererPath",
            "smokeEvidence",
            "path" if kind == "vst3" else "libraryPath",
        )
        if key in entry
    }
    manifest_entry["candidateId"] = response_id
    if entry.get("createdAt"):
        manifest_entry["createdAt"] = entry["createdAt"]
    manifest_entry["activatedAt"] = now
    current[kind] = manifest_entry
    current["_history"] = state["history"]
    _atomic_write_json(ASSET_MANIFEST_PATH, current, indent=2)
    active_candidate = state["candidates"].get(response_id)
    if isinstance(active_candidate, dict):
        active_candidate["status"] = "active"
        active_candidate["activatedAt"] = now
    response = {
        key: value
        for key, value in entry.items()
        if key not in {"path", "libraryPath", "rendererPath", "candidateRoot"}
    }
    response["candidateId"] = response_id
    response["assetId"] = response.get("assetId") or response.get("id")
    response["kind"] = kind
    response["status"] = "active"
    response["activatedAt"] = now
    try:
        _write_asset_state(state)
    except OSError:
        # The manifest is the single authoritative commit. A stale history
        # list must not turn an atomic activation into a reported failure.
        pass
    return response

def _archive_current_asset(
    kind: Literal["vst3", "sfz"],
    current: dict,
    state: dict,
    now: str,
) -> None:
    record = _history_record(kind, current.get(kind), state, now)
    if not record:
        return
    history = state["history"][kind]
    if any(
        isinstance(previous, dict)
        and (
            previous.get("historyId") == record["historyId"]
            or (
                previous.get("sha256") == record.get("sha256")
                and previous.get("rendererSha256") == record.get("rendererSha256")
                and previous.get("kind") == kind
            )
        )
        for previous in history
    ):
        return
    history.append(record)

def _read_asset_manifest_for_update() -> tuple[dict, bool]:
    try:
        value = json.loads(ASSET_MANIFEST_PATH.read_text())
    except FileNotFoundError:
        return {}, False
    except OSError as exc:
        raise HTTPException(503, "licensed asset manifest could not be read") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(503, "licensed asset manifest is invalid") from exc
    if not isinstance(value, dict):
        raise HTTPException(503, "licensed asset manifest must be a JSON object")
    return value, True

def _history_record(
    kind: Literal["vst3", "sfz"],
    current_entry: object,
    state: dict,
    now: str,
) -> dict | None:
    if not isinstance(current_entry, dict):
        return None
    manifest_entry = {
        key: current_entry[key]
        for key in (
            "id",
            "identity",
            "licenseOwner",
            "licenseReference",
            "rendererIdentity",
            "sha256",
            "rendererSha256",
            "rendererPath",
            "smokeEvidence",
        )
        if key in current_entry
    }
    path_key = "path" if kind == "vst3" else "libraryPath"
    if path_key not in current_entry:
        return None
    manifest_entry[path_key] = current_entry[path_key]
    matching_candidate = next(
        (
            candidate
            for candidate in state["candidates"].values()
            if isinstance(candidate, dict)
            and candidate.get("status") == "active"
            and candidate.get("kind") == kind
            and candidate.get("assetId") == current_entry.get("id")
            and candidate.get("sha256") == current_entry.get("sha256")
            and candidate.get("rendererSha256") == current_entry.get("rendererSha256")
        ),
        None,
    )
    if isinstance(matching_candidate, dict):
        matching_candidate["status"] = "historical"
    history_id = (
        current_entry.get("candidateId")
        or (
            matching_candidate.get("candidateId")
            if isinstance(matching_candidate, dict)
            else None
        )
    ) or f"history-{secrets.token_urlsafe(18)}"
    return {
        **manifest_entry,
        "assetId": manifest_entry.get("id"),
        "historyId": history_id,
        "candidateId": (
            current_entry.get("candidateId")
            or (
                matching_candidate.get("candidateId")
                if isinstance(matching_candidate, dict)
                else history_id
            )
        ),
        "kind": kind,
        "status": "verified",
        "createdAt": (
            current_entry.get("createdAt")
            or (
                matching_candidate.get("createdAt")
                if isinstance(matching_candidate, dict)
                else None
            )
        ),
        "activatedAt": (
            current_entry.get("activatedAt")
            or (
                matching_candidate.get("activatedAt")
                if isinstance(matching_candidate, dict)
                else None
            )
        ),
        "deactivatedAt": now,
    }

def _rotation_history(
    manifest: dict,
    state: dict,
    *,
    allow_state_fallback: bool = True,
) -> dict[str, list[dict]]:
    manifest_history = manifest.get("_history")
    source = (
        manifest_history
        if isinstance(manifest_history, dict)
        else state.get("history", {}) if allow_state_fallback else {}
    )
    return {
        kind: copy.deepcopy(source.get(kind, []))
        if isinstance(source, dict) and isinstance(source.get(kind, []), list)
        else []
        for kind in ("vst3", "sfz")
    }
