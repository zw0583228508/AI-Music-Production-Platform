"""Recompute retained source-copy evidence without exposing the private fixture."""
from __future__ import annotations

import modal

from comparison_resources import (
    COMPARISON_CANCELLATION_WORK_SECONDS,
    COMPARISON_CONTAINER_MEMORY_MIB,
    COMPARISON_MAX_CONCURRENT_INPUTS,
)
from modal_config import (
    APP_NAME,
    MODEL_MOUNT,
    MODEL_VOLUME_NAME,
    REPOSITORY_ROOT,
    SMOKE_MOUNT,
    SMOKE_VOLUME_NAME,
    WORKER_ROOT,
    environment,
)

app = modal.App(f"{APP_NAME}-comparison")
image = (
    modal.Image.from_dockerfile(
        WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT
    )
    .add_local_file(
        WORKER_ROOT / "modal_config.py",
        remote_path="/app/modal_config.py",
        copy=True,
    )
    .add_local_file(WORKER_ROOT / "smoke.py", remote_path="/app/smoke.py", copy=True)
    .add_local_file(
        WORKER_ROOT / "contract.py",
        remote_path="/app/contract.py",
        copy=True,
    )
    .add_local_file(
        WORKER_ROOT / "comparison_resources.py",
        remote_path="/app/comparison_resources.py",
        copy=True,
    )
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
    memory=COMPARISON_CONTAINER_MEMORY_MIB,
    max_containers=1,
    timeout=600,
)
@modal.concurrent(max_inputs=COMPARISON_MAX_CONCURRENT_INPUTS)
def drill_retained_smoke_comparison(control: str = "compare", readiness=None):
    import os
    import re
    import time
    from pathlib import Path

    from smoke import signal_comparison

    image_id = os.getenv("MODAL_IMAGE_ID", "")
    if re.fullmatch(r"im-[A-Za-z0-9]+", image_id) is None:
        raise RuntimeError(
            "retained comparison burst request lacks runtime image identity"
        ) from None
    started = time.time()
    if control == "stall":
        if readiness is None:
            raise RuntimeError("comparison stall readiness channel is required") from None
        readiness.put({
            "outcome": "started",
            "startedUnixSeconds": started,
            "modalImageId": image_id,
        })
        time.sleep(120)
    elif control == "cancel_execution":
        if readiness is None:
            raise RuntimeError(
                "comparison cancellation lifecycle channel is required"
            ) from None
        readiness.put({
            "outcome": "pre_work",
            "startedUnixSeconds": started,
            "modalImageId": image_id,
        })
        try:
            comparison = signal_comparison(
                Path(SMOKE_MOUNT) / "golden-30s.wav",
                Path(MODEL_MOUNT) / "full-fixture-output.mp3",
            )
            if not comparison["passesNotSourceCopy"]:
                raise RuntimeError("copy-like result")
        except Exception:
            readiness.put({
                "outcome": "post_work",
                "finishedUnixSeconds": time.time(),
                "modalImageId": image_id,
            })
            raise RuntimeError(
                "controlled comparison failed within the worker resource limit"
            ) from None
        elapsed = time.time() - started
        time.sleep(max(0, COMPARISON_CANCELLATION_WORK_SECONDS - elapsed))
        readiness.put({
            "outcome": "post_work",
            "finishedUnixSeconds": time.time(),
            "modalImageId": image_id,
        })
        return {
            "outcome": "completed",
            "startedUnixSeconds": started,
            "finishedUnixSeconds": time.time(),
            "modalImageId": image_id,
        }
    elif control == "probe":
        return {
            "outcome": "completed",
            "startedUnixSeconds": started,
            "finishedUnixSeconds": time.time(),
            "modalImageId": image_id,
        }
    elif control != "compare":
        raise RuntimeError("unsupported comparison drill control") from None
    try:
        comparison = signal_comparison(
            Path(SMOKE_MOUNT) / "golden-30s.wav",
            Path(MODEL_MOUNT) / "full-fixture-output.mp3",
        )
        if not comparison["passesNotSourceCopy"]:
            raise RuntimeError("copy-like result")
    except Exception:
        raise RuntimeError(
            "retained comparison burst request failed within the worker resource limit"
        ) from None
    return {
        "outcome": "completed",
        "startedUnixSeconds": started,
        "finishedUnixSeconds": time.time(),
        "modalImageId": image_id,
    }


@app.function(
    image=image,
    volumes={MODEL_MOUNT: models, SMOKE_MOUNT: smoke},
    memory=COMPARISON_CONTAINER_MEMORY_MIB,
    timeout=600,
)
@modal.concurrent(max_inputs=COMPARISON_MAX_CONCURRENT_INPUTS)
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
        try:
            comparison = signal_comparison(fixture, output)
        except Exception:
            # Modal queues work above max_inputs. If a queued comparison later
            # fails, keep its error useful to operators without leaking paths,
            # hashes, or audio metadata through an exception chain.
            raise RuntimeError(
                f"retained {label} comparison failed within the worker resource limit"
            ) from None
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
