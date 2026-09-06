"""Create a deterministic, third-party-free vocal-like validation fixture."""
from __future__ import annotations

import hashlib
import json
import math
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 24000
NOTES_HZ = [220.0, 261.625565, 329.627557, 293.664768]
SECONDS_PER_NOTE = 2.0


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def formant_weight(frequency: float) -> float:
    formants = ((700.0, 95.0, 1.0), (1220.0, 130.0, 0.55), (2600.0, 180.0, 0.2))
    return sum(
        gain * math.exp(-0.5 * ((frequency - center) / width) ** 2)
        for center, width, gain in formants
    )


def create_fixture(path: Path) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    sample_count = int(SAMPLE_RATE * SECONDS_PER_NOTE * len(NOTES_HZ))
    frames = bytearray()
    for index in range(sample_count):
        note_index = min(int(index / (SAMPLE_RATE * SECONDS_PER_NOTE)), len(NOTES_HZ) - 1)
        local_time = (index - note_index * SAMPLE_RATE * SECONDS_PER_NOTE) / SAMPLE_RATE
        base = NOTES_HZ[note_index]
        vibrato = 1.0 + 0.006 * math.sin(2 * math.pi * 5.1 * local_time)
        frequency = base * vibrato
        attack = min(1.0, local_time / 0.08)
        release = min(1.0, (SECONDS_PER_NOTE - local_time) / 0.16)
        envelope = max(0.0, attack * release)
        value = 0.0
        normalization = 0.0
        for harmonic in range(1, 25):
            weight = formant_weight(base * harmonic) / harmonic
            normalization += weight
            value += weight * math.sin(2 * math.pi * frequency * harmonic * local_time)
        value = 0.62 * envelope * value / max(normalization, 1e-9)
        frames.extend(struct.pack("<h", max(-32767, min(32767, round(value * 32767)))))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(frames)
    return {
        "schemaVersion": 1,
        "fixtureType": "deterministic procedural sung-vowel approximation",
        "origin": "generated locally from mathematical oscillators and vocal-formant envelopes",
        "containsExternalRecording": False,
        "containsBiologicalVoice": False,
        "containsThirdPartyComposition": False,
        "authorizationScope": "private AnyAccomp validation and regression testing only",
        "sampleRate": SAMPLE_RATE,
        "channels": 1,
        "durationSeconds": SECONDS_PER_NOTE * len(NOTES_HZ),
        "notesHz": NOTES_HZ,
        "bytes": path.stat().st_size,
        "sha256": digest(path),
    }


def create_fixture_with_authorization(root: Path) -> dict:
    fixture = root / "fixtures/authorized-procedural-vocal.wav"
    authorization = create_fixture(fixture)
    (root / "fixtures/fixture-authorization.json").write_text(
        json.dumps(authorization, indent=2, sort_keys=True)
    )
    return authorization