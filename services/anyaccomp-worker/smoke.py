"""Run a retained, real AnyAccomp VQ -> flow-matching -> vocoder smoke."""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from inference import run

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("ANYACCOMP_ASSET_ROOT", SPEC["asset_root"]))


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def audio_evidence(path: Path) -> tuple[dict, np.ndarray]:
    audio, sample_rate = sf.read(path, always_2d=True)
    if not np.isfinite(audio).all():
        raise RuntimeError("AnyAccomp audio contains non-finite samples")
    mono = audio.mean(axis=1)
    descriptor = {
        "bytes": path.stat().st_size,
        "sha256": digest(path),
        "sampleRate": sample_rate,
        "channels": audio.shape[1],
        "durationSeconds": len(audio) / sample_rate,
        "peakAmplitude": float(np.max(np.abs(audio))),
        "rmsAmplitude": float(np.sqrt(np.mean(audio**2))),
        "finiteSamples": True,
    }
    return descriptor, mono


def main(vocal: Path | None = None) -> dict:
    inventory_path = ASSETS / SPEC["asset_manifest"]
    if not inventory_path.is_file():
        raise RuntimeError("AnyAccomp reviewed asset inventory is unavailable")
    inventory = json.loads(inventory_path.read_text())
    fixture_auth_path = ASSETS / "fixtures/fixture-authorization.json"
    authorization = json.loads(fixture_auth_path.read_text())
    vocal = vocal or ASSETS / "fixtures/authorized-procedural-vocal.wav"
    if (
        digest(vocal) != authorization["sha256"]
        or authorization["authorizationScope"]
        != "private AnyAccomp validation and regression testing only"
    ):
        raise RuntimeError("AnyAccomp smoke fixture authorization mismatch")

    output = ASSETS / "smoke-output.wav"
    run(vocal, output, "not used by the released model", ASSETS)
    source_evidence, source = audio_evidence(vocal)
    output_evidence, rendered = audio_evidence(output)
    aligned = min(len(source), len(rendered))
    if aligned <= 0:
        raise RuntimeError("AnyAccomp rendered no samples")
    correlation = float(np.corrcoef(source[:aligned], rendered[:aligned])[0, 1])
    normalized_difference = float(
        np.sqrt(np.mean((source[:aligned] - rendered[:aligned]) ** 2))
        / max(float(np.sqrt(np.mean(source[:aligned] ** 2))), 1e-9)
    )
    duration_delta = abs(
        source_evidence["durationSeconds"] - output_evidence["durationSeconds"]
    )
    if (
        output_evidence["peakAmplitude"] < 1e-5
        or output_evidence["rmsAmplitude"] < 1e-7
        or not math.isfinite(correlation)
        or abs(correlation) > 0.995
        or normalized_difference < 0.05
        or duration_delta > 0.05
        or output_evidence["sha256"] == source_evidence["sha256"]
    ):
        raise RuntimeError("AnyAccomp output failed non-silence/non-copy validation")

    import accelerate
    import torch
    import torchaudio
    import torchvision
    import transformers

    proof = {
        "schemaVersion": 2,
        "provider": SPEC["provider"],
        "modelVersion": SPEC["model_version"],
        "checkpointSha256": inventory["weights"]["treeSha256"],
        "checkpointRevision": SPEC["weights"]["revision"],
        "sourceRevision": SPEC["source"]["revision"],
        "sourceGitTree": SPEC["source"]["git_tree"],
        "licenseEvidenceSha256": inventory["licenseEvidenceSha256"],
        "smokeTested": True,
        "inferencePath": "Sing2SongInferencePipeline.encode_vocal -> reverse_diffusion -> _generate_audio",
        "conditioning": "24 kHz mono vocal-like waveform; text prompt is not used upstream",
        "runtime": {
            "pythonVersion": ".".join(map(str, sys.version_info[:3])),
            "torchVersion": torch.__version__,
            "torchaudioVersion": torchaudio.__version__,
            "torchvisionVersion": torchvision.__version__,
            "transformersVersion": transformers.__version__,
            "accelerateVersion": accelerate.__version__,
            "cudaVersion": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0),
            "cudaAvailable": torch.cuda.is_available(),
        },
        "input": {**source_evidence, "authorization": authorization},
        "output": {
            **output_evidence,
            "retainedPrivateVolumePath": "smoke-output.wav",
            "inputCorrelation": correlation,
            "normalizedDifference": normalized_difference,
            "durationDeltaSeconds": duration_delta,
            "notCopy": True,
        },
    }
    (ASSETS / SPEC["smoke_proof"]).write_text(
        json.dumps(proof, indent=2, sort_keys=True)
    )
    return proof


if __name__ == "__main__":
    print(json.dumps(main(), sort_keys=True))