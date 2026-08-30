from __future__ import annotations

import unittest
import sys
import tempfile
import types
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from runners.common import RunnerError
from runners.all_in_one import _official_evidence, normalize_structure


def evidence() -> dict[str, object]:
    return {
        "confidence": .8,
        "tempo": {"bpm": 120, "confidence": .9},
        "meter": {"meter": "4/4", "confidence": .9},
        "beats": [
            {"time": 0, "bar": 1, "beat": 1, "confidence": .8},
            {"time": .5, "bar": 1, "beat": 2, "confidence": .8},
            {"time": 1, "bar": 1, "beat": 3, "confidence": .8},
            {"time": 1.5, "bar": 1, "beat": 4, "confidence": .8},
            {"time": 2, "bar": 2, "beat": 1, "confidence": .8},
        ],
        "downbeats": [0, 2],
        "bars": [
            {"bar": 1, "start": 0, "end": 2, "beats": 4, "confidence": .8},
            {"bar": 2, "start": 2, "end": 3, "beats": 1, "confidence": .8},
        ],
        "sections": [{"label": "intro", "startBar": 1, "endBar": 2, "energy": .3}],
    }


class AllInOneRunnerTests(unittest.TestCase):
 def test_structure_maps_injected_model_evidence(self) -> None:
    output = normalize_structure(evidence(), 3)
    self.assertEqual(output["bpm"], 120)
    self.assertEqual(output["meterMap"][0]["meter"], "4/4")
    self.assertEqual(output["sections"], [{"name": "intro", "startBar": 1, "endBar": 2, "energy": .3}])


 def test_structure_fails_closed_when_downbeats_disagree(self) -> None:
    raw = evidence()
    raw["downbeats"] = [0]
    with self.assertRaisesRegex(RunnerError, "downbeats"):
        normalize_structure(raw, 3)


 def test_structure_discards_only_a_leading_partial_bar(self) -> None:
    result = types.SimpleNamespace(
        bpm=120,
        beats=[0.25, 0.75, 1.25, 1.75, 2.25, 2.75],
        beat_positions=[3, 4, 1, 2, 3, 4],
        downbeats=[1.25],
        segments=[
            types.SimpleNamespace(start=0.0, end=3.0, label="intro"),
        ],
    )
    with tempfile.TemporaryDirectory() as directory:
        audio = Path(directory) / "fixture.wav"
        with wave.open(str(audio), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(8_000)
            output.writeframes(b"\x01\x00" * 32_000)
        normalized = normalize_structure(_official_evidence(result, audio), 4.0)
    self.assertEqual(normalized["beats"][0], {
        "time": 1.25, "beat": 1, "bar": 1, "confidence": 1.0,
    })
    self.assertEqual(normalized["downbeats"], [{"time": 1.25}])