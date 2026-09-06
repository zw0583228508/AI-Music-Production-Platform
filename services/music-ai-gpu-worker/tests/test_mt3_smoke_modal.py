import copy
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
os.environ["MUSIC_PROVIDER_MT3_SOURCE_REVISION"] = (
    "940af5a1c1c5be6954d3d8977ecb3f2864e9fec1"
)
spec = importlib.util.spec_from_file_location(
    "mt3_smoke_modal_under_test", ROOT / "mt3_smoke_modal.py"
)
mt3_smoke = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mt3_smoke)


class Mt3SmokeModalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.release = json.loads(
            (
                ROOT / "release-evidence" / "mt3" / "release-evidence.json"
            ).read_text()
        )

    def current_proof(self):
        proof = copy.deepcopy(self.release["smokeEvidence"])
        proof["smokeFixture"] = {
            "id": "structured-click-track-32s",
            "durationSeconds": 32,
            "nonSilent": True,
        }
        proof["workerSourceRevision"] = self.release["sourceRevision"]
        return proof

    def test_current_build_identity_and_release_proof_validate_together(self):
        self.assertNotIn(
            "MUSIC_GPU_CONTAINER_DIGEST", mt3_smoke.EXPECTED_ENVIRONMENT,
        )
        self.assertEqual(
            mt3_smoke.EXPECTED_CONTAINER_DIGEST,
            self.release["sourceImageDigest"],
        )
        self.assertEqual(
            mt3_smoke.EXPECTED_SOURCE_REVISION,
            self.release["sourceRevision"],
        )
        self.assertEqual(
            mt3_smoke.validate_smoke_proof(self.current_proof()),
            self.current_proof(),
        )

    def test_validator_rejects_license_and_note_hash_drift(self):
        proof = self.current_proof()
        proof["checkpointLicense"] = "NOASSERTION"
        with self.assertRaisesRegex(RuntimeError, "reviewed deployment"):
            mt3_smoke.validate_smoke_proof(proof)
        proof = self.current_proof()
        proof["output"]["noteEvents"][0]["end"] += 0.1
        with self.assertRaisesRegex(RuntimeError, "reviewed deployment"):
            mt3_smoke.validate_smoke_proof(proof)


if __name__ == "__main__":
    unittest.main()