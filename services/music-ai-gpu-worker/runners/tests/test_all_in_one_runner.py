from __future__ import annotations

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from runners.common import RunnerError
from runners.all_in_one import normalize_structure


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