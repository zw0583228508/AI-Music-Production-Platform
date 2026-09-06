"""Run the production MT3 smoke command in an isolated Modal L4 function."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
from pathlib import Path

import modal

from modal_config import (
    DEPLOYMENTS,
    MODEL_MOUNT,
    MT3_MODEL_VOLUME_NAME,
    provider_image_build_args,
    worker_environment,
)


APP_NAME = "music-ai-mt3-smoke"
WORKER_ROOT = Path(__file__).resolve().parent
DEPLOYMENT = DEPLOYMENTS["MT3"]
EXPECTED_ENVIRONMENT = worker_environment(DEPLOYMENT)
EXPECTED_BUILD_ARGUMENTS = provider_image_build_args(DEPLOYMENT)
EXPECTED_CHECKPOINT_SHA256 = EXPECTED_ENVIRONMENT[
    "MUSIC_PROVIDER_MT3_CHECKPOINT_SHA256"
]
EXPECTED_CONTAINER_DIGEST = EXPECTED_BUILD_ARGUMENTS["SOURCE_IMAGE_DIGEST"]
_configured_source_revision = os.getenv(
    "MUSIC_PROVIDER_MT3_SOURCE_REVISION", ""
).strip()
if re.fullmatch(r"[a-f0-9]{40}", _configured_source_revision):
    EXPECTED_BUILD_ARGUMENTS["SOURCE_REVISION"] = _configured_source_revision
EXPECTED_SOURCE_REVISION = EXPECTED_BUILD_ARGUMENTS["SOURCE_REVISION"]
EXPECTED_ADAPTER_REVISION = (
    "openmirlab/mt3-infer@280a95817a67da0ae46987ddbb18c946963afffe"
)
EXPECTED_CONVERSION_REVISION = (
    "kunato/mt3-pytorch@03a06ef7f288f64e7cd25f17c3f37bcf9fe111bc"
    "#tools/convert_weight.py"
)
app = modal.App(APP_NAME)
if Path("/app/runners/mt3.py").is_file():
    # Modal re-imports this module in the already-built container. The image
    # attached by the local definition is authoritative; this placeholder is
    # never built or used to execute the hydrated function.
    image = modal.Image.from_registry(DEPLOYMENT.cuda_image)
else:
    repository_root = next(
        (
            candidate
            for candidate in (WORKER_ROOT, *WORKER_ROOT.parents)
            if (candidate / "pnpm-workspace.yaml").is_file()
        ),
        WORKER_ROOT,
    )
    image = modal.Image.from_dockerfile(
        WORKER_ROOT / "Dockerfile.mt3",
        context_dir=repository_root,
        build_args=EXPECTED_BUILD_ARGUMENTS,
    )
model_volume = modal.Volume.from_name(MT3_MODEL_VOLUME_NAME, create_if_missing=False)


def _valid_note_evidence(output: object) -> bool:
    if not isinstance(output, dict):
        return False
    events = output.get("noteEvents")
    if (
        not isinstance(events, list)
        or not 1 <= len(events) <= 4096
        or output.get("notes") != len(events)
        or output.get("terminatedNotes") != len(events)
        or output.get("allNotesTerminated") is not True
    ):
        return False
    previous = None
    for event in events:
        if not isinstance(event, dict):
            return False
        start, end = event.get("start"), event.get("end")
        pitch, velocity = event.get("pitch"), event.get("velocity")
        confidence = event.get("confidence")
        if (
            isinstance(start, bool) or not isinstance(start, (int, float))
            or isinstance(end, bool) or not isinstance(end, (int, float))
            or not math.isfinite(start) or not math.isfinite(end)
            or start < 0 or end <= start
            or isinstance(pitch, bool) or not isinstance(pitch, int)
            or not 0 <= pitch <= 127
            or isinstance(velocity, bool) or not isinstance(velocity, int)
            or not 1 <= velocity <= 127
            or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(confidence) or not 0 <= confidence <= 1
        ):
            return False
        ordering = (start, end, pitch)
        if previous is not None and ordering < previous:
            return False
        previous = ordering
    encoded = json.dumps(
        events, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode()
    return output.get("noteEventsSha256") == hashlib.sha256(encoded).hexdigest()


def validate_smoke_proof(
    proof: object,
    *,
    expected_container_digest: str = EXPECTED_CONTAINER_DIGEST,
    expected_source_revision: str = EXPECTED_SOURCE_REVISION,
) -> dict:
    if not isinstance(proof, dict):
        raise RuntimeError("MT3 smoke proof is not an object")
    provenance = proof.get("provenance", {})
    if (
        proof.get("smokeTested") is not True
        or proof.get("provider") != DEPLOYMENT.provider
        or proof.get("modelVersion") != DEPLOYMENT.model_version
        or proof.get("checkpointSha256") != EXPECTED_CHECKPOINT_SHA256
        or proof.get("revision") != DEPLOYMENT.source_revision
        or proof.get("sourceRevision") != EXPECTED_ADAPTER_REVISION
        or proof.get("conversionSourceRevision") != EXPECTED_CONVERSION_REVISION
        or proof.get("checkpointLicense") != "Apache-2.0"
        or proof.get("workerSourceRevision") != expected_source_revision
        or proof.get("sourcePatch")
        != "Dockerfile.mt3:checkpoint-import-relocation"
        or not isinstance(provenance, dict)
        or provenance.get("device") != "cuda"
        or provenance.get("gpu") != "NVIDIA L4"
        or provenance.get("imageId") != provenance.get("modalImageId")
        or provenance.get("sourceImageDigest") != expected_container_digest
        or provenance.get("containerDigest") != expected_container_digest
        or proof.get("smokeFixture")
        != {
            "id": "structured-click-track-32s",
            "durationSeconds": 32,
            "nonSilent": True,
        }
        or not _valid_note_evidence(proof.get("output"))
    ):
        raise RuntimeError("MT3 smoke proof did not match the reviewed deployment")
    return proof


@app.function(
    image=image,
    gpu="L4",
    volumes={MODEL_MOUNT: model_volume},
    timeout=DEPLOYMENT.timeout_seconds,
    env=EXPECTED_ENVIRONMENT,
)
def smoke() -> dict:
    checkpoint = Path(MODEL_MOUNT) / DEPLOYMENT.checkpoint_path
    process = subprocess.run(
        [
            "python",
            "-m",
            "runners.mt3",
            "--smoke",
            "--provider",
            DEPLOYMENT.provider,
            "--model-version",
            DEPLOYMENT.model_version,
            "--checkpoint",
            str(checkpoint),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=DEPLOYMENT.timeout_seconds,
    )
    if process.returncode:
        raise RuntimeError(
            f"MT3 smoke runner exited {process.returncode}: {process.stderr[-2048:]}"
        )
    lines = [line for line in process.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("MT3 smoke runner returned no JSON proof")
    proof = json.loads(lines[-1])
    proof["smokeFixture"] = {
        "id": "structured-click-track-32s",
        "durationSeconds": 32,
        "nonSilent": True,
    }
    proof["workerSourceRevision"] = os.getenv("MUSIC_GPU_SOURCE_REVISION", "")
    validate_smoke_proof(proof)
    print(json.dumps(proof, sort_keys=True))
    return proof


@app.local_entrypoint()
def main() -> None:
    print(smoke.remote())