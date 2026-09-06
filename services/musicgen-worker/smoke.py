"""Provisioning-only MusicGen smoke; runs actual text and melody inference."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path

import soundfile as sf

from app import ASSET_ROOT, SPEC, _generate, _sha256


def _non_silent(wav_bytes: bytes) -> tuple[bool, float]:
    import io
    audio, _ = sf.read(io.BytesIO(wav_bytes), always_2d=True)
    peak = float(abs(audio).max()) if len(audio) else 0.0
    rms = float((audio ** 2).mean() ** 0.5) if len(audio) else 0.0
    return peak > 1e-4 and rms > 1e-5, rms


def main(fixture: Path) -> dict:
    if not fixture.is_file():
        raise RuntimeError("uploaded vocal/melody smoke fixture is missing")
    import audiocraft
    import torch

    source = fixture.read_bytes()
    text, text_rate = _generate("text", "warm acoustic instrumental music", 4, 101, 1.0, 250, 0.0, 3.0)
    melody, melody_rate = _generate("melody", "gentle piano accompaniment following the melody", 4, 202, 1.0, 250, 0.0, 3.0, source)
    text_ok, text_rms = _non_silent(text)
    melody_ok, melody_rms = _non_silent(melody)
    # A byte identity check catches the direct-copy failure mode, while the
    # correlation guard catches a copied source re-encoded as WAV.
    source_audio, _ = sf.read(str(fixture), always_2d=True)
    generated_audio, _ = sf.read(__import__("io").BytesIO(melody), always_2d=True)
    count = min(len(source_audio), len(generated_audio))
    correlation = 0.0
    if count > 32:
        import numpy as np
        left, right = source_audio[:count].mean(axis=1), generated_audio[:count].mean(axis=1)
        if float(np.std(left)) > 1e-8 and float(np.std(right)) > 1e-8:
            correlation = float(np.corrcoef(left, right)[0, 1])
    not_copy = hashlib.sha256(source).hexdigest() != hashlib.sha256(melody).hexdigest() and abs(correlation) < 0.995
    ffmpeg = subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]
    if not (text_ok and melody_ok and not_copy):
        raise RuntimeError("MusicGen smoke rejected silent or copied-source output")
    proof = {
        "provider": "MUSICGEN", "realInference": True,
        "assetManifestSha256": _sha256(ASSET_ROOT / SPEC["asset_manifest"]),
        "runtimeEvidence": {"audiocraft": getattr(audiocraft, "__version__", "source-checkout"),
                            "torch": torch.__version__, "ffmpeg": ffmpeg},
        "text": {"sampleRate": text_rate, "artifactSha256": hashlib.sha256(text).hexdigest(),
                 "nonSilent": text_ok, "rms": text_rms},
        "melody": {"sampleRate": melody_rate, "artifactSha256": hashlib.sha256(melody).hexdigest(),
                   "nonSilent": melody_ok, "rms": melody_rms, "notSourceCopy": not_copy,
                   "sourceSha256": hashlib.sha256(source).hexdigest(), "correlation": correlation},
    }
    (ASSET_ROOT / SPEC["smoke_proof"]).write_text(json.dumps(proof, indent=2, sort_keys=True), encoding="utf-8")
    return proof


if __name__ == "__main__":
    main(Path(os.environ["MUSICGEN_SMOKE_AUDIO"]))