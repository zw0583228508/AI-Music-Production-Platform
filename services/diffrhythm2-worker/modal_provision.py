"""Explicit operator-invoked provisioning only; endpoint startup never downloads."""
from __future__ import annotations

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
    environment,
)

app = modal.App(f"{APP_NAME}-provision")
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT
)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)
smoke = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=True)
secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
smoke_image = image.add_local_file(
    REPOSITORY_ROOT / "attached_assets/0_שמוליק_סוכות_-_הילד_הזה_1788660426522.mp3",
    remote_path="/smoke/golden.mp3",
    copy=True,
)


@app.function(
    image=image,
    gpu="L40S",
    secrets=[secret],
    volumes={MODEL_MOUNT: models, SMOKE_MOUNT: smoke},
    timeout=86400,
)
def provision_assets():
    import os
    import subprocess

    try:
        subprocess.run(
            ["/opt/diffrhythm2-venv/bin/python", "bootstrap_assets.py"],
            cwd="/app",
            env={**os.environ, **environment(True)},
            check=True,
        )
    finally:
        models.commit()


def run_smoke(label: str, duration: float):
    import json
    import os
    import subprocess
    from pathlib import Path

    fixture = "/var/lib/diffrhythm2/smoke/golden-30s.wav"
    subprocess.run(
        [
            "ffmpeg", "-nostdin", "-y", "-ss", "30", "-t", "30",
            "-i", "/smoke/golden.mp3", "-ac", "1", "-ar", "44100",
            "-c:a", "pcm_s16le", fixture,
        ],
        check=True,
        capture_output=True,
    )
    try:
        completed = subprocess.run(
            ["/opt/diffrhythm2-venv/bin/python", "smoke.py"],
            cwd="/app",
            env={
                **os.environ,
                **environment(False),
                "DIFFRHYTHM2_SMOKE_AUDIO": fixture,
                "DIFFRHYTHM2_SMOKE_LABEL": label,
                "DIFFRHYTHM2_SMOKE_DURATION": str(duration),
            },
            capture_output=True,
            text=True,
        )
        if completed.returncode:
            diagnostic = " ".join(
                (completed.stdout + " " + completed.stderr).split()
            )[-12000:]
            raise RuntimeError(f"DiffRhythm 2 real smoke failed: {diagnostic}")
        return json.loads((Path(MODEL_MOUNT) / "smoke-proof.json").read_text())
    finally:
        models.commit()
        smoke.commit()


@app.function(
    image=smoke_image,
    gpu="L40S",
    secrets=[secret],
    volumes={MODEL_MOUNT: models, SMOKE_MOUNT: smoke},
    timeout=3600,
)
def smoke_real_audio():
    return run_smoke("known-good-short", 12)


@app.function(
    image=smoke_image,
    gpu="L40S",
    secrets=[secret],
    volumes={MODEL_MOUNT: models, SMOKE_MOUNT: smoke},
    timeout=3600,
)
def smoke_full_fixture():
    return run_smoke("full-fixture", 30)