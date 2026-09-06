#!/usr/bin/env python3
"""TrackModel-to-MIDI adapter for the sfizz 1.2.3 native offline renderer."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import mido
import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_request, midi_events, parser, write_attestation


def sfz_file(library: Path) -> Path:
    configured = os.getenv("MUSIC_AI_SFIZZ_INSTRUMENT")
    candidate = library / configured if configured else None
    if candidate and candidate.is_file() and candidate.suffix.lower() == ".sfz":
        return candidate
    raise ValueError("MUSIC_AI_SFIZZ_INSTRUMENT must name an approved SFZ file in the library")


def main() -> None:
    args = parser("sfz").parse_args()
    request, track = load_request(args.track_model)
    if track["automation"]:
        raise ValueError("SFZ automation requires an approved asset-specific CC mapping")
    with tempfile.TemporaryDirectory(prefix="sfizz-host-") as temporary:
        midi_path = Path(temporary) / "input.mid"
        rendered = Path(temporary) / "rendered.wav"
        midi = mido.MidiFile(ticks_per_beat=1000)
        midi_track = mido.MidiTrack()
        midi.tracks.append(midi_track)
        previous = 0
        for message, seconds in midi_events(track):
            tick = round(seconds * 2000)
            midi_track.append(mido.Message.from_bytes(list(message)).copy(time=tick - previous))
            previous = tick
        midi.save(midi_path)
        subprocess.run([
            os.getenv("SFIZZ_RENDER_BINARY", "sfizz_render"),
            "--sfz", str(sfz_file(args.library)),
            "--midi", str(midi_path),
            "--wav", str(rendered),
            "--samplerate", str(args.sample_rate),
        ], check=True, timeout=float(os.getenv("MUSIC_AI_INFERENCE_TIMEOUT_SECONDS", "540")))
        audio, rate = sf.read(rendered, always_2d=True, dtype="float32")
        if rate != args.sample_rate:
            raise ValueError("sfizz returned the wrong sample rate")
        frames = round(args.sample_rate * args.duration_seconds)
        if audio.shape[0] < frames:
            audio = np.pad(audio, ((0, frames - audio.shape[0]), (0, 0)))
        sf.write(args.output, audio[:frames], rate, subtype="PCM_16")
    write_attestation("sfz", args, track, args.library, Path(__file__).resolve())


if __name__ == "__main__":
    main()