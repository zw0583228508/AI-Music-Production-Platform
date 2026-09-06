import hashlib
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

from runners import mt3
from runners import your_mt3


class Mt3RunnerEvidenceTests(unittest.TestCase):
    def test_yourmt3_provenance_is_not_inherited_from_official_mt3(self):
        manifest = json.loads((ROOT / "model_manifest.json").read_text())
        self.assertIn("mimbres/YourMT3@", your_mt3.CHECKPOINT_SOURCE_REVISION)
        self.assertEqual(
            manifest["providers"]["YOUR_MT3"]["revision"],
            your_mt3.CHECKPOINT_SOURCE_REVISION,
        )
        self.assertIn("transformers==4.45.1", your_mt3.BACKEND_PATCH)
        self.assertEqual(
            your_mt3.CONVERSION_SOURCE_REVISION,
            "not-applicable-native-yourmt3-checkpoint",
        )

    def test_retained_note_output_is_bounded_and_hash_addressed(self):
        notes = [
            {
                "start": 0.0,
                "end": 0.5,
                "pitch": 60,
                "velocity": 96,
                "confidence": 96 / 127,
            }
        ]
        output = mt3.retained_note_output(notes)
        self.assertEqual(output["notes"], 1)
        self.assertEqual(output["terminatedNotes"], 1)
        self.assertTrue(output["allNotesTerminated"])
        self.assertEqual(output["noteEvents"], notes)
        self.assertEqual(
            output["noteEventsSha256"],
            hashlib.sha256(
                json.dumps(
                    notes, sort_keys=True, separators=(",", ":"), allow_nan=False,
                ).encode()
            ).hexdigest(),
        )

    def test_retained_note_output_rejects_unbounded_evidence(self):
        with self.assertRaisesRegex(mt3.RunnerError, "1 to 4096"):
            mt3.retained_note_output([])


if __name__ == "__main__":
    unittest.main()