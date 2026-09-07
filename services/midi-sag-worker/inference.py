"""Pinned MIDI-SAG runner adapter; it never synthesizes a fallback MIDI file."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
UPSTREAM = Path("/opt/midi-sag")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def valid_midi(data: bytes) -> bool:
    """Require an actual SMF header and at least one track event, not a placeholder."""
    if len(data) < 26 or data[:4] != b"MThd":
        return False
    header_size = int.from_bytes(data[4:8], "big")
    if header_size < 6 or 8 + header_size + 8 > len(data):
        return False
    offset = 8 + header_size
    saw_track = False
    while offset < len(data):
        if offset + 8 > len(data) or data[offset:offset + 4] != b"MTrk":
            return False
        track_size = int.from_bytes(data[offset + 4:offset + 8], "big")
        offset += 8
        if track_size == 0 or offset + track_size > len(data):
            return False
        saw_track = True
        offset += track_size
    return saw_track and offset == len(data)


def run_pipeline(vocal: bytes, controls: dict[str, Any], vocal_midi: bytes | None) -> dict[str, bytes]:
    if not vocal:
        raise ValueError("vocal audio is empty")
    if vocal_midi is not None and not valid_midi(vocal_midi):
        raise ValueError("vocalMidiBase64 is not a valid nonempty Standard MIDI File")
    runner = UPSTREAM / "production_adapter.py"
    if not runner.is_file():
        raise RuntimeError("pinned MIDI-SAG production adapter is absent; provider is blocked")
    with tempfile.TemporaryDirectory(prefix="midi-sag-") as temp:
        work = Path(temp)
        (work / "vocal.wav").write_bytes(vocal)
        if vocal_midi is not None:
            (work / "vocal.mid").write_bytes(vocal_midi)
        (work / "controls.json").write_text(json.dumps(controls, sort_keys=True))
        completed = subprocess.run(
            ["/opt/midi-sag-venv/bin/python", str(runner), "--input", str(work / "vocal.wav"),
             "--output-dir", str(work / "out"), "--controls", str(work / "controls.json"),
             *(["--vocal-midi", str(work / "vocal.mid")] if vocal_midi is not None else [])],
            check=False, capture_output=True, text=True, timeout=1800,
            env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"},
        )
        if completed.returncode:
            raise RuntimeError("MIDI-SAG upstream inference failed")
        midi = work / "out" / "arrangement.mid"
        wav = work / "out" / "backing.wav"
        if not midi.is_file() or not wav.is_file():
            raise RuntimeError("MIDI-SAG did not produce its required MIDI and backing-audio artifacts")
        midi_bytes, wav_bytes = midi.read_bytes(), wav.read_bytes()
        if not valid_midi(midi_bytes) or not wav_bytes:
            raise RuntimeError("MIDI-SAG produced an invalid or empty output")
        return {"midi": midi_bytes, "wav": wav_bytes}