"""Persist exact real-audio feature evidence without retaining derived audio."""
from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import soundfile as sf

import app as worker


def _result_sha256(result: dict) -> str:
    return hashlib.sha256(
        json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def _evidence(provider: str, result: dict) -> dict:
    if provider == "MADMOM":
        return {
            "beatCount": len(result["beats"]),
            "downbeatCount": len(result["downbeats"]),
            "tempoBpm": result["tempoBpm"],
            "activationFrames": result["activationFrames"],
            "firstBeat": result["beats"][0],
            "lastBeat": result["beats"][-1],
        }
    if provider == "TORCHCREPE":
        voiced = [frame for frame in result["frames"] if frame["voiced"]]
        if not voiced:
            raise RuntimeError("TorchCREPE smoke produced no voiced frames")
        return {
            "model": result["model"],
            "frameCount": len(result["frames"]),
            "voicedFrameCount": len(voiced),
            "minFrequencyHz": min(frame["frequencyHz"] for frame in voiced),
            "maxFrequencyHz": max(frame["frequencyHz"] for frame in voiced),
            "meanPeriodicity": round(
                sum(frame["periodicity"] for frame in result["frames"]) / len(result["frames"]),
                6,
            ),
        }
    if provider == "PYLOUDNORM":
        return {
            "integratedLUFS": result["integratedLUFS"],
            "loudnessRange": result["loudnessRange"],
            "samplePeak": result["samplePeak"],
        }
    if provider == "ESSENTIA":
        return {
            "key": result["key"],
            "scale": result["scale"],
            "confidence": result["confidence"],
            "hpcpBins": len(result["hpcp"]),
            "hpcpFinite": all(np.isfinite(value) for value in result["hpcp"]),
        }
    frames = result["frames"]
    return {
        "frameCount": len(frames),
        "beatCount": len(result["evidence"]["beatTimes"]),
        "librosaChromaFrames": result["evidence"]["librosaChromaFrames"],
        "essentiaHpcpBins": len(result["evidence"]["essentiaHpcp"]),
        "probabilitiesNormalized": all(
            abs(sum(frame["pitchClassProbabilities"]) - 1) < 2e-5 for frame in frames
        ),
        "candidateChordFrames": sum(1 for frame in frames if frame["candidateChords"]),
    }


def _evaluation_audio(source: np.ndarray, rate: int) -> tuple[bytes, np.ndarray]:
    duration = float(os.getenv("MIR_SMOKE_DURATION_SECONDS", "15"))
    frames = min(len(source), int(rate * duration))
    if frames < rate * 10:
        raise RuntimeError("real smoke fixture must provide at least ten seconds of audio")
    buffer = io.BytesIO()
    sf.write(buffer, source[:frames], rate, format="WAV", subtype="PCM_16")
    encoded = buffer.getvalue()
    decoded, decoded_rate = sf.read(io.BytesIO(encoded), always_2d=True, dtype="float32")
    if decoded_rate != rate:
        raise RuntimeError("smoke fixture sample rate changed during deterministic encoding")
    return encoded, np.mean(decoded, axis=1)


def run() -> dict:
    source_path = Path(os.environ["MIR_SMOKE_AUDIO_PATH"]).resolve()
    source_bytes = source_path.read_bytes()
    source_info = sf.info(source_path)
    source, rate = sf.read(source_path, always_2d=True, dtype="float32")
    source = np.mean(source, axis=1)
    if (
        not source_bytes
        or source_info.duration < 10
        or not np.isfinite(source).all()
        or not np.any(np.abs(source) > 1e-7)
    ):
        raise RuntimeError("real smoke fixture is invalid")
    evaluation_bytes, evaluation = _evaluation_audio(source, rate)
    source_fixture = {
        "basename": source_path.name,
        "sha256": hashlib.sha256(source_bytes).hexdigest(),
        "bytes": len(source_bytes),
        "durationSeconds": round(float(source_info.duration), 6),
        "sampleRate": source_info.samplerate,
        "channels": source_info.channels,
        "retained": True,
    }
    evaluation_fixture = {
        "kind": "temporary deterministic PCM_16 derivative",
        "sha256": hashlib.sha256(evaluation_bytes).hexdigest(),
        "bytes": len(evaluation_bytes),
        "durationSeconds": round(len(evaluation) / rate, 6),
        "sampleRate": rate,
        "channels": 1,
        "retained": False,
    }
    worker.READINESS_ROOT.mkdir(parents=True, exist_ok=True)
    report = {
        "schemaVersion": 2,
        "sourceFixtureSha256": source_fixture["sha256"],
        "evaluationFixtureSha256": evaluation_fixture["sha256"],
        "providers": {},
    }
    for provider in worker.PROVIDERS:
        identity_ready, reason = worker._identity_ready(provider)
        if not identity_ready:
            raise RuntimeError(f"{provider} identity is not ready: {reason}")
        with tempfile.TemporaryDirectory(prefix=f"mir-smoke-{provider.lower()}-") as temporary:
            result = worker._execute_provider(provider, evaluation, rate, Path(temporary))
        evidence = _evidence(provider, result)
        if not worker._smoke_evidence_valid(provider, evidence):
            raise RuntimeError(f"{provider} real-output evidence is invalid")
        record = worker.MANIFEST["providers"][provider]
        marker = {
            "schemaVersion": 2,
            "provider": provider,
            "modelVersion": record["modelVersion"],
            "identitySha256": worker._provider_identity_sha256(provider),
            "workerSourceTreeSha256": worker._worker_source_tree_sha256(),
            "packageTrees": {
                package: worker._distribution_tree(package)
                for package in record["installedPackageTrees"]
            },
            "runtime": record["runtime"],
            "sourceFixture": source_fixture,
            "evaluationFixture": evaluation_fixture,
            "featureExecutionSucceeded": True,
            "resultSha256": _result_sha256(result),
            "evidence": evidence,
            "completedAt": datetime.now(timezone.utc).isoformat(),
        }
        target = worker.READINESS_ROOT / f"{provider.lower()}.json"
        temporary_target = target.with_suffix(".json.tmp")
        temporary_target.write_text(
            json.dumps(marker, sort_keys=True, separators=(",", ":"), allow_nan=False),
            encoding="utf-8",
        )
        temporary_target.replace(target)
        report["providers"][provider] = {
            "modelVersion": record["modelVersion"],
            "identitySha256": marker["identitySha256"],
            "resultSha256": marker["resultSha256"],
            "evidence": evidence,
            "markerSha256": worker._canonical_sha256(marker),
        }
    return report


if __name__ == "__main__":
    print(json.dumps(run(), sort_keys=True, allow_nan=False))