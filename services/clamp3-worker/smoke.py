"""Real semantic smoke. Requires provisioned assets and a GPU-capable runtime."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import struct
import wave
from pathlib import Path

from inference import similarity


def _tone(path: Path, frequency: float, *, percussive: bool = False) -> None:
    sample_rate = 24_000
    duration = 4.0
    frames = bytearray()
    for index in range(int(sample_rate * duration)):
        elapsed = index / sample_rate
        if percussive:
            phase = elapsed % 0.5
            envelope = math.exp(-18.0 * phase)
            sample = envelope * (
                math.sin(2 * math.pi * frequency * elapsed)
                + 0.45 * math.sin(2 * math.pi * frequency * 2.03 * elapsed)
            )
        else:
            envelope = min(1.0, elapsed * 8.0) * min(1.0, (duration - elapsed) * 8.0)
            vibrato = 1.0 + 0.006 * math.sin(2 * math.pi * 5.2 * elapsed)
            sample = envelope * (
                0.7 * math.sin(2 * math.pi * frequency * vibrato * elapsed)
                + 0.2 * math.sin(2 * math.pi * frequency * 2 * elapsed)
            )
        frames.extend(struct.pack("<h", max(-32767, min(32767, int(sample * 18_000)))))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(frames)


def _item(path: Path, modality: str) -> dict:
    return {"modality": modality, "dataBase64": base64.b64encode(path.read_bytes()).decode()}


def run(fixtures: Path) -> dict:
    violin_audio_path = fixtures / "violin.wav"
    drums_audio_path = fixtures / "drums.wav"
    _tone(violin_audio_path, 440.0)
    _tone(drums_audio_path, 73.42, percussive=True)
    violin_audio = _item(violin_audio_path, "audio")
    drums_audio = _item(drums_audio_path, "audio")
    violin_midi = _item(fixtures / "violin.mid", "midi")

    text = {"modality": "text", "text": "solo violin melody"}
    text_audio_matching = similarity(text, violin_audio)["similarity"]
    text_audio_mismatched = similarity(text, drums_audio)["similarity"]
    midi_audio_matching = similarity(violin_midi, violin_audio)["similarity"]
    midi_audio_mismatched = similarity(violin_midi, drums_audio)["similarity"]
    if not text_audio_matching > text_audio_mismatched:
        raise AssertionError(
            f"text/audio matching score {text_audio_matching} must exceed "
            f"mismatched score {text_audio_mismatched}"
        )
    if not midi_audio_matching > midi_audio_mismatched:
        raise AssertionError(
            f"MIDI/audio matching score {midi_audio_matching} must exceed "
            f"mismatched score {midi_audio_mismatched}"
        )
    return {
        "ok": True,
        "comparisons": {
            "textAudio": {
                "matching": text_audio_matching,
                "mismatched": text_audio_mismatched,
                "margin": text_audio_matching - text_audio_mismatched,
            },
            "midiAudio": {
                "matching": midi_audio_matching,
                "mismatched": midi_audio_mismatched,
                "margin": midi_audio_matching - midi_audio_mismatched,
            },
        },
        "fixtures": {
            path.name: {
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for path in (
                fixtures / "violin.mid",
                fixtures / "drums.mid",
                violin_audio_path,
                drums_audio_path,
            )
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    print(json.dumps(run(parser.parse_args().fixtures), sort_keys=True))