import hashlib
import importlib.util
import json
import sys
import types
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
if "modal" not in sys.modules:
    sys.modules["modal"] = types.SimpleNamespace()
spec = importlib.util.spec_from_file_location("gpu_release_modal", ROOT / "release_modal.py")
release_modal = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(release_modal)
sys.modules["release_modal"] = release_modal
activation_spec = importlib.util.spec_from_file_location(
    "gpu_activate_promotion", ROOT / "activate_promotion.py"
)
activate_promotion = importlib.util.module_from_spec(activation_spec)
assert activation_spec and activation_spec.loader
activation_spec.loader.exec_module(activate_promotion)
sys.modules["activate_promotion"] = activate_promotion
deactivation_spec = importlib.util.spec_from_file_location(
    "gpu_deactivate_promotion", ROOT / "deactivate_promotion.py"
)
deactivate_promotion = importlib.util.module_from_spec(deactivation_spec)
assert deactivation_spec and deactivation_spec.loader
deactivation_spec.loader.exec_module(deactivate_promotion)


def mt3_output():
    events = [
        {"start": 0.0, "end": 0.5, "pitch": 60, "velocity": 96, "confidence": 96 / 127},
        {"start": 0.5, "end": 1.0, "pitch": 64, "velocity": 88, "confidence": 88 / 127},
    ]
    encoded = json.dumps(events, sort_keys=True, separators=(",", ":")).encode()
    return {
        "notes": 2,
        "terminatedNotes": 2,
        "allNotesTerminated": True,
        "noteEvents": events,
        "noteEventsSha256": hashlib.sha256(encoded).hexdigest(),
    }


def bs_output():
    descriptor = {
        "format": "wav", "sampleRate": 48_000, "channels": 2,
        "durationSeconds": 5.12, "bytes": 1000,
        "peakAmplitude": 0.5, "rmsAmplitude": 0.1,
    }
    return {
        "input": {**descriptor, "sha256": "a" * 64},
        "stems": [
            {**descriptor, "stem": "vocals", "sha256": "b" * 64},
            {**descriptor, "stem": "instrumental", "sha256": "c" * 64},
        ],
        "stemCount": 2,
        "allStemsNonSilent": True,
        "distinctStemSha256": True,
    }


class GenericModalReleaseTests(unittest.TestCase):
    def test_every_configured_provider_has_authoritative_modal_lookup(self):
        self.assertEqual(set(release_modal.APP_CLASSES), set(release_modal.DEPLOYMENTS))
        self.assertEqual(
            release_modal.APP_CLASSES["ACE_STEP"][0],
            "music-ai-gpu-worker-ace-step",
        )
        self.assertEqual(
            release_modal.APP_CLASSES["MR_MT3"][0],
            "music-ai-mt3-family-worker-mr-mt3",
        )

    def test_evidence_rejects_smoke_from_another_image(self):
        evidence = {
            "schemaVersion": 1,
            "provider": "MT3",
            "modalAppId": "ap-Test",
            "modalDeploymentId": "v2",
            "modalFunctionId": "fu-Test",
            "endpointOrigin": "https://worker.example.test",
            "modalImageId": "im-Current",
            "checkpointSha256": "a" * 64,
            "sourceImageDigest": release_modal.DEPLOYMENTS["MT3"].source_image_digest,
            "sourceRevision": "c" * 40,
            "smokeEvidence": {
                "provider": "MT3",
                "smokeTested": True,
                "checkpointSha256": "a" * 64,
                "output": mt3_output(),
                "provenance": {
                    "checkpointSha256": "a" * 64,
                    "modalImageId": "im-Previous",
                    "sourceImageDigest": release_modal.DEPLOYMENTS["MT3"].source_image_digest,
                },
            },
        }
        with self.assertRaisesRegex(ValueError, "provenance"):
            release_modal.validate_evidence(evidence, "MT3")

    def test_evidence_rejects_runtime_source_digest_not_built_for_provider(self):
        digest = release_modal.DEPLOYMENTS["MT3"].source_image_digest
        evidence = {
            "schemaVersion": 1, "provider": "MT3", "modalAppId": "ap-Test",
            "modalDeploymentId": "v2", "modalFunctionId": "fu-Test",
            "endpointOrigin": "https://worker.example.test", "modalImageId": "im-Current",
            "checkpointSha256": "a" * 64, "sourceImageDigest": "sha256:" + "b" * 64,
            "sourceRevision": "c" * 40,
            "smokeEvidence": {
                "provider": "MT3", "smokeTested": True, "checkpointSha256": "a" * 64,
                "output": mt3_output(), "provenance": {
                    "checkpointSha256": "a" * 64, "modalImageId": "im-Current",
                    "sourceImageDigest": "sha256:" + "b" * 64,
                },
            },
        }
        self.assertNotEqual(evidence["sourceImageDigest"], digest)
        with self.assertRaisesRegex(ValueError, "source image"):
            release_modal.validate_evidence(evidence, "MT3")

    def test_evidence_hash_changes_for_retained_health_drift(self):
        evidence = {"liveHealth": {"healthy": True, "smokeEvidence": {"notes": 2}}}
        original = activate_promotion.evidence_sha256(evidence)
        evidence["liveHealth"]["smokeEvidence"]["notes"] = 3
        self.assertNotEqual(original, activate_promotion.evidence_sha256(evidence))

    def test_evidence_rejects_ci_source_revision_mismatch(self):
        digest = release_modal.DEPLOYMENTS["MT3"].source_image_digest
        evidence = {
            "schemaVersion": 1, "provider": "MT3", "modalAppId": "ap-Test",
            "modalDeploymentId": "v2", "modalFunctionId": "fu-Test",
            "endpointOrigin": "https://worker.example.test", "modalImageId": "im-Current",
            "checkpointSha256": "a" * 64, "sourceImageDigest": digest,
            "sourceRevision": "c" * 40, "smokeEvidence": {
                "provider": "MT3", "smokeTested": True, "checkpointSha256": "a" * 64,
                "output": mt3_output(), "provenance": {
                    "checkpointSha256": "a" * 64, "modalImageId": "im-Current",
                    "sourceImageDigest": digest,
                },
            },
        }
        with mock.patch.dict("os.environ", {"MUSIC_GPU_SOURCE_REVISION": "d" * 40}):
            with self.assertRaisesRegex(ValueError, "source revision"):
                release_modal.validate_evidence(evidence, "MT3")

    def test_evidence_rejects_tampered_mt3_note_events(self):
        output = mt3_output()
        output["noteEvents"][0]["end"] = 0.75
        with self.assertRaisesRegex(ValueError, "note evidence hash"):
            release_modal.validate_mt3_note_output(output)

    def test_yourmt3_release_rejects_incomplete_terminated_note_evidence(self):
        deployment = release_modal.DEPLOYMENTS["YOUR_MT3"]
        base_event = mt3_output()["noteEvents"][0]
        valid_hash = hashlib.sha256(json.dumps(
            [base_event], sort_keys=True, separators=(",", ":"),
        ).encode()).hexdigest()
        invalid_outputs = {
            "zero notes": {
                "notes": 0,
                "terminatedNotes": 0,
                "allNotesTerminated": True,
                "noteEvents": [],
                "noteEventsSha256": hashlib.sha256(b"[]").hexdigest(),
            },
            "unterminated notes": {
                "notes": 1,
                "terminatedNotes": 0,
                "allNotesTerminated": False,
                "noteEvents": [base_event],
                "noteEventsSha256": valid_hash,
            },
            "event hash drift": {
                "notes": 1,
                "terminatedNotes": 1,
                "allNotesTerminated": True,
                "noteEvents": [base_event],
                "noteEventsSha256": "0" * 64,
            },
        }
        for label, output in invalid_outputs.items():
            with self.subTest(label=label), self.assertRaisesRegex(
                ValueError, "note evidence",
            ):
                release_modal.validate_evidence({
                    "schemaVersion": 1,
                    "provider": "YOUR_MT3",
                    "modalAppId": "ap-Test",
                    "modalDeploymentId": "v3",
                    "modalFunctionId": "fu-Test",
                    "endpointOrigin": "https://worker.example.test",
                    "modalImageId": "im-Current",
                    "checkpointSha256": "a" * 64,
                    "sourceImageDigest": deployment.source_image_digest,
                    "sourceRevision": "c" * 40,
                    "smokeEvidence": {
                        "provider": "YOUR_MT3",
                        "smokeTested": True,
                        "checkpointSha256": "a" * 64,
                        "output": output,
                        "provenance": {
                            "checkpointSha256": "a" * 64,
                            "modalImageId": "im-Current",
                            "sourceImageDigest": deployment.source_image_digest,
                        },
                    },
                }, "YOUR_MT3")

    def test_bs_evidence_rejects_identical_or_silent_stems(self):
        output = bs_output()
        release_modal.validate_bs_roformer_output(output)
        output["stems"][1]["sha256"] = output["stems"][0]["sha256"]
        with self.assertRaisesRegex(ValueError, "distinct"):
            release_modal.validate_bs_roformer_output(output)
        output = bs_output()
        output["stems"][0]["rmsAmplitude"] = 0
        with self.assertRaisesRegex(ValueError, "incomplete"):
            release_modal.validate_bs_roformer_output(output)

    def test_failed_activation_keeps_existing_canonical_file(self):
        with __import__("tempfile").TemporaryDirectory() as directory:
            output = Path(directory) / "gpuPromotions.generated.ts"
            original = "prior canonical promotion"
            output.write_text(original)
            with mock.patch.object(
                activate_promotion, "validate", side_effect=ValueError("evidence drift")
            ):
                with self.assertRaisesRegex(ValueError, "evidence drift"):
                    activate_promotion.activate({}, "", {}, {}, {}, output)
            self.assertEqual(output.read_text(), original)

    def test_deactivation_removes_only_requested_canonical_provider(self):
        with __import__("tempfile").TemporaryDirectory() as directory:
            output = Path(directory) / "gpuPromotions.generated.ts"
            canonical = {
                "schemaVersion": 1,
                "publicKey": "test-public-key\n",
                "bundles": {
                    "BS_ROFORMER": {"record": {"provider": "BS_ROFORMER"}},
                    "MT3": {"record": {"provider": "MT3"}},
                },
            }
            activate_promotion.write_canonical(canonical, output)
            deactivate_promotion.deactivate("BS_ROFORMER", output)
            updated = activate_promotion.read_canonical(output)
            self.assertNotIn("BS_ROFORMER", updated["bundles"])
            self.assertEqual(updated["bundles"]["MT3"], canonical["bundles"]["MT3"])
            self.assertEqual(updated["publicKey"], canonical["publicKey"])
            with self.assertRaisesRegex(ValueError, "not active"):
                deactivate_promotion.deactivate("BS_ROFORMER", output)


if __name__ == "__main__":
    unittest.main()