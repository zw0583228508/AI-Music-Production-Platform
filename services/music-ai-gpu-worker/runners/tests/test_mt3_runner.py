from __future__ import annotations

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from runners.common import RunnerError
from runners.mt3 import normalize_notes


class Mt3RunnerTests(unittest.TestCase):
 def test_mt3_maps_timed_official_evidence_to_canonical_notes(self) -> None:
    notes = normalize_notes(
        [
            {"onset": 2.0, "offset": 2.4, "midi": 67, "velocity": 91, "score": 0.8},
            {"onset": 0.1, "offset": 0.4, "midi": 60, "velocity": 80, "score": 0.9},
        ],
        3,
    )
    self.assertEqual(notes, [
        {"start": 0.1, "end": 0.4, "pitch": 60, "velocity": 80, "confidence": 0.9},
        {"start": 2.0, "end": 2.4, "pitch": 67, "velocity": 91, "confidence": 0.8},
    ])

 def test_mt3_refuses_invalid_model_evidence(self) -> None:
    for event in (
        {"onset": 1, "offset": 1, "midi": 60, "velocity": 10, "score": .5},
        {"onset": 0, "offset": 1, "midi": 128, "velocity": 10, "score": .5},
        {"onset": 0, "offset": 1, "midi": 60, "velocity": 10, "score": 1.1},
    ):
        with self.assertRaises(RunnerError):
            normalize_notes([event], 3)