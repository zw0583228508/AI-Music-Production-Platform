"""Provisioning-only real inference proof; no synthetic audio is accepted."""
from __future__ import annotations
import hashlib, json, os
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
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

def signal_comparison(source_path: Path, output_path: Path) -> dict:
    source, source_rate = sf.read(str(source_path), always_2d=True)
    output, output_rate = sf.read(str(output_path), always_2d=True)
    source = source.mean(axis=1)
    output = output.mean(axis=1)
    if source_rate != output_rate:
        divisor = int(np.gcd(source_rate, output_rate))
        source = resample_poly(source, output_rate // divisor, source_rate // divisor)
    compared_samples = min(len(source), len(output))
    if compared_samples < output_rate:
        raise RuntimeError("smoke comparison requires at least one second of audio")
    source = source[:compared_samples] - source[:compared_samples].mean()
    output = output[:compared_samples] - output[:compared_samples].mean()
    source_rms = float(np.sqrt(np.mean(source ** 2)))
    output_rms = float(np.sqrt(np.mean(output ** 2)))
    if source_rms <= 1e-8 or output_rms <= 1e-8:
        raise RuntimeError("smoke comparison rejects silent source or output")
    source_normalized = source / source_rms
    output_normalized = output / output_rms
    correlation = float(
        np.dot(source_normalized, output_normalized) / compared_samples
    )
    normalized_difference = float(min(
        np.sqrt(np.mean((source_normalized - output_normalized) ** 2) / 2),
        np.sqrt(np.mean((source_normalized + output_normalized) ** 2) / 2),
    ))
    absolute_correlation = abs(correlation)
    passes = absolute_correlation < 0.98 and normalized_difference > 0.1
    return {
        "method": "resampled-aligned-mono-waveform-v1",
        "sourceSampleRate": source_rate,
        "outputSampleRate": output_rate,
        "comparedSamples": compared_samples,
        "absoluteWaveformCorrelation": absolute_correlation,
        "polarityInvariantNormalizedDifference": normalized_difference,
        "copyLikeCorrelationThreshold": 0.98,
        "copyLikeDifferenceThreshold": 0.1,
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
