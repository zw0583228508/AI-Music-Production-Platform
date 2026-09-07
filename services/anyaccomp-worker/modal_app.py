"""Dedicated AnyAccomp provisioning, smoke and bearer-only endpoint."""
from __future__ import annotations

import os
import json
import subprocess
import sys
from pathlib import Path

import modal

APP_NAME = "anyaccomp-worker"
ENDPOINT_LABEL = "anyaccomp"
MODEL_VOLUME_NAME = "anyaccomp-models-private-v1"
ARTIFACT_VOLUME_NAME = "anyaccomp-artifacts-private-v1"
MODEL_MOUNT = "/var/lib/anyaccomp/models"
ARTIFACT_MOUNT = "/var/lib/anyaccomp/artifacts"
RUNTIME_SECRET_NAME = "anyaccomp-runtime-v1"
PROMOTION_SECRET_NAME = "anyaccomp-promotion-identity-v1"
WORKER_ROOT = Path(__file__).resolve().parent
PINNED_PYTHON = "/opt/anyaccomp-venv/bin/python"

app = modal.App(APP_NAME)
SOURCE_IMAGE_DIGEST = "sha256:73ea0220b42826b7603162855ab2b6fdf5695a8b265403aa38462ae206690fd3"
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile",
    context_dir=WORKER_ROOT.parent.parent,
    build_args={"SOURCE_IMAGE_DIGEST": SOURCE_IMAGE_DIGEST},
)
provision_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install("huggingface-hub==0.34.4")
    .add_local_dir(WORKER_ROOT, remote_path="/app")
)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
artifacts = modal.Volume.from_name(ARTIFACT_VOLUME_NAME, create_if_missing=False)
secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
promotion_secret = modal.Secret.from_name(PROMOTION_SECRET_NAME)


@app.function(
    image=provision_image,
    volumes={MODEL_MOUNT: models},
    timeout=7200,
)
def provision_assets() -> dict:
    os.environ["ANYACCOMP_ASSET_ROOT"] = MODEL_MOUNT
    sys.path.insert(0, "/app")
    from bootstrap_assets import main

    result = main()
    models.commit()
    return result


@app.function(
    image=image,
    gpu="L40S",
    volumes={MODEL_MOUNT: models},
    timeout=1800,
)
def smoke_fixture(fixture_path: str) -> dict:
    expected_fixture = (
        f"{MODEL_MOUNT}/fixtures/authorized-procedural-vocal.wav"
    )
    if fixture_path != expected_fixture:
        raise RuntimeError("AnyAccomp smoke fixture path is not authorized")
    environment = {**os.environ, "ANYACCOMP_ASSET_ROOT": MODEL_MOUNT}
    subprocess.run(
        [
            PINNED_PYTHON,
            "-c",
            (
                "from pathlib import Path; "
                "from smoke import main; "
                f"main(Path({fixture_path!r}))"
            ),
        ],
        cwd="/app",
        env=environment,
        check=True,
    )
    result = json.loads(
        Path(f"{MODEL_MOUNT}/smoke-proof.json").read_text()
    )
    models.commit()
    return result


@app.function(
    image=image,
    gpu="L40S",
    volumes={MODEL_MOUNT: models},
    timeout=900,
)
def runtime_identity() -> dict:
    script = """
import accelerate, json, sys, torch, torchaudio, torchvision, transformers
print(json.dumps({
    "pythonVersion": ".".join(map(str, sys.version_info[:3])),
    "torchVersion": torch.__version__,
    "torchaudioVersion": torchaudio.__version__,
    "torchvisionVersion": torchvision.__version__,
    "transformersVersion": transformers.__version__,
    "accelerateVersion": accelerate.__version__,
    "cudaAvailable": torch.cuda.is_available(),
    "cudaVersion": torch.version.cuda,
    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
}, sort_keys=True))
"""
    return json.loads(
        subprocess.check_output(
            [PINNED_PYTHON, "-c", script],
            cwd="/app",
            text=True,
        )
    )


@app.cls(
    image=image,
    gpu="L40S",
    secrets=[secret, promotion_secret],
    volumes={MODEL_MOUNT: models, ARTIFACT_MOUNT: artifacts},
    timeout=1800,
    max_containers=1,
)
class AnyAccompWorker:
    @modal.web_server(port=8000, startup_timeout=600, label=ENDPOINT_LABEL)
    def endpoint(self):
        environment = {
            **os.environ,
            "ANYACCOMP_ASSET_ROOT": MODEL_MOUNT,
            "ANYACCOMP_ARTIFACT_ROOT": ARTIFACT_MOUNT,
        }
        process = subprocess.Popen(
            [
                PINNED_PYTHON,
                "-m",
                "uvicorn",
                "app:app",
                "--host",
                "0.0.0.0",
                "--port",
                "8000",
            ],
            cwd="/app",
            env=environment,
        )
        try:
            code = process.wait()
            if code:
                raise RuntimeError(
                    "AnyAccomp pinned Python web workload exited unexpectedly"
                )
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=30)