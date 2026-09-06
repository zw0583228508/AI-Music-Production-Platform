import json
import unittest
from pathlib import Path


SERVICES = Path(__file__).resolve().parents[2]
STATUS_FILES = {
    "sheetsage-worker": {"SHEETSAGE"},
    "beat-this-worker": {"BEAT_THIS"},
    "music-ai-gpu-worker": {"ACE_STEP", "ALL_IN_ONE", "MT3", "MR_MT3", "YOUR_MT3"},
    "songformer-worker": {"SONGFORMER"},
    "moss-music-worker": {"MOSS_MUSIC_INSTRUCT", "MOSS_MUSIC_THINKING"},
    "lada-band-worker": {"LADA_BAND"},
    "hafm-worker": {"HAFM"},
    "anyaccomp-worker": {"ANYACCOMP"},
    "midi-sag-worker": {"MIDI_SAG", "MUSE_CONTROL_LITE"},
    "musicgen-worker": {
        "MUSICGEN_LARGE",
        "MUSICGEN_MELODY_LARGE",
        "JASCO_CHORDS_DRUMS_MELODY",
    },
    "diffrhythm2-worker": {"DIFFRHYTHM_2"},
    "stable-audio3-worker": {
        "STABLE_AUDIO_3_SMALL_MUSIC",
        "STABLE_AUDIO_3_MEDIUM",
    },
}
CLASSIFICATIONS = {
    "READY",
    "RESEARCH_READY",
    "BLOCKED_LICENSE",
    "BLOCKED_NO_WEIGHTS",
    "BLOCKED_UPSTREAM",
    "BLOCKED_MISSING_LICENSED_ASSET",
}


class PhaseOneToThreeInstallationStatusTest(unittest.TestCase):
    def test_statuses_are_complete_machine_readable_and_truthful(self):
        for worker, expected_providers in STATUS_FILES.items():
            with self.subTest(worker=worker):
                worker_root = SERVICES / worker
                document = json.loads(
                    (worker_root / "installation-status.json").read_text()
                )
                self.assertEqual(document["schemaVersion"], 1)
                self.assertEqual(set(document["providers"]), expected_providers)
                self.assertTrue((worker_root / "model_manifest.json").is_file())
                for provider, record in document["providers"].items():
                    self.assertIn(record["classification"], CLASSIFICATIONS)
                    self.assertIsInstance(record["evidence"], dict)
                    self.assertTrue(record["evidence"])
                    if record["classification"] == "READY":
                        self.assertTrue(
                            any(
                                key.endswith("SmokeProofPresent")
                                and value is True
                                for key, value in record["evidence"].items()
                            )
                            or (
                                isinstance(record["evidence"].get("realSmoke"), dict)
                                and bool(record["evidence"]["realSmoke"])
                            ),
                            f"{provider} cannot be READY without real smoke evidence",
                        )
                    else:
                        self.assertIsInstance(record["blockers"], list)
                        self.assertTrue(record["blockers"])
                        self.assertTrue(
                            all(
                                isinstance(blocker, str) and blocker.strip()
                                for blocker in record["blockers"]
                            )
                        )


if __name__ == "__main__":
    unittest.main()