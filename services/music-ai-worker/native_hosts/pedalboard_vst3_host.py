#!/usr/bin/env python3
"""Offline TrackModel host for a separately licensed VST3 instrument."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from pedalboard import load_plugin

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_request, midi_events, parser, write_attestation


def main() -> None:
    args = parser("vst3").parse_args()
    request, track = load_request(args.track_model)
    if track["automation"]:
        raise ValueError("VST3 automation requires an approved asset-specific parameter mapping")
    plugin = load_plugin(str(args.plugin))
    audio = plugin(
        midi_events(track),
        duration=args.duration_seconds,
        sample_rate=args.sample_rate,
        reset=True,
    )
    frames = round(args.sample_rate * args.duration_seconds)
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]
    if audio.shape[1] < frames:
        audio = np.pad(audio, ((0, 0), (0, frames - audio.shape[1])))
    sf.write(args.output, audio[:, :frames].T, args.sample_rate, subtype="PCM_16")
    write_attestation("vst3", args, track, args.plugin, Path(__file__).resolve())


if __name__ == "__main__":
    main()