"""Explicit Modal provisioning and smoke operations; never deployment startup."""
from __future__ import annotations

import os
import json
import subprocess
import sys
from pathlib import Path

_ROOT = Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT))

import modal

from modal_config import (APP_NAME, LICENSE_SECRET_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME, REPOSITORY_ROOT,
                          RUNTIME_SECRET_NAME, SMOKE_MOUNT, SMOKE_VOLUME_NAME, WORKER_ROOT, worker_environment,
                          workload_environment)

app = modal.App(f"{APP_NAME}-provision")
image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)
smoke_volume = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=True)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
license_secret = modal.Secret.from_name(LICENSE_SECRET_NAME)


def _workload_json(action: str, *, fixture: Path | None = None,
                   online: bool = False) -> dict:
    """Run the isolated Python 3.9 workload without a shell or imports here."""
    environment = {**os.environ, **workload_environment(online=online), "MUSICGEN_WORKLOAD_ACTION": action}
    if fixture is not None:
        environment["MUSICGEN_SMOKE_AUDIO"] = str(fixture)
    result = subprocess.run(
        ["/opt/musicgen-venv/bin/python", "/app/workload_entrypoint.py"],
        cwd="/app", env=environment, capture_output=True, text=True, timeout=86_000, check=False,
    )
    if result.returncode:
        detail = "\n".join(result.stderr.strip().splitlines()[-20:])
        raise RuntimeError(f"MusicGen Python 3.9 workload failed:\n{detail}")
    if len(result.stdout.encode("utf-8")) > 65_536:
        raise RuntimeError("MusicGen workload proof exceeds the JSON boundary")
    try:
        value = json.loads(result.stdout.strip().splitlines()[-1])
    except json.JSONDecodeError as exc:
        raise RuntimeError("MusicGen workload did not return JSON proof") from exc
    if not isinstance(value, dict):
        raise RuntimeError("MusicGen workload proof is invalid")
    return value


@app.function(image=image, gpu="L40S", secrets=[runtime_secret, license_secret],
              volumes={MODEL_MOUNT: model_volume, SMOKE_MOUNT: smoke_volume},
              env=worker_environment(), timeout=24 * 60 * 60, max_containers=1)
def provision_assets() -> dict:
    try:
        return _workload_json("provision", online=True)
    finally:
        model_volume.commit()


@app.function(image=image, gpu="L40S", secrets=[runtime_secret, license_secret],
              volumes={MODEL_MOUNT: model_volume, SMOKE_MOUNT: smoke_volume},
              env=worker_environment(), timeout=1_800, max_containers=1)
def smoke_remote(fixture_name: str) -> dict:
    fixture = Path(SMOKE_MOUNT) / Path(fixture_name).name
    if not fixture.is_file():
        raise RuntimeError("uploaded real vocal/melody smoke fixture is required")
    try:
        return _workload_json("smoke", fixture=fixture)
    finally:
        model_volume.commit()


@app.local_entrypoint()
def main(action: str = "provision", fixture: str = "") -> None:
    if action == "provision":
        print(provision_assets.remote())
    elif action == "smoke":
        if not fixture:
            raise ValueError("fixture must name an uploaded smoke-volume file")
        print(smoke_remote.remote(fixture))
    else:
        raise ValueError("action must be provision or smoke")