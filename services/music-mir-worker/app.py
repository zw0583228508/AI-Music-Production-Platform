"""Isolated, fail-closed MIR service for licensed/compatible analysis only."""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import secrets
import socket
import tempfile
import time
import threading
from http.client import HTTPConnection, HTTPSConnection
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, HttpUrl

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "assets_manifest.json").read_text(encoding="utf-8"))
MAX_SOURCE_BYTES = int(os.getenv("MIR_MAX_SOURCE_BYTES", str(25 * 1024 * 1024)))
MAX_DURATION = float(os.getenv("MIR_MAX_DURATION_SECONDS", "300"))
FETCH_TIMEOUT = float(os.getenv("MIR_FETCH_TIMEOUT_SECONDS", "20"))
ASSET_ROOT = Path(os.getenv("MIR_ASSET_ROOT", MANIFEST["assetRoot"])).resolve()
READINESS_ROOT = ASSET_ROOT / ".readiness"
ALL_PROVIDERS = ("MADMOM", "TORCHCREPE", "ESSENTIA", "CHROMA", "PYLOUDNORM")
PROVIDERS = tuple(
    item.strip() for item in os.getenv("MIR_ENABLED_PROVIDERS", ",".join(ALL_PROVIDERS)).split(",")
    if item.strip() in ALL_PROVIDERS
)
MADMOM_SESSION = None
MADMOM_SESSION_LOCK = threading.Lock()
if not PROVIDERS:
    raise RuntimeError("MIR_ENABLED_PROVIDERS must contain at least one supported provider")
app = FastAPI(title="Isolated Music MIR Worker", version="1.0.0")


def _auth(request: Request) -> None:
    # The existing runtime secret remains the single bearer-token authority.
    token = (os.getenv("MIR_WORKER_TOKEN") or os.getenv("MUSIC_AI_WORKER_TOKEN") or "").strip()
    if not token or not secrets.compare_digest(
        request.headers.get("authorization", ""), f"Bearer {token}"
    ):
        raise HTTPException(401, "worker authentication is required")


def _addresses(host: str, port: int) -> list[tuple[int, tuple]]:
    try:
        answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(400, "sourceUrl host could not be resolved") from exc
    vetted = []
    for family, _, _, _, sockaddr in answers:
        if not ipaddress.ip_address(sockaddr[0]).is_global:
            raise HTTPException(400, "sourceUrl must resolve only to global addresses")
        vetted.append((family, sockaddr))
    if not vetted:
        raise HTTPException(400, "sourceUrl host could not be resolved")
    return vetted


class _VettedConnection:
    def __init__(self, connection_type, host: str, port: int, address: tuple[int, tuple]):
        self.connection = connection_type(host, port=port, timeout=FETCH_TIMEOUT)
        self.family, self.sockaddr = address

    def connect(self):
        sock = socket.socket(self.family, socket.SOCK_STREAM)
        sock.settimeout(FETCH_TIMEOUT)
        sock.connect(self.sockaddr)
        if isinstance(self.connection, HTTPSConnection):
            sock = self.connection._context.wrap_socket(sock, server_hostname=self.connection.host)
        self.connection.sock = sock
        return self.connection


def _fetch(url: str, directory: Path) -> Path:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(400, "sourceUrl must be a public http(s) URL")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise HTTPException(400, "sourceUrl has an invalid port") from exc
    connection = _VettedConnection(
        HTTPSConnection if parsed.scheme == "https" else HTTPConnection,
        parsed.hostname, port, _addresses(parsed.hostname, port)[0],
    ).connect()
    try:
        connection.request("GET", (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else ""),
                           headers={"User-Agent": "music-mir-worker/1.0"})
        response = connection.getresponse()
        if not 200 <= response.status < 300 or 300 <= response.status < 400:
            raise HTTPException(400, "source server returned an unsuccessful response")
        declared = response.headers.get("content-length")
        if declared and int(declared) > MAX_SOURCE_BYTES:
            raise HTTPException(413, "source exceeds download size limit")
        target = directory / ("source" + (Path(parsed.path).suffix.lower() or ".audio"))
        total = 0
        with target.open("wb") as out:
            while block := response.read(64 * 1024):
                total += len(block)
                if total > MAX_SOURCE_BYTES:
                    raise HTTPException(413, "source exceeds download size limit")
                out.write(block)
        return target
    except (OSError, ValueError, TimeoutError) as exc:
        raise HTTPException(400, "unable to download source") from exc
    finally:
        connection.close()


def _decode(request: "AnalysisRequest", directory: Path) -> tuple[np.ndarray, int]:
    if request.audio_base64:
        try:
            raw = base64.b64decode(request.audio_base64, validate=True)
        except Exception as exc:
            raise HTTPException(422, "audioBase64 is invalid") from exc
        if not raw or len(raw) > MAX_SOURCE_BYTES:
            raise HTTPException(413, "audioBase64 exceeds size limit")
        path = directory / "input.wav"
        path.write_bytes(raw)
    else:
        path = _fetch(str(request.source_url), directory)
    try:
        info = sf.info(path)
        audio, rate = sf.read(path, always_2d=True, dtype="float32")
    except RuntimeError as exc:
        raise HTTPException(415, "source is not decodable audio") from exc
    if not info.samplerate or not 0 < info.duration <= MAX_DURATION or not np.isfinite(audio).all():
        raise HTTPException(422, "audio is outside permitted bounds")
    mono = np.mean(audio, axis=1)
    if not np.any(np.abs(mono) > 1e-7):
        raise HTTPException(422, "silent audio is not valid analysis input")
    return mono, rate


def _package_ready(provider: str) -> tuple[bool, str | None]:
    package = MANIFEST["providers"][provider].get("package")
    if not package:
        return True, None
    try:
        actual = version(package)
    except PackageNotFoundError:
        return False, "package is not installed in isolated runtime"
    return (actual == MANIFEST["providers"][provider]["version"],
            None if actual == MANIFEST["providers"][provider]["version"] else "package version is not pinned")


def _require_enabled(provider: str) -> None:
    if provider not in PROVIDERS:
        # A disabled provider must not become a discoverable capability on the
        # wrong Python/runtime image.
        raise HTTPException(404, "provider is not exposed by this runtime")


def _madmom_assets_ready() -> bool:
    expected = MANIFEST["providers"]["MADMOM"]["assets"]
    for asset in expected:
        if (not isinstance(asset, dict) or not isinstance(asset.get("path"), str)
                or not isinstance(asset.get("sha256"), str)
                or len(asset["sha256"]) != 64):
            return False
        path = (ASSET_ROOT / asset["path"]).resolve()
        try:
            path.relative_to(ASSET_ROOT)
        except ValueError:
            return False
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != asset["sha256"].lower():
            return False
    return True


def _madmom_session():
    """Construct one real Phase-2 RNN/DBN session only after asset validation."""
    global MADMOM_SESSION
    if MADMOM_SESSION is not None:
        return MADMOM_SESSION
    if not _madmom_assets_ready():
        raise RuntimeError("verified MADMOM model assets are unavailable")
    with MADMOM_SESSION_LOCK:
        if MADMOM_SESSION is None:
            # `RNNDownBeatProcessor` calls downbeats_blstm() itself. Pinning
            # XDG to our checked volume ensures that call can only reopen the
            # verified files above, never place request-time downloads elsewhere.
            os.environ["XDG_CACHE_HOME"] = str(ASSET_ROOT / ".cache")
            from madmom_infer.features.downbeats import (
                DBNDownBeatTrackingProcessor,
                RNNDownBeatProcessor,
            )
            MADMOM_SESSION = (
                RNNDownBeatProcessor(),
                DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], fps=100),
            )
    return MADMOM_SESSION


def _madmom_result(audio: np.ndarray, rate: int, directory: Path) -> dict:
    """Use madmom-infer 0.2.0's actual Phase-2 public processor chain."""
    from scipy.signal import resample_poly
    if rate != 44100:
        divisor = np.gcd(rate, 44100)
        audio = resample_poly(audio, 44100 // divisor, rate // divisor).astype(np.float32)
    wav = directory / "madmom-44100.wav"
    sf.write(wav, audio, 44100, subtype="PCM_16")
    activation_processor, tracking_processor = _madmom_session()
    activations = np.asarray(activation_processor(str(wav)))
    positions = np.asarray(tracking_processor(activations))
    if positions.ndim != 2 or positions.shape[0] < 2 or positions.shape[1] != 2:
        raise ValueError("MADMOM DBN produced insufficient beat/downbeat positions")
    beat_times = positions[:, 0]
    intervals = np.diff(beat_times)
    finite = intervals[np.isfinite(intervals) & (intervals > 0)]
    if not finite.size:
        raise ValueError("MADMOM beat positions do not produce a tempo")
    return {
        "beats": beat_times.round(6).tolist(),
        "downbeats": beat_times[positions[:, 1] == 1].round(6).tolist(),
        "tempoBpm": round(float(60 / np.median(finite)), 4),
        "activationFrames": int(activations.shape[0]),
        # v0.2.0 only implements DOWNBEATS_BLSTM/RNNDownBeatProcessor. Do not
        # silently substitute a different model for unsupported task families.
        "key": {"status": "unavailable", "reason": "madmom-infer 0.2.0 has no key-estimation processor"},
        "onsets": {"status": "unavailable", "reason": "madmom-infer 0.2.0 has no onset-RNN processor"},
    }


def _execution_ready(provider: str) -> bool:
    """A package import is never readiness; only a persisted real execution is."""
    try:
        marker = json.loads((READINESS_ROOT / f"{provider.lower()}.json").read_text())
    except (OSError, json.JSONDecodeError):
        return False
    expected = MANIFEST["providers"][provider].get("version")
    return (
        marker.get("provider") == provider
        and marker.get("featureExecutionSucceeded") is True
        and (expected is None or marker.get("packageVersion") == expected)
    )


def _chords(vector: np.ndarray) -> list[str]:
    roots = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    scores = []
    for root in range(12):
        major = vector[root] + vector[(root + 4) % 12] + vector[(root + 7) % 12]
        minor = vector[root] + vector[(root + 3) % 12] + vector[(root + 7) % 12]
        scores.extend([(major, roots[root]), (minor, roots[root] + "m")])
    return [name for _, name in sorted(scores, reverse=True)[:3]]


def _beats(audio: np.ndarray, rate: int) -> np.ndarray:
    import librosa
    _, beats = librosa.beat.beat_track(y=audio, sr=rate, units="time", sparse=True)
    beats = np.asarray(beats, dtype=float)
    if beats.size < 2:
        raise ValueError("beat tracking produced insufficient evidence")
    return beats


def _essentia_hpcp(audio: np.ndarray) -> np.ndarray:
    """Run Essentia's peak-based HPCP path, not a look-alike NumPy chroma."""
    import essentia.standard as es
    frames = es.FrameGenerator(audio, frameSize=4096, hopSize=2048, startFromZero=True)
    try:
        frame = next(iter(frames))
    except StopIteration as exc:
        raise ValueError("audio is too short for Essentia HPCP") from exc
    spectrum = es.Spectrum()(es.Windowing(type="blackmanharris62")(frame))
    frequencies, magnitudes = es.SpectralPeaks()(spectrum)
    return np.asarray(es.HPCP(size=12)(frequencies, magnitudes), dtype=float)


def _essentia_key(audio: np.ndarray) -> tuple[str, str, float]:
    """KeyExtractor is Essentia's audio-in algorithm; Key expects a PCP vector."""
    import essentia.standard as es
    key, scale, strength = es.KeyExtractor()(audio)
    if not isinstance(key, str) or not isinstance(scale, str) or not np.isfinite(strength):
        raise ValueError("Essentia KeyExtractor returned invalid key evidence")
    return key, scale, float(strength)


def _chroma(audio: np.ndarray, rate: int) -> dict:
    import librosa
    beats = _beats(audio, rate)
    hpcp = _essentia_hpcp(audio)
    if len(hpcp) != 12 or not np.isfinite(hpcp).all():
        raise ValueError("Essentia HPCP did not execute")
    # STFT chroma is a supported librosa audio feature on the py314 runtime.
    # (CQT adds an avoidable optional-kernel compatibility surface.)
    lib = librosa.feature.chroma_stft(y=audio, sr=rate, hop_length=512)
    if lib.shape[0] != 12 or not np.isfinite(lib).all():
        raise ValueError("librosa chroma did not execute")
    frame_times = librosa.frames_to_time(np.arange(lib.shape[1]), sr=rate)
    evidence = []
    for start, end in zip(beats[:-1], beats[1:]):
        mask = (frame_times >= start) & (frame_times < end)
        chroma = lib[:, mask].mean(axis=1) if np.any(mask) else lib[:, np.argmin(abs(frame_times - start))]
        values = np.maximum(0, chroma + hpcp)
        values = values / values.sum()
        evidence.append({"time": round(float(start), 6), "pitchClassProbabilities": values.round(7).tolist(),
                         "candidateChords": _chords(values), "confidence": round(float(values.max()), 6)})
    if not evidence:
        raise ValueError("beat alignment produced no chroma evidence")
    # Three-beat moving average after beat alignment; retain both sources/evidence.
    for index, item in enumerate(evidence):
        window = evidence[max(0, index - 1):min(len(evidence), index + 2)]
        smooth = np.mean([x["pitchClassProbabilities"] for x in window], axis=0)
        item["pitchClassProbabilities"] = (smooth / smooth.sum()).round(7).tolist()
        item["candidateChords"] = _chords(smooth)
    return {"frames": evidence, "evidence": {"beatTimes": beats.round(6).tolist(),
            "essentiaHpcp": np.asarray(hpcp).round(7).tolist(), "librosaChromaFrames": int(lib.shape[1])}}


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    provider: Literal["MADMOM", "TORCHCREPE", "ESSENTIA", "CHROMA", "PYLOUDNORM"]
    source_url: HttpUrl | None = Field(default=None, alias="sourceUrl")
    audio_base64: str | None = Field(default=None, alias="audioBase64", max_length=MAX_SOURCE_BYTES * 2)

    def model_post_init(self, __context):
        if bool(self.source_url) == bool(self.audio_base64):
            raise ValueError("exactly one of sourceUrl or audioBase64 is required")


@app.get("/health", dependencies=[Depends(_auth)])
@app.get("/health/{provider}", dependencies=[Depends(_auth)])
def health(provider: Literal["MADMOM", "TORCHCREPE", "ESSENTIA", "CHROMA", "PYLOUDNORM"]) -> dict:
    _require_enabled(provider)
    package_ready, reason = _package_ready(provider)
    model_ready = provider != "MADMOM" or _madmom_assets_ready()
    execution_ready = _execution_ready(provider)
    ready = package_ready and model_ready and execution_ready
    package = MANIFEST["providers"][provider].get("package")
    pinned_version = (MANIFEST["providers"][provider].get("version")
                      or MANIFEST["providers"][provider].get("implementation"))
    identity = json.dumps(MANIFEST["providers"][provider], sort_keys=True).encode()
    return {"provider": provider, "status": "ready" if ready else "not_ready", "ready": ready,
            "modelVersion": pinned_version, "checksum": hashlib.sha256(identity).hexdigest(),
            "packageName": package, "packageVersion": pinned_version,
            "packageReady": package_ready, "assetReady": model_ready,
            "featureExecutionReady": execution_ready,
            "runtimeReady": package_ready and model_ready,
            "checkpointReady": model_ready, "smokeTested": execution_ready,
            "reason": reason or (None if model_ready and execution_ready else
                                  "persisted real feature-execution smoke evidence is required")}


@app.post("/analyze", dependencies=[Depends(_auth)])
def analyze(request: AnalysisRequest) -> dict:
    _require_enabled(request.provider)
    package_ready, reason = _package_ready(request.provider)
    if not package_ready:
        raise HTTPException(503, reason)
    if request.provider == "MADMOM" and not _madmom_assets_ready():
        raise HTTPException(503, "verified MADMOM assets are required; downloads are disabled")
    with tempfile.TemporaryDirectory(prefix="mir-") as temporary:
        audio, rate = _decode(request, Path(temporary))
        try:
            if request.provider == "PYLOUDNORM":
                import pyloudnorm as pyln
                meter = pyln.Meter(rate)
                result = {"integratedLUFS": round(float(meter.integrated_loudness(audio)), 4),
                          "loudnessRange": round(float(meter.loudness_range(audio)), 4),
                          "samplePeak": round(float(np.max(np.abs(audio))), 8)}
            elif request.provider == "TORCHCREPE":
                import torch
                import torchcrepe
                samples = torch.tensor(audio, dtype=torch.float32).unsqueeze(0)
                pitch, periodicity = torchcrepe.predict(samples, rate, 160, 50, 2000, model="full",
                                                        return_periodicity=True, batch_size=512, device="cpu")
                values = []
                for i, (hz, confidence) in enumerate(zip(pitch[0].tolist(), periodicity[0].tolist())):
                    voiced = confidence >= 0.5 and hz > 0
                    values.append({"time": round(i * 160 / rate, 6), "frequencyHz": round(hz, 5) if voiced else 0.0,
                                   "periodicity": round(confidence, 6), "voiced": voiced,
                                   "midiPitch": round(69 + 12 * np.log2(hz / 440), 5) if voiced else None,
                                   "confidence": round(confidence, 6)})
                if not values: raise ValueError("TorchCREPE produced no frames")
                result = {"frames": values, "model": "full"}
            elif request.provider == "CHROMA":
                result = _chroma(audio, rate)
            elif request.provider == "ESSENTIA":
                key, scale, strength = _essentia_key(audio)
                result = {"key": key, "scale": scale, "confidence": round(float(strength), 6),
                          "hpcp": _essentia_hpcp(audio).round(7).tolist()}
            else:
                result = _madmom_result(audio, rate, Path(temporary))
        except Exception as exc:
            raise HTTPException(503, f"{request.provider} feature execution failed") from exc
    return {"provider": request.provider, "status": "ok", "sampleRate": rate, "result": result,
            "executedAt": int(time.time())}


@app.post("/analyze/{provider}", dependencies=[Depends(_auth)])
def analyze_provider(
    provider: Literal["MADMOM", "TORCHCREPE", "ESSENTIA", "CHROMA", "PYLOUDNORM"],
    request: AnalysisRequest,
) -> dict:
    """Provider-scoped boundary rejects body/path drift instead of guessing."""
    if request.provider != provider:
        raise HTTPException(422, "provider path and request body must match")
    return analyze(request)