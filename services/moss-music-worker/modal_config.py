"""Configuration for the private, isolated MOSS-Music worker."""
from __future__ import annotations
import hashlib
import os
from pathlib import Path

APP_NAME = "moss-music-worker"
ENDPOINT_LABEL = "moss-music"
RUNTIME_SECRET_NAME = "music-ai-worker-runtime"
MODEL_VOLUME_NAME = "moss-music-models-private-v1"
SMOKE_VOLUME_NAME = "moss-music-smoke-private-v1"
OUTPUT_VOLUME_NAME = "moss-music-artifacts-private-v1"
MODEL_MOUNT = "/var/lib/moss-music/models"
SMOKE_MOUNT = "/var/lib/moss-music/smoke"
OUTPUT_MOUNT = "/var/lib/moss-music/artifacts"
WORKER_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next((p for p in (WORKER_ROOT, *WORKER_ROOT.parents)
                        if (p / "pnpm-workspace.yaml").is_file()), WORKER_ROOT)

def image_evidence() -> str:
    digest = hashlib.sha256()
    for name in ("Dockerfile", "requirements.txt", "model_manifest.json", "license_manifest.json",
                 "app.py", "bootstrap_assets.py", "compatibility.py", "modal_app.py",
                 "modal_compatibility.py", "modal_config.py", "modal_provision.py",
                 "preflight.py", "smoke.py"):
        digest.update(name.encode() + b"\0" + (WORKER_ROOT / name).read_bytes() + b"\0")
    return "sha256:" + digest.hexdigest()

def worker_environment(*, online: bool = False) -> dict[str, str]:
    env = {"MOSS_MUSIC_ASSET_ROOT": MODEL_MOUNT, "MOSS_MUSIC_SMOKE_ROOT": SMOKE_MOUNT,
           "MOSS_MUSIC_ARTIFACT_ROOT": OUTPUT_MOUNT, "HF_HOME": f"{MODEL_MOUNT}/hf-cache",
           "HF_HUB_OFFLINE": "0" if online else "1", "TRANSFORMERS_OFFLINE": "0" if online else "1",
           "MOSS_MUSIC_IMAGE_EVIDENCE": image_evidence(), "PYTHONUNBUFFERED": "1"}
    return env

def workload_environment(*, online: bool = False) -> dict[str, str]:
    """Environment for the model subprocess, including micromamba FFmpeg 7."""
    env = worker_environment(online=online)
    env["PATH"] = "/opt/moss-ffmpeg/bin:" + os.environ.get("PATH", "")
    inherited_library_path = os.environ.get("LD_LIBRARY_PATH", "")
    env["LD_LIBRARY_PATH"] = "/opt/moss-ffmpeg/lib" + (
        f":{inherited_library_path}" if inherited_library_path else ""
    )
    return env