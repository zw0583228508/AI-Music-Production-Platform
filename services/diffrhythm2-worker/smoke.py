"""Provisioning-only real inference proof; no synthetic audio is accepted."""
from __future__ import annotations
import hashlib, json, os
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import correlate, correlation_lags, resample_poly
from app import ASSETS, SPEC, sha
from inference import infer

def describe(path: Path) -> dict:
    audio, sample_rate = sf.read(str(path), always_2d=True)
    return {
        "path": path.name, "bytes": path.stat().st_size, "sha256": sha(path),
        "durationSeconds": len(audio) / sample_rate, "sampleRate": sample_rate,
        "channels": audio.shape[1], "peakAmplitude": float(abs(audio).max()),
        "rmsAmplitude": float((audio ** 2).mean() ** .5),
    }

COMPARISON_SAMPLE_RATE = 8000
MAX_OFFSET_SECONDS = 5.0
MIN_OVERLAP_SECONDS = 1.0
COPY_LIKE_CORRELATION_THRESHOLD = 0.95
COPY_LIKE_DIFFERENCE_THRESHOLD = 0.25

def _resample(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return audio
    divisor = int(np.gcd(source_rate, target_rate))
    return resample_poly(audio, target_rate // divisor, source_rate // divisor)

def _window_sum(prefix: np.ndarray, start: np.ndarray, length: np.ndarray) -> np.ndarray:
    return prefix[start + length] - prefix[start]

def signal_comparison(source_path: Path, output_path: Path) -> dict:
    source, source_rate = sf.read(str(source_path), always_2d=True)
    output, output_rate = sf.read(str(output_path), always_2d=True)
    source = _resample(source.mean(axis=1), source_rate, COMPARISON_SAMPLE_RATE)
    output = _resample(output.mean(axis=1), output_rate, COMPARISON_SAMPLE_RATE)
    minimum_overlap = max(
        int(MIN_OVERLAP_SECONDS * COMPARISON_SAMPLE_RATE),
        min(len(source), len(output)) // 2,
    )
    if min(len(source), len(output)) < minimum_overlap:
        raise RuntimeError("smoke comparison requires at least one second of audio")
    max_offset_samples = int(MAX_OFFSET_SECONDS * COMPARISON_SAMPLE_RATE)
    lags = correlation_lags(len(output), len(source), mode="full")
    dot_products = correlate(output, source, mode="full", method="fft")
    selected = np.flatnonzero(
        (lags >= -max_offset_samples) & (lags <= max_offset_samples)
    )
    candidate_lags = lags[selected]
    source_starts = np.maximum(-candidate_lags, 0)
    output_starts = np.maximum(candidate_lags, 0)
    overlaps = np.minimum(
        len(source) - source_starts,
        len(output) - output_starts,
    )
    valid = overlaps >= minimum_overlap
    candidate_lags = candidate_lags[valid]
    source_starts = source_starts[valid]
    output_starts = output_starts[valid]
    overlaps = overlaps[valid]
    dots = dot_products[selected][valid]
    if not len(candidate_lags):
        raise RuntimeError("smoke comparison has no sufficiently long overlap")

    source_sum = np.concatenate(([0.0], np.cumsum(source, dtype=np.float64)))
    output_sum = np.concatenate(([0.0], np.cumsum(output, dtype=np.float64)))
    source_square_sum = np.concatenate(
        ([0.0], np.cumsum(source * source, dtype=np.float64))
    )
    output_square_sum = np.concatenate(
        ([0.0], np.cumsum(output * output, dtype=np.float64))
    )
    source_sums = _window_sum(source_sum, source_starts, overlaps)
    output_sums = _window_sum(output_sum, output_starts, overlaps)
    covariance = dots - source_sums * output_sums / overlaps
    source_energy = (
        _window_sum(source_square_sum, source_starts, overlaps)
        - source_sums * source_sums / overlaps
    )
    output_energy = (
        _window_sum(output_square_sum, output_starts, overlaps)
        - output_sums * output_sums / overlaps
    )
    denominators = np.sqrt(np.maximum(source_energy * output_energy, 0.0))
    if float(np.max(denominators)) <= 1e-8:
        raise RuntimeError("smoke comparison rejects silent source or output")
    correlations = np.divide(
        covariance,
        denominators,
        out=np.zeros_like(covariance),
        where=denominators > 1e-8,
    )
    strongest_index = int(np.argmax(np.abs(correlations)))
    strongest_correlation = float(correlations[strongest_index])
    absolute_correlation = abs(strongest_correlation)
    normalized_difference = float(np.sqrt(max(0.0, 1.0 - absolute_correlation)))
    strongest_lag = int(candidate_lags[strongest_index])
    compared_samples = int(overlaps[strongest_index])
    passes = (
        absolute_correlation < COPY_LIKE_CORRELATION_THRESHOLD
        and normalized_difference > COPY_LIKE_DIFFERENCE_THRESHOLD
    )
    return {
        "method": "bounded-offset-normalized-cross-correlation-v2",
        "sourceSampleRate": source_rate,
        "outputSampleRate": output_rate,
        "comparisonSampleRate": COMPARISON_SAMPLE_RATE,
        "maxOffsetSeconds": MAX_OFFSET_SECONDS,
        "minimumOverlapSeconds": MIN_OVERLAP_SECONDS,
        "searchedLagCount": int(len(candidate_lags)),
        "strongestOffsetSamples": strongest_lag,
        "strongestOffsetSeconds": strongest_lag / COMPARISON_SAMPLE_RATE,
        "comparedSamples": compared_samples,
        "comparedSeconds": compared_samples / COMPARISON_SAMPLE_RATE,
        "strongestWaveformCorrelation": strongest_correlation,
        "absoluteWaveformCorrelation": absolute_correlation,
        "polarityInvariantNormalizedDifference": normalized_difference,
        "copyLikeCorrelationThreshold": COPY_LIKE_CORRELATION_THRESHOLD,
        "copyLikeDifferenceThreshold": COPY_LIKE_DIFFERENCE_THRESHOLD,
        "passesNotSourceCopy": passes,
    }

def main(fixture: Path) -> dict:
    if not fixture.is_file(): raise RuntimeError("a real rhythm fixture is required")
    duration=float(os.getenv("DIFFRHYTHM2_SMOKE_DURATION","12"))
    label=os.getenv("DIFFRHYTHM2_SMOKE_LABEL","known-good-short")
    output=ASSETS/f"{label}-output.mp3"
    diagnostic=ASSETS/f"{label}-diagnostic.json"
    infer(lyrics="[verse]\nA real voice follows the pulse\n[chorus]\nRhythm makes the song move",
           rhythm_wav=fixture.read_bytes(),output=output,style_prompt="acoustic pop",
           duration=duration,steps=16,guidance=2,diagnostic=diagnostic)
    audio,_=sf.read(str(output)); rms=float((audio**2).mean()**.5) if len(audio) else 0
    copied=hashlib.sha256(fixture.read_bytes()).hexdigest()==sha(output)
    comparison=signal_comparison(fixture,output)
    if rms <= 1e-5 or copied or not comparison["passesNotSourceCopy"]:
        raise RuntimeError("smoke rejected silent or copied source output")
    proof={"provider":"DIFFRHYTHM_2","label":label,"realInference":True,"lyricsConditioned":True,"rhythmConditioned":True,
           "nonSilent":True,"notSourceCopy":True,"rms":rms,"artifactSha256":sha(output),
           "sourceSha256":sha(fixture),"assetManifestSha256":sha(ASSETS/SPEC["asset_manifest"]),
           "input":describe(fixture),"output":describe(output),
            "signalComparison":comparison,
           "runtimeDiagnostic":json.loads(diagnostic.read_text())}
    (ASSETS/SPEC["smoke_proof"]).write_text(json.dumps(proof,indent=2,sort_keys=True))
    return proof
if __name__=="__main__": main(Path(os.environ["DIFFRHYTHM2_SMOKE_AUDIO"]))
