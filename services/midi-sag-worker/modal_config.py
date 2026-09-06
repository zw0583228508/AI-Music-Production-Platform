"""Isolated private-volume deployment configuration for MIDI-SAG."""
from __future__ import annotations
import hashlib
from pathlib import Path
APP_NAME = "midi-sag-worker"
RUNTIME_SECRET_NAME = "midi-sag-runtime-v1"
MODEL_VOLUME_NAME = "midi-sag-models-private-v1"
SMOKE_VOLUME_NAME = "midi-sag-smoke-private-v1"
MODEL_MOUNT = "/var/lib/midi-sag/models"
SMOKE_MOUNT = "/var/lib/midi-sag/smoke"
WORKER_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next((p for p in (WORKER_ROOT, *WORKER_ROOT.parents) if (p / "pnpm-workspace.yaml").is_file()), WORKER_ROOT)
def worker_environment(online: bool = False) -> dict[str, str]:
    return {"MIDI_SAG_ASSET_ROOT": MODEL_MOUNT, "HF_HOME": f"{MODEL_MOUNT}/hf-cache",
            "HF_HUB_OFFLINE": "0" if online else "1", "TRANSFORMERS_OFFLINE": "0" if online else "1",
            "MIDI_SAG_IMAGE_EVIDENCE": "sha256:" + hashlib.sha256((WORKER_ROOT / "Dockerfile").read_bytes()).hexdigest()}