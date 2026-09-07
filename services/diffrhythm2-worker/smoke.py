"""Provisioning-only real inference proof; no synthetic audio is accepted."""
from __future__ import annotations
import hashlib, json, os
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import correlate, correlation_lags, resample_poly, stft
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
MAX_SUPPORTED_SMOKE_DURATION_SECONDS = 210.0
COPY_LIKE_CORRELATION_THRESHOLD = 0.95
COPY_LIKE_DIFFERENCE_THRESHOLD = 0.25
TEMPO_RATIOS = (0.90, 0.95, 1.0, 1.05, 1.10)
PITCH_SEMITONES = tuple(range(-4, 5))
CHROMA_CORRELATION_THRESHOLD = 0.90
MAX_CHANNEL_PROJECTIONS = 4
MAX_DECODED_CHANNELS = 32

def _read_bounded_audio(path: Path) -> tuple[np.ndarray, int]:
    channel_count = sf.info(str(path)).channels
    if channel_count > MAX_DECODED_CHANNELS:
        raise RuntimeError(
            f"audio channel count {channel_count} exceeds supported maximum "
            f"of {MAX_DECODED_CHANNELS}"
        )
    return sf.read(str(path), always_2d=True)

def _resample(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return audio
    divisor = int(np.gcd(source_rate, target_rate))
    return resample_poly(audio, target_rate // divisor, source_rate // divisor)

def _window_sum(prefix: np.ndarray, start: np.ndarray, length: np.ndarray) -> np.ndarray:
    return prefix[start + length] - prefix[start]

def _strongest_waveform_match(source: np.ndarray, output: np.ndarray) -> dict:
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
    return {
        "correlation": float(correlations[strongest_index]),
        "lag": int(candidate_lags[strongest_index]),
        "overlap": int(overlaps[strongest_index]),
        "searchedLagCount": int(len(candidate_lags)),
    }

def _channel_projections(audio: np.ndarray) -> list[tuple[str, np.ndarray]]:
    channel_count = audio.shape[1]
    if channel_count <= MAX_CHANNEL_PROJECTIONS:
        indices = range(channel_count)
    else:
        energies = np.mean(audio * audio, axis=0, dtype=np.float64)
        indices = sorted(
            range(channel_count),
            key=lambda index: (-float(energies[index]), index),
        )[:MAX_CHANNEL_PROJECTIONS]
    return [(f"channel-{index}", audio[:, index]) for index in indices]

def signal_comparison(source_path: Path, output_path: Path) -> dict:
    source, source_rate = _read_bounded_audio(source_path)
    output, output_rate = _read_bounded_audio(output_path)
    source = _resample(source, source_rate, COMPARISON_SAMPLE_RATE)
    output = _resample(output, output_rate, COMPARISON_SAMPLE_RATE)
    source_mono = source.mean(axis=1)
    output_mono = output.mean(axis=1)
    waveform_matches = []
    source_projections = _channel_projections(source)
    output_projections = _channel_projections(output)
    for tempo_ratio in TEMPO_RATIOS:
        transformed = resample_poly(source_mono, 100, int(round(100 * tempo_ratio)))
        match = _strongest_waveform_match(transformed, output_mono)
        match["tempoRatio"] = tempo_ratio
        match["sourceProjection"] = "mono-fold-down"
        match["outputProjection"] = "mono-fold-down"
        waveform_matches.append(match)
    if source.shape[1] > 1 or output.shape[1] > 1:
        for source_label, source_projection in source_projections:
            for output_label, output_projection in output_projections:
                match = _strongest_waveform_match(source_projection, output_projection)
                match["tempoRatio"] = 1.0
                match["sourceProjection"] = source_label
                match["outputProjection"] = output_label
                waveform_matches.append(match)
    waveform = max(waveform_matches, key=lambda match: abs(match["correlation"]))
    chroma = _strongest_chroma_match(source_mono, output_mono)
    strongest_correlation = waveform["correlation"]
    absolute_correlation = abs(strongest_correlation)
    normalized_difference = float(np.sqrt(max(0.0, 1.0 - absolute_correlation)))
    strongest_lag = waveform["lag"]
    compared_samples = waveform["overlap"]
    passes = (
        absolute_correlation < COPY_LIKE_CORRELATION_THRESHOLD
        and normalized_difference > COPY_LIKE_DIFFERENCE_THRESHOLD
        and chroma["correlation"] < CHROMA_CORRELATION_THRESHOLD
    )
    return {
        "method": "bounded-tempo-pitch-source-similarity-v3",
        "sourceSampleRate": source_rate,
        "outputSampleRate": output_rate,
        "comparisonSampleRate": COMPARISON_SAMPLE_RATE,
        "maxOffsetSeconds": MAX_OFFSET_SECONDS,
        "minimumOverlapSeconds": MIN_OVERLAP_SECONDS,
        "searchedLagCount": waveform["searchedLagCount"],
        "searchedTempoRatios": list(TEMPO_RATIOS),
        "searchedPitchSemitones": list(PITCH_SEMITONES),
        "strongestOffsetSamples": strongest_lag,
        "strongestOffsetSeconds": strongest_lag / COMPARISON_SAMPLE_RATE,
        "comparedSamples": compared_samples,
        "comparedSeconds": compared_samples / COMPARISON_SAMPLE_RATE,
        "strongestWaveformCorrelation": strongest_correlation,
        "absoluteWaveformCorrelation": absolute_correlation,
        "polarityInvariantNormalizedDifference": normalized_difference,
        "copyLikeCorrelationThreshold": COPY_LIKE_CORRELATION_THRESHOLD,
        "copyLikeDifferenceThreshold": COPY_LIKE_DIFFERENCE_THRESHOLD,
        "chromaCorrelationThreshold": CHROMA_CORRELATION_THRESHOLD,
        "strongestTransform": {
            "tempoRatio": chroma["tempoRatio"],
            "pitchSemitones": chroma["pitchSemitones"],
            "offsetSeconds": chroma["offsetSeconds"],
            "similarity": chroma["correlation"],
        },
        "strongestWaveformTempoRatio": waveform["tempoRatio"],
        "sourceProjection": waveform["sourceProjection"],
        "outputProjection": waveform["outputProjection"],
        "comparedProjectionPairs": (
            len(source_projections) * len(output_projections)
            if source.shape[1] > 1 or output.shape[1] > 1
            else 1
        ),
        "channelProjectionPolicy": {
            "maximumPerAudio": MAX_CHANNEL_PROJECTIONS,
            "selection": "all-up-to-limit-otherwise-highest-energy",
            "sourceChannelCount": int(source.shape[1]),
            "outputChannelCount": int(output.shape[1]),
            "sourceProjections": [label for label, _ in source_projections],
            "outputProjections": [label for label, _ in output_projections],
        },
        "searchedTransformCount": chroma["searchedTransformCount"],
        "searchedTransformAlignmentCount": chroma["searchedAlignmentCount"],
        "passesNotSourceCopy": passes,
    }

def main(fixture: Path) -> dict:
    if not fixture.is_file(): raise RuntimeError("a real rhythm fixture is required")
    duration=float(os.getenv("DIFFRHYTHM2_SMOKE_DURATION","12"))
    if not 0 < duration <= MAX_SUPPORTED_SMOKE_DURATION_SECONDS:
        raise RuntimeError(
            f"smoke duration must be between 0 and "
            f"{MAX_SUPPORTED_SMOKE_DURATION_SECONDS:g} seconds"
        )
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

def _chroma(audio: np.ndarray) -> np.ndarray:
    _, _, spectrum = stft(
        audio, fs=COMPARISON_SAMPLE_RATE, nperseg=1024, noverlap=512,
        boundary=None, padded=False,
    )
    magnitudes = np.abs(spectrum)
    frequencies = np.fft.rfftfreq(1024, 1 / COMPARISON_SAMPLE_RATE)
    valid = frequencies >= 55.0
    pitch_classes = np.mod(
        np.rint(12 * np.log2(frequencies[valid] / 440.0) + 9).astype(int), 12
    )
    chroma = np.zeros((magnitudes.shape[1], 12), dtype=np.float64)
    for pitch_class in range(12):
        chroma[:, pitch_class] = magnitudes[valid][pitch_classes == pitch_class].sum(axis=0)
    norms = np.linalg.norm(chroma, axis=1, keepdims=True)
    return np.divide(chroma, norms, out=np.zeros_like(chroma), where=norms > 1e-8)

def _strongest_chroma_match(source: np.ndarray, output: np.ndarray) -> dict:
    source_chroma, output_chroma = _chroma(source), _chroma(output)
    frames_per_second = COMPARISON_SAMPLE_RATE / 512
    max_lag = int(MAX_OFFSET_SECONDS * frames_per_second)
    minimum_frames = max(int(MIN_OVERLAP_SECONDS * frames_per_second), 4)
    best = {"correlation": 0.0, "tempoRatio": 1.0, "pitchSemitones": 0, "lagFrames": 0}
    searched = 0
    for tempo_ratio in TEMPO_RATIOS:
        target_frames = max(1, int(round(len(source_chroma) / tempo_ratio)))
        indices = np.linspace(0, max(len(source_chroma) - 1, 0), target_frames)
        stretched = np.vstack([
            np.interp(indices, np.arange(len(source_chroma)), source_chroma[:, column])
            for column in range(12)
        ]).T
        for pitch_semitones in PITCH_SEMITONES:
            candidate = np.roll(stretched, pitch_semitones, axis=1)
            for lag in range(-max_lag, max_lag + 1):
                source_start, output_start = max(-lag, 0), max(lag, 0)
                overlap = min(len(candidate) - source_start, len(output_chroma) - output_start)
                if overlap < minimum_frames:
                    continue
                left = candidate[source_start:source_start + overlap].ravel()
                right = output_chroma[output_start:output_start + overlap].ravel()
                left = left - left.mean()
                right = right - right.mean()
                denominator = np.linalg.norm(left) * np.linalg.norm(right)
                correlation = abs(float(np.dot(left, right) / denominator)) if denominator > 1e-8 else 0.0
                searched += 1
                if correlation > best["correlation"]:
                    best = {
                        "correlation": correlation, "tempoRatio": tempo_ratio,
                        "pitchSemitones": pitch_semitones, "lagFrames": lag,
                    }
    best["searchedTransformCount"] = len(TEMPO_RATIOS) * len(PITCH_SEMITONES)
    best["searchedAlignmentCount"] = searched
    best["offsetSeconds"] = best.pop("lagFrames") / frames_per_second
    return best
