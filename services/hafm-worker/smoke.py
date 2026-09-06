"""Run HAFM only after compatibility and retain strict real-audio proof."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import tempfile

import numpy as np
import soundfile as sf

from inference import infer

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSET_ROOT = Path(os.getenv("HAFM_ASSET_ROOT", SPEC["asset_root"]))
SMOKE_ROOT = Path(os.getenv("HAFM_SMOKE_ROOT", "/var/lib/hafm/smoke"))
AUTHORIZATION = json.loads((ROOT / SPEC["fixture_authorization"]).read_text())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audio_metrics(path: Path) -> tuple[dict[str, object], np.ndarray]:
    samples, sample_rate = sf.read(path, always_2d=True, dtype="float32")
    finite = bool(np.isfinite(samples).all())
    if not finite or samples.size == 0:
        raise RuntimeError(f"audio is empty or non-finite: {path.name}")
    mono = samples.mean(axis=1, dtype=np.float64)
    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    metrics = {
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "durationSeconds": samples.shape[0] / sample_rate,
        "sampleRate": sample_rate,
        "channels": samples.shape[1],
        "frames": samples.shape[0],
        "peakAmplitude": peak,
        "rmsAmplitude": rms,
        "allSamplesFinite": finite,
        "nonSilent": peak >= 1e-4 and rms >= 1e-6,
    }
    return metrics, mono


def resample_for_comparison(
    samples: np.ndarray,
    source_rate: int,
    target_rate: int = 8000,
) -> np.ndarray:
    duration = len(samples) / source_rate
    target_length = max(1, int(duration * target_rate))
    source_positions = np.arange(len(samples), dtype=np.float64) / source_rate
    target_positions = np.arange(target_length, dtype=np.float64) / target_rate
    return np.interp(target_positions, source_positions, samples)


def main() -> None:
    SMOKE_ROOT.mkdir(mode=0o750, parents=True, exist_ok=True)
    proof = SMOKE_ROOT / SPEC["smoke_proof"]
    proof.unlink(missing_ok=True)
    compatibility_path = SMOKE_ROOT / SPEC["compatibility_evidence"]
    compatibility = json.loads(compatibility_path.read_text())
    if compatibility.get("compatible") is not True:
        raise RuntimeError(
            "HAFM compatibility evidence is blocked; inference is forbidden"
        )
    source = SMOKE_ROOT / SPEC["smoke_fixture"]
    expected_fixture = AUTHORIZATION["derivedFixture"]
    if (
        AUTHORIZATION.get("authorization", {}).get("confirmed") is not True
        or AUTHORIZATION.get("audioCommittedToGit") is not False
        or not source.is_file()
        or sha256(source) != expected_fixture["sha256"]
    ):
        raise RuntimeError(
            "owner-authorized real vocal fixture identity is required"
        )
    output = SMOKE_ROOT / "real-instrumental.wav"
    output.unlink(missing_ok=True)
    infer(source.read_bytes(), output, ASSET_ROOT)
    input_metrics, input_mono = audio_metrics(source)
    output_metrics, output_mono = audio_metrics(output)
    input_comparison = resample_for_comparison(
        input_mono,
        int(input_metrics["sampleRate"]),
    )
    output_comparison = resample_for_comparison(
        output_mono,
        int(output_metrics["sampleRate"]),
    )
    common = min(len(input_comparison), len(output_comparison))
    left = input_comparison[:common]
    right = output_comparison[:common]
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    correlation = (
        float(np.dot(left, right) / denominator)
        if denominator > 0
        else 1.0
    )
    normalized_difference = float(
        np.mean(np.abs(left - right))
        / max(float(np.sqrt(np.mean(np.square(left)))), 1e-9)
    )
    duration_ratio = (
        float(output_metrics["durationSeconds"])
        / float(input_metrics["durationSeconds"])
    )
    distinct = (
        output_metrics["sha256"] != input_metrics["sha256"]
        and abs(correlation) < 0.995
        and normalized_difference > 0.01
    )
    plausible = (
        output_metrics["allSamplesFinite"] is True
        and output_metrics["nonSilent"] is True
        and 0.5 <= duration_ratio <= 1.2
        and distinct
    )
    if not plausible:
        output.unlink(missing_ok=True)
        raise RuntimeError(
            "HAFM output failed finite, non-silent, duration, or non-copy proof"
        )
    evidence = {
        "schemaVersion": 2,
        "provider": "HAFM",
        "realInference": True,
        "input": input_metrics,
        "output": output_metrics,
        "durationRatio": duration_ratio,
        "correlationToInput": correlation,
        "normalizedDifferenceFromInput": normalized_difference,
        "distinctFromInput": distinct,
        "plausibleAccompaniment": plausible,
        "assetManifestSha256": sha256(
            ASSET_ROOT / SPEC["asset_manifest"]
        ),
        "compatibilityEvidenceSha256": sha256(compatibility_path),
        "fixtureAuthorizationSha256": sha256(
            ROOT / SPEC["fixture_authorization"]
        ),
        "privateAudioCommittedToGit": False,
    }
    serialized = json.dumps(evidence, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        mode="w",
        dir=SMOKE_ROOT,
        prefix=f"{proof.name}.",
        suffix=".tmp",
        delete=False,
    ) as temporary:
        temporary.write(serialized)
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, proof)
    print(json.dumps(evidence, sort_keys=True))


if __name__ == "__main__":
    main()