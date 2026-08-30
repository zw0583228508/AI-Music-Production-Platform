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
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())
MODEL_ROOT = Path(os.getenv("MUSIC_GPU_CHECKPOINT_ROOT", MANIFEST["checkpoint_root"]))
SMOKE_FIXTURE = MODEL_ROOT / "_smoke" / "non-silent-440hz-1s.wav"


@dataclass(frozen=True)
class PublicSnapshot:
    repository: str
    revision: str


# This is the only public checkpoint snapshot whose immutable revision was
# verified during implementation. The other provider adapters name model
# identities, but do not establish an unambiguous public checkpoint snapshot.
PUBLIC_SNAPSHOTS: dict[str, PublicSnapshot] = {
    "ACE_STEP": PublicSnapshot(
        "ACE-Step/Ace-Step1.5",
        "19671f406d603126926c1b7e2adc169acbcade22",
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
UNVERIFIED_SOURCES = {
    "BS_ROFORMER": "no unambiguous public Viperx-v1 checkpoint revision is pinned",
    "MT3": "the T5X checkpoint tree has no verified public snapshot pin",
    "ALL_IN_ONE": "the adapter does not identify a verified public weight snapshot",
}


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
    SMOKE_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    temporary = SMOKE_FIXTURE.with_name(f".{SMOKE_FIXTURE.name}.{uuid.uuid4().hex}")
    with wave.open(str(temporary), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(b"".join(
            struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * index / 16_000)))
            for index in range(16_000)
        ))
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


def bootstrap_provider(provider: str) -> dict[str, str | int]:
    # This authentic generated fixture is independent of provider weights and
    # is safe to persist even when a provider source remains blocked.
    _write_smoke_fixture()
    if provider in UNVERIFIED_SOURCES:
        raise RuntimeError(f"{provider} bootstrap unavailable: {UNVERIFIED_SOURCES[provider]}")
    source = PUBLIC_SNAPSHOTS.get(provider)
    details = MANIFEST["providers"].get(provider)
    if not source or not details:
        raise RuntimeError(f"{provider} has no pinned public checkpoint source")
    destination = MODEL_ROOT / details["checkpoint_path"]
    if destination.exists():
        if provider == "ACE_STEP":
            _validate_ace_composite(destination)
        digest = checkpoint_sha256(destination)
    else:
        stage = MODEL_ROOT / f".bootstrap-{provider.lower()}-{uuid.uuid4().hex}"
        try:
            if provider == "ACE_STEP":
                _bootstrap_ace(destination, stage)
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
        "revision": (
            f"{source.repository}@{source.revision};"
            f"{ACE_BASE_REPOSITORY}@{ACE_BASE_REVISION}"
            if provider == "ACE_STEP" else source.revision
        ),
        "size": size,
    }