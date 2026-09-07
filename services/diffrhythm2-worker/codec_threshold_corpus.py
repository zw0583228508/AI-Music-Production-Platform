"""Deterministic lossy-codec safety-margin gate for source-copy detection."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from smoke import (
    COPY_LIKE_CORRELATION_THRESHOLD,
    COPY_LIKE_DIFFERENCE_THRESHOLD,
    signal_comparison,
)

CODEC_CASES = (
    ("mp3-64k.mp3", 16000, 1, "libmp3lame", ("-b:a", "64k")),
    ("mp3-v2.mp3", 44100, 2, "libmp3lame", ("-q:a", "2")),
    ("aac-64k.aac", 22050, 1, "aac", ("-b:a", "64k")),
    ("aac-160k.aac", 44100, 2, "aac", ("-b:a", "160k")),
    ("opus-48k.ogg", 24000, 1, "libopus", ("-b:a", "48k")),
    ("opus-128k.ogg", 48000, 2, "libopus", ("-b:a", "128k")),
)
COPY_CORRELATION_FLOOR = 0.97
COPY_DIFFERENCE_CEILING = 0.18
UNRELATED_CORRELATION_CEILING = 0.35
UNRELATED_DIFFERENCE_FLOOR = 0.80


def music_fixture(kind: str, sample_rate: int, channels: int) -> np.ndarray:
    time = np.arange(sample_rate * 4, dtype=np.float64) / sample_rate
    if kind == "melodic":
        envelope = 0.35 + 0.65 * np.sin(np.pi * np.minimum(time % 1.0, 0.999)) ** 2
        mono = envelope * (
            0.38 * np.sin(2 * np.pi * (196 * time + 7 * time * time))
            + 0.19 * np.sin(2 * np.pi * 293.66 * time)
            + 0.11 * np.sin(2 * np.pi * 440 * time)
        )
    else:
        rng = np.random.default_rng(174)
        phase = time % 0.5
        kick = np.sin(2 * np.pi * (95 * phase - 55 * phase * phase)) * np.exp(
            -phase * 15
        )
        hats = rng.normal(0, 1, len(time)) * np.exp(-(time % 0.25) * 45)
        mono = 0.52 * kick + 0.055 * hats
    if channels == 1:
        return mono
    delayed = np.concatenate((np.zeros(max(1, sample_rate // 400)), mono))[: len(mono)]
    return np.column_stack((mono, 0.82 * delayed))


def _ffmpeg(*args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        check=True,
        capture_output=True,
        text=True,
    )


def ffmpeg_version() -> str:
    completed = subprocess.run(
        ["ffmpeg", "-hide_banner", "-version"],
        check=True,
        capture_output=True,
        text=True,
    )
    first_line = completed.stdout.splitlines()[0].strip()
    if not first_line.startswith("ffmpeg version "):
        raise RuntimeError("FFmpeg did not report a recognizable version")
    return first_line


def run_corpus() -> dict:
    if COPY_CORRELATION_FLOOR - COPY_LIKE_CORRELATION_THRESHOLD < 0.02:
        raise AssertionError("copy corpus correlation safety margin is below 0.02")
    if COPY_LIKE_DIFFERENCE_THRESHOLD - COPY_DIFFERENCE_CEILING < 0.07:
        raise AssertionError("copy corpus difference safety margin is below 0.07")

    results = []
    with tempfile.TemporaryDirectory() as directory_name:
        directory = Path(directory_name)
        for fixture_kind in ("melodic", "percussive"):
            for filename, sample_rate, channels, encoder, quality in CODEC_CASES:
                label = f"{fixture_kind}-{filename}"
                source = directory / f"{label}-source.wav"
                encoded = directory / label
                decoded = directory / f"{label}-decoded.wav"
                unrelated = directory / f"{label}-unrelated.wav"
                other_kind = "percussive" if fixture_kind == "melodic" else "melodic"
                sf.write(
                    source,
                    music_fixture(fixture_kind, sample_rate, channels),
                    sample_rate,
                    subtype="PCM_16",
                )
                sf.write(
                    unrelated,
                    music_fixture(other_kind, sample_rate, channels),
                    sample_rate,
                    subtype="PCM_16",
                )
                _ffmpeg("-i", str(source), "-c:a", encoder, *quality, str(encoded))
                _ffmpeg("-i", str(encoded), str(decoded))
                copied = signal_comparison(source, decoded)
                distinct = signal_comparison(source, unrelated)
                passed = (
                    copied["passesNotSourceCopy"] is False
                    and copied["absoluteWaveformCorrelation"]
                    >= COPY_CORRELATION_FLOOR
                    and copied["polarityInvariantNormalizedDifference"]
                    <= COPY_DIFFERENCE_CEILING
                    and distinct["passesNotSourceCopy"] is True
                    and distinct["absoluteWaveformCorrelation"]
                    <= UNRELATED_CORRELATION_CEILING
                    and distinct["polarityInvariantNormalizedDifference"]
                    >= UNRELATED_DIFFERENCE_FLOOR
                )
                results.append(
                    {
                        "label": label,
                        "codec": encoder,
                        "sampleRate": sample_rate,
                        "channels": channels,
                        "copyCorrelation": copied["absoluteWaveformCorrelation"],
                        "copyDifference": copied[
                            "polarityInvariantNormalizedDifference"
                        ],
                        "unrelatedCorrelation": distinct[
                            "absoluteWaveformCorrelation"
                        ],
                        "unrelatedDifference": distinct[
                            "polarityInvariantNormalizedDifference"
                        ],
                        "passed": passed,
                    }
                )
                if not passed:
                    raise AssertionError(f"codec threshold safety margin failed: {label}")
    return {
        "schemaVersion": 1,
        "passed": True,
        "ffmpegVersion": ffmpeg_version(),
        "safetyMargins": {
            "copyCorrelationFloor": COPY_CORRELATION_FLOOR,
            "copyDifferenceCeiling": COPY_DIFFERENCE_CEILING,
            "unrelatedCorrelationCeiling": UNRELATED_CORRELATION_CEILING,
            "unrelatedDifferenceFloor": UNRELATED_DIFFERENCE_FLOOR,
        },
        "cases": results,
        "audioRetained": False,
    }


if __name__ == "__main__":
    target = Path(
        os.getenv("DIFFRHYTHM2_CODEC_EVIDENCE", "/app/codec-threshold-evidence.json")
    )
    target.write_text(json.dumps(run_corpus(), sort_keys=True, separators=(",", ":")) + "\n")
