"""Recompute retained source-copy evidence without exposing the private fixture."""
from __future__ import annotations

import modal

from modal_config import (
    APP_NAME,
    DEPLOYMENT_BASE_IMAGE_ID,
    MODEL_MOUNT,
    MODEL_VOLUME_NAME,
    SMOKE_MOUNT,
    SMOKE_VOLUME_NAME,
    WORKER_ROOT,
    environment,
)

app = modal.App(f"{APP_NAME}-comparison")
image = (
    modal.Image.from_id(DEPLOYMENT_BASE_IMAGE_ID)
    .add_local_file(
        WORKER_ROOT / "modal_compare.py",
        remote_path="/app/modal_compare.py",
        copy=True,
    )
    .add_local_file(
        WORKER_ROOT / "modal_config.py",
        remote_path="/app/modal_config.py",
        copy=True,
    )
    .add_local_file(WORKER_ROOT / "smoke.py", remote_path="/app/smoke.py", copy=True)
    .add_local_file(
        WORKER_ROOT / "release-evidence/known-good-short-smoke-proof.json",
        remote_path="/app/known-good-short-smoke-proof.json",
        copy=True,
    )
    .add_local_file(
        WORKER_ROOT / "release-evidence/full-fixture-smoke-proof.json",
        remote_path="/app/full-fixture-smoke-proof.json",
        copy=True,
    )
    .env({
        **environment(False),
        "PYTHONPATH": "/opt/diffrhythm2-venv/lib/python3.11/site-packages",
    })
)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
smoke = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=False)


@app.function(
    image=image,
    volumes={MODEL_MOUNT: models, SMOKE_MOUNT: smoke},
    timeout=600,
)
def refresh_retained_smoke_comparisons():
    import hashlib
    import json
    from pathlib import Path

    from smoke import signal_comparison

    fixture = Path(SMOKE_MOUNT) / "golden-30s.wav"
    proofs = {}
    for label in ("known-good-short", "full-fixture"):
        name = f"{label}-smoke-proof.json"
        proof = json.loads((Path("/app") / name).read_text())
        output = Path(MODEL_MOUNT) / f"{label}-output.mp3"
        if (
            hashlib.sha256(fixture.read_bytes()).hexdigest()
            != proof.get("sourceSha256")
            or hashlib.sha256(output.read_bytes()).hexdigest()
            != proof.get("artifactSha256")
        ):
            raise RuntimeError("retained smoke bytes do not match their proof")
        comparison = signal_comparison(fixture, output)
        if not comparison["passesNotSourceCopy"]:
            raise RuntimeError("retained output remains copy-like")
        proof["signalComparison"] = comparison
        (Path(MODEL_MOUNT) / name).write_text(
            json.dumps(proof, indent=2, sort_keys=True)
        )
        if label == "full-fixture":
            (Path(MODEL_MOUNT) / "smoke-proof.json").write_text(
                json.dumps(proof, indent=2, sort_keys=True)
            )
        proofs[label] = proof
    models.commit()
    return proofs


@app.local_entrypoint()
def main():
    refresh_retained_smoke_comparisons.remote()