"""Pinned, atomic checkpoint synchronization for Modal model storage.

Only sources whose public repository and immutable revision are verified here
are downloadable. Unsupported entries fail explicitly; they never create a
checkpoint-shaped placeholder.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import struct
import urllib.parse
import urllib.request
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())
MODEL_ROOT = Path(os.getenv("MUSIC_GPU_CHECKPOINT_ROOT", MANIFEST["checkpoint_root"]))
SMOKE_FIXTURE = MODEL_ROOT / "_smoke" / "structured-click-track-32s.wav"


@dataclass(frozen=True)
class PublicSnapshot:
    repository: str
    revision: str


PUBLIC_SNAPSHOTS: dict[str, PublicSnapshot] = {
    "ACE_STEP": PublicSnapshot(
        "ACE-Step/Ace-Step1.5",
        "19671f406d603126926c1b7e2adc169acbcade22",
    ),
    "MT3": PublicSnapshot(
        "kunato/mt3-pytorch",
        "03a06ef7f288f64e7cd25f17c3f37bcf9fe111bc",
    ),
    "BS_ROFORMER": PublicSnapshot(
        "puar-playground/bs-roformer",
        "b1361b816daca507f079d85e935c291bcb0a5351",
    ),
}
ACE_BASE_REPOSITORY = "ACE-Step/acestep-v15-base"
ACE_BASE_REVISION = "e432212fec32b8965a14ffa57ae653438d6abd14"
ACE_FULL_ALLOW_PATTERNS = (
    "config.json",
    "vae/*",
    "Qwen3-Embedding-0.6B/*",
)
ACE_BASE_ALLOW_PATTERNS = (
    "apg_guidance.py",
    "config.json",
    "configuration_acestep_v15.py",
    "model.safetensors",
    "modeling_acestep_v15_base.py",
    "silence_latent.pt",
)
ACE_FORBIDDEN_PARTS = {"acestep-v15-turbo", "acestep-5Hz-lm-1.7B"}
MT3_FILES = {
    "config.json": {
        "url": (
            "https://raw.githubusercontent.com/kunato/mt3-pytorch/"
            "03a06ef7f288f64e7cd25f17c3f37bcf9fe111bc/pretrained/config.json"
        ),
        "sha256": "e1584759624ddecfeca7eaaaaf60cea58a5dbd1012957666dc685bf51b93907a",
        "bytes": 466,
        "max_bytes": 4 * 1024,
    },
    "mt3.pth": {
        "url": (
            "https://media.githubusercontent.com/media/kunato/mt3-pytorch/"
            "03a06ef7f288f64e7cd25f17c3f37bcf9fe111bc/pretrained/mt3.pth"
        ),
        "sha256": "b8a3807ed265059abd25ad7f68142c06c35e8f6144dcaa45bd55946a3745398f",
        "bytes": 183_672_643,
        "max_bytes": 192 * 1024 * 1024,
    },
}
UNVERIFIED_SOURCES: dict[str, str] = {
    "BS_ROFORMER": (
        "checkpoint-owner license, redistribution rights, and commercial-use "
        "authorization are not verified"
    ),
}
BS_CHECKPOINT_FILENAME = "bs_roformer.ckpt"
BS_CHECKPOINT_SHA256 = "5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa"
BS_CHECKPOINT_SIZE = 639_331_213
BS_CONFIG_FILENAME = "bs_roformer.yaml"
BS_CONFIG_SHA256 = "9df444dbc1a704e23858e0315a211ec5fa4c69f92ecefb173d05e8f721ed2b1f"
BS_CONFIG_SIZE = 1_677


def checkpoint_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    if path.is_file():
        files = [path]
    elif path.is_dir():
        files = sorted(item for item in path.rglob("*") if item.is_file())
        if not files:
            raise RuntimeError("checkpoint directory is empty")
    else:
        raise RuntimeError("checkpoint is missing")
    for item in files:
        if path.is_dir():
            digest.update(item.relative_to(path).as_posix().encode())
        with item.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    return digest.hexdigest()


def _write_smoke_fixture() -> None:
    """Write deterministic rhythmic/harmonic audio that can yield structure evidence."""
    SMOKE_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    temporary = SMOKE_FIXTURE.with_name(f".{SMOKE_FIXTURE.name}.{uuid.uuid4().hex}")
    sample_rate = 44_100
    duration_seconds = 32
    chord_frequencies = (
        (130.81, 164.81, 196.00),  # C major
        (110.00, 130.81, 164.81),  # A minor
        (87.31, 130.81, 174.61),   # F major
        (98.00, 123.47, 146.83),   # G major
    )
    with wave.open(str(temporary), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        frames = bytearray()
        for index in range(sample_rate * duration_seconds):
            time = index / sample_rate
            beat_phase = time % 0.5
            eighth_phase = time % 0.25
            snare_phase = (time - 0.5) % 1.0
            beat_number = int(time / 0.5)
            section = min(int(time / 8.0), len(chord_frequencies) - 1)
            chord = chord_frequencies[section]
            pad = sum(math.sin(2 * math.pi * frequency * time) for frequency in chord)
            pulse = 0.45 + 0.55 * math.exp(-7 * beat_phase)
            kick_gain = 1.35 if beat_number % 4 == 0 else 1.0
            kick = kick_gain * math.exp(-18 * beat_phase) * math.sin(
                2 * math.pi * (52 + 38 * math.exp(-24 * beat_phase)) * beat_phase
            )
            noise = sum(
                math.sin(2 * math.pi * frequency * time)
                for frequency in (1733, 2381, 3253, 4211)
            ) / 4
            snare = math.exp(-24 * snare_phase) * noise
            hat = math.exp(-85 * eighth_phase) * math.sin(2 * math.pi * 6300 * time)
            bass = math.exp(-5 * beat_phase) * math.sin(
                2 * math.pi * chord[0] / 2 * time
            )
            sample = (
                0.10 * pad * pulse
                + 0.34 * kick
                + 0.18 * snare
                + 0.08 * hat
                + 0.12 * bass
            )
            frames.extend(struct.pack("<h", int(max(-0.95, min(0.95, sample)) * 32767)))
            if len(frames) >= 8192:
                output.writeframesraw(frames)
                frames.clear()
        if frames:
            output.writeframesraw(frames)
    os.replace(temporary, SMOKE_FIXTURE)


def _link_or_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def _validate_ace_composite(path: Path) -> None:
    required = [
        path / "config.json",
        path / "vae" / "config.json",
        path / "vae" / "diffusion_pytorch_model.safetensors",
        path / "Qwen3-Embedding-0.6B" / "config.json",
        path / "Qwen3-Embedding-0.6B" / "model.safetensors",
        *[path / "acestep-v15-base" / name for name in ACE_BASE_ALLOW_PATTERNS],
    ]
    if any(not item.is_file() for item in required):
        raise RuntimeError("ACE-Step composite checkpoint is incomplete")
    if any((path / forbidden).exists() for forbidden in ACE_FORBIDDEN_PARTS):
        raise RuntimeError("ACE-Step composite contains an excluded thinking/turbo model")
    allowed_root = {"config.json", "vae", "Qwen3-Embedding-0.6B", "acestep-v15-base"}
    if {item.name for item in path.iterdir()} - allowed_root:
        raise RuntimeError("ACE-Step composite contains unexpected root metadata")


def _bootstrap_ace(destination: Path, stage: Path) -> None:
    from huggingface_hub import snapshot_download

    old_base = MODEL_ROOT / "ace-step-1.5-base"
    base_destination = stage / "acestep-v15-base"
    if old_base.is_dir() and all((old_base / name).is_file() for name in ACE_BASE_ALLOW_PATTERNS):
        for name in ACE_BASE_ALLOW_PATTERNS:
            _link_or_copy(old_base / name, base_destination / name)
    # Running the pinned snapshot operation even after hardlinking means the
    # Hub metadata independently verifies/replaces staged bytes as necessary;
    # the old source directory is never mutated.
    snapshot_download(
        repo_id=ACE_BASE_REPOSITORY,
        revision=ACE_BASE_REVISION,
        local_dir=base_destination,
        allow_patterns=list(ACE_BASE_ALLOW_PATTERNS),
        force_download=False,
        resume_download=True,
    )
    shutil.rmtree(base_destination / ".cache", ignore_errors=True)
    snapshot_download(
        repo_id=PUBLIC_SNAPSHOTS["ACE_STEP"].repository,
        revision=PUBLIC_SNAPSHOTS["ACE_STEP"].revision,
        local_dir=stage,
        allow_patterns=list(ACE_FULL_ALLOW_PATTERNS),
        force_download=False,
        resume_download=True,
    )
    shutil.rmtree(stage / ".cache", ignore_errors=True)
    _validate_ace_composite(stage)
    if destination.exists():
        raise RuntimeError("checkpoint destination appeared during bootstrap")
    os.replace(stage, destination)


def _validate_exact_file(path: Path, *, digest: str, size: int, label: str) -> None:
    if not path.is_file() or path.stat().st_size != size:
        raise RuntimeError(f"{label} is missing or has the wrong size")
    if checkpoint_sha256(path) != digest:
        raise RuntimeError(f"{label} SHA-256 does not match its immutable source")


def _validate_bs_roformer(checkpoint: Path, config: Path) -> None:
    _validate_exact_file(
        checkpoint,
        digest=BS_CHECKPOINT_SHA256,
        size=BS_CHECKPOINT_SIZE,
        label="BS-RoFormer checkpoint",
    )
    _validate_exact_file(
        config,
        digest=BS_CONFIG_SHA256,
        size=BS_CONFIG_SIZE,
        label="BS-RoFormer config",
    )


def _bootstrap_bs_roformer(destination: Path, stage: Path, config: Path) -> None:
    from huggingface_hub import hf_hub_download

    source = PUBLIC_SNAPSHOTS["BS_ROFORMER"]
    stage.mkdir(mode=0o750)
    staged_checkpoint = stage / destination.name
    staged_config = stage / config.name
    shutil.copyfile(
        hf_hub_download(
            repo_id=source.repository,
            revision=source.revision,
            filename=BS_CHECKPOINT_FILENAME,
        ),
        staged_checkpoint,
    )
    shutil.copyfile(
        hf_hub_download(
            repo_id=source.repository,
            revision=source.revision,
            filename=BS_CONFIG_FILENAME,
        ),
        staged_config,
    )
    _validate_bs_roformer(staged_checkpoint, staged_config)
    if destination.exists():
        raise RuntimeError("checkpoint destination appeared during bootstrap")
    # Publish config first so the checkpoint readiness marker can never appear
    # without its already-validated matching configuration.
    os.replace(staged_config, config)
    os.replace(staged_checkpoint, destination)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _validate_mt3_snapshot(path: Path) -> None:
    if not path.is_dir() or {item.name for item in path.iterdir()} != set(MT3_FILES):
        raise RuntimeError("MT3 checkpoint must contain only config.json and mt3.pth")
    for name, artifact in MT3_FILES.items():
        item = path / name
        if not item.is_file() or item.is_symlink():
            raise RuntimeError(f"MT3 checkpoint artifact {name} is missing or unsafe")
        if item.stat().st_size != artifact["bytes"]:
            raise RuntimeError(f"MT3 checkpoint artifact {name} has an invalid size")
        if _file_sha256(item) != artifact["sha256"]:
            raise RuntimeError(f"MT3 checkpoint artifact {name} failed SHA-256 verification")
    expected = MANIFEST["providers"]["MT3"]["checkpoint_sha256"]
    if checkpoint_sha256(path) != expected:
        raise RuntimeError("MT3 canonical checkpoint SHA-256 does not match the manifest")


def _download_verified(url: str, destination: Path, expected: str, max_bytes: int) -> None:
    digest = hashlib.sha256()
    size = 0
    request = urllib.request.Request(
        url, headers={"User-Agent": "music-ai-checkpoint-bootstrap/1"}
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response, destination.open(
            "xb"
        ) as output:
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > max_bytes:
                    raise RuntimeError(
                        "checkpoint artifact exceeds its reviewed size limit"
                    )
                digest.update(block)
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    if size <= 0 or digest.hexdigest() != expected:
        destination.unlink(missing_ok=True)
        raise RuntimeError("checkpoint artifact failed SHA-256 verification")


def _bootstrap_mt3(destination: Path, stage: Path) -> None:
    stage.mkdir(parents=True, exist_ok=False)
    for name, artifact in MT3_FILES.items():
        _download_verified(
            artifact["url"],
            stage / name,
            artifact["sha256"],
            artifact["max_bytes"],
        )
    _validate_mt3_snapshot(stage)
    if destination.exists():
        raise RuntimeError("checkpoint destination appeared during bootstrap")
    os.replace(stage, destination)


def _validated_asset(asset: object) -> dict[str, str | int]:
    if not isinstance(asset, dict):
        raise RuntimeError("checkpoint asset metadata is invalid")
    required_text = (
        "kind", "path", "url", "repository", "revision", "license", "sha256",
    )
    if any(not isinstance(asset.get(key), str) or not asset[key].strip()
           for key in required_text):
        raise RuntimeError("checkpoint asset metadata is incomplete")
    relative = Path(str(asset["path"]))
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError("checkpoint asset path must stay inside the staged checkpoint")
    parsed = urllib.parse.urlsplit(str(asset["url"]))
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("checkpoint asset URL must be absolute HTTPS")
    expected_hash = str(asset["sha256"]).lower()
    if len(expected_hash) != 64 or any(char not in "0123456789abcdef" for char in expected_hash):
        raise RuntimeError("checkpoint asset SHA-256 is invalid")
    size = asset.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise RuntimeError("checkpoint asset size is invalid")
    return asset


def _download_asset(asset: dict[str, str | int], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        str(asset["url"]), headers={"User-Agent": "music-ai-checkpoint-bootstrap/1"},
    )
    digest = hashlib.sha256()
    total = 0
    try:
        with urllib.request.urlopen(request, timeout=120) as response, destination.open("xb") as output:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > int(asset["size"]):
                    raise RuntimeError("checkpoint asset exceeds its pinned size")
                digest.update(block)
                output.write(block)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    if total != asset["size"] or digest.hexdigest() != asset["sha256"]:
        destination.unlink(missing_ok=True)
        raise RuntimeError("checkpoint asset does not match its pinned size and SHA-256")


def _validate_all_in_one(path: Path) -> None:
    details = MANIFEST["providers"]["ALL_IN_ONE"]
    expected_paths: set[str] = set()
    for raw_asset in details.get("assets", []):
        asset = _validated_asset(raw_asset)
        relative = str(asset["path"])
        expected_paths.add(relative)
        target = path / relative
        if (not target.is_file() or target.stat().st_size != asset["size"]
                or checkpoint_sha256(target) != asset["sha256"]):
            raise RuntimeError(f"All-In-One asset is missing or mismatched: {relative}")
    actual_paths = {
        item.relative_to(path).as_posix()
        for item in path.rglob("*")
        if item.is_file()
    }
    if not expected_paths or actual_paths != expected_paths:
        raise RuntimeError("All-In-One checkpoint set is incomplete or contains unexpected files")
    if checkpoint_sha256(path) != details["checkpoint_sha256"]:
        raise RuntimeError("All-In-One aggregate checkpoint SHA-256 is mismatched")


def _bootstrap_all_in_one(destination: Path, stage: Path) -> None:
    details = MANIFEST["providers"]["ALL_IN_ONE"]
    for raw_asset in details.get("assets", []):
        asset = _validated_asset(raw_asset)
        _download_asset(asset, stage / str(asset["path"]))
    _validate_all_in_one(stage)
    if destination.exists():
        raise RuntimeError("checkpoint destination appeared during bootstrap")
    os.replace(stage, destination)


def bootstrap_provider(provider: str) -> dict[str, str | int]:
    # This authentic generated fixture is independent of provider weights and
    # is safe to persist even when a provider source remains blocked.
    _write_smoke_fixture()
    if provider in UNVERIFIED_SOURCES:
        raise RuntimeError(f"{provider} bootstrap unavailable: {UNVERIFIED_SOURCES[provider]}")
    details = MANIFEST["providers"].get(provider)
    source = PUBLIC_SNAPSHOTS.get(provider)
    if not details or (not source and provider != "ALL_IN_ONE"):
        raise RuntimeError(f"{provider} has no pinned public checkpoint source")
    destination = MODEL_ROOT / details["checkpoint_path"]
    config = (
        MODEL_ROOT / details["config_path"]
        if provider == "BS_ROFORMER"
        else None
    )
    if destination.exists():
        if provider == "ACE_STEP":
            _validate_ace_composite(destination)
        elif provider == "BS_ROFORMER":
            assert config is not None
            _validate_bs_roformer(destination, config)
        elif provider == "MT3":
            _validate_mt3_snapshot(destination)
        elif provider == "ALL_IN_ONE":
            _validate_all_in_one(destination)
        digest = checkpoint_sha256(destination)
    else:
        stage = MODEL_ROOT / f".bootstrap-{provider.lower()}-{uuid.uuid4().hex}"
        try:
            if provider == "ACE_STEP":
                _bootstrap_ace(destination, stage)
            elif provider == "BS_ROFORMER":
                assert config is not None
                _bootstrap_bs_roformer(destination, stage, config)
            elif provider == "MT3":
                _bootstrap_mt3(destination, stage)
            elif provider == "ALL_IN_ONE":
                _bootstrap_all_in_one(destination, stage)
            else:
                raise RuntimeError(f"{provider} has no implemented snapshot builder")
        finally:
            if stage.exists():
                shutil.rmtree(stage)
        digest = checkpoint_sha256(destination)
    size = (
        destination.stat().st_size
        if destination.is_file()
        else sum(item.stat().st_size for item in destination.rglob("*") if item.is_file())
    )
    return {
        "provider": provider,
        "path": str(destination.relative_to(MODEL_ROOT)),
        "digest": digest,
        "revision": details["revision"] if provider == "ALL_IN_ONE" else (
            f"{source.repository}@{source.revision};"
            f"{ACE_BASE_REPOSITORY}@{ACE_BASE_REVISION}"
            if provider == "ACE_STEP" else source.revision
        ),
        "size": size,
    }