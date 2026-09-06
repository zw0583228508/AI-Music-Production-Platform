"""Explicit HAFM provisioning and smoke operations, both fail-closed."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = (
    Path("/app")
    if Path("/app/modal_config.py").is_file()
    else Path(__file__).resolve().parent
)
sys.path.insert(0, str(ROOT))

import modal

from modal_config import (
    APP_NAME,
    MODEL_MOUNT,
    MODEL_VOLUME_NAME,
    REPOSITORY_ROOT,
    RUNTIME_SECRET_NAME,
    SMOKE_MOUNT,
    SMOKE_VOLUME_NAME,
    WORKER_ROOT,
    worker_environment,
)

app = modal.App(APP_NAME)
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile",
    context_dir=REPOSITORY_ROOT,
)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)
smoke_volume = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=True)


def run_checked(command: list[str], *, online: bool = False) -> None:
    subprocess.run(
        command,
        env={**os.environ, **worker_environment(online=online)},
        check=True,
    )


@app.function(
    image=image,
    gpu="L40S",
    secrets=[modal.Secret.from_name(RUNTIME_SECRET_NAME)],
    volumes={MODEL_MOUNT: model_volume},
    env=worker_environment(online=True),
    timeout=7200,
)
def provision() -> dict[str, object]:
    run_checked(
        ["/opt/hafm-venv/bin/python", "/app/bootstrap_assets.py"],
        online=True,
    )
    model_volume.commit()
    run_checked(
        [
            "/opt/hafm-venv/bin/python",
            "/app/compatibility.py",
            "--source-only",
        ],
        online=True,
    )
    manifest = json.loads(
        Path(MODEL_MOUNT, "model-assets.json").read_text()
    )
    return {
        "provider": "HAFM",
        "status": "provisioned-not-ready",
        "ready": False,
        "smokeTested": False,
        "modelVersion": manifest["model"]["revision"],
        "checkpointSha256": manifest["treeSha256"],
    }


@app.function(
    image=image,
    gpu="L40S",
    secrets=[modal.Secret.from_name(RUNTIME_SECRET_NAME)],
    volumes={
        MODEL_MOUNT: model_volume,
        SMOKE_MOUNT: smoke_volume,
    },
    env=worker_environment(),
    timeout=7200,
)
def run_real_vocal_smoke() -> dict[str, object]:
    run_checked(
        ["/opt/hafm-venv/bin/python", "/app/compatibility.py"]
    )
    smoke_volume.commit()
    run_checked(["/opt/hafm-venv/bin/python", "/app/smoke.py"])
    smoke_volume.commit()
    return json.loads(Path(SMOKE_MOUNT, "smoke-proof.json").read_text())