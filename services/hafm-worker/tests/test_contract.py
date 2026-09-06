import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_REVISION = "d9aa19a5820a4c1563ab405d437933480f71d5b9"
MODEL_REVISION = "1653c3c7bffdc9b4b2d57d8b6e4f5bb3002a64fe"
FIXTURE_SHA256 = (
    "3358e43121bf2c22ebd9dc0c424f2a4e071df932ed90d405f9095cac68232265"
)


class ContractTest(unittest.TestCase):
    def test_exact_pins_license_and_fixture_authorization(self):
        spec = json.loads((ROOT / "model_manifest.json").read_text())
        license_manifest = json.loads(
            (ROOT / "license_manifest.json").read_text()
        )
        authorization = json.loads(
            (ROOT / "fixture-authorization.json").read_text()
        )
        self.assertEqual(spec["provider"], "HAFM")
        self.assertEqual(license_manifest["license"], "Apache-2.0")
        self.assertEqual(spec["source"]["revision"], SOURCE_REVISION)
        self.assertEqual(spec["model"]["revision"], MODEL_REVISION)
        self.assertEqual(
            authorization["derivedFixture"]["sha256"],
            FIXTURE_SHA256,
        )
        self.assertTrue(authorization["authorization"]["confirmed"])
        self.assertEqual(
            authorization["authorization"]["confirmedDuringSessionLocalDate"],
            "2026-09-07",
        )
        self.assertEqual(
            authorization["authorization"]["sessionTimezone"],
            "Asia/Jerusalem",
        )
        self.assertEqual(
            authorization["authorization"]["utcCalendarDateAtRetention"],
            "2026-09-06",
        )
        self.assertFalse(authorization["audioCommittedToGit"])

    def test_manifest_retains_exact_upstream_gap_and_model_assets(self):
        spec = json.loads((ROOT / "model_manifest.json").read_text())
        self.assertEqual(
            spec["source"]["documentedEntrypoint"],
            "infer_simple.py",
        )
        self.assertEqual(spec["source"]["publishedEntrypoint"], "infer.py")
        self.assertEqual(
            set(spec["source"]["requiredRuntimeFiles"]),
            {
                "infer.py",
                "configs/ar.yaml",
                "models/ar_singsong.py",
                "data/retokenize.py",
                "utils/audio_utils.py",
            },
        )
        self.assertEqual(len(spec["model"]["requiredAssets"]), 7)
        self.assertEqual(
            spec["runtime"]["inferenceDependencyStatus"],
            "UNPUBLISHED_UPSTREAM",
        )

    def test_image_builds_without_running_expected_failing_probe(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertIn(
            f"checkout --detach {SOURCE_REVISION}",
            dockerfile,
        )
        self.assertNotIn("RUN /app/compatibility.py", dockerfile)
        self.assertNotIn("COPY services/hafm-worker/ /app/", dockerfile)
        self.assertIn("COPY services/hafm-worker/*.py /app/", dockerfile)
        self.assertIn("fixture-authorization.json /app/", dockerfile)

    def test_worker_requirements_are_exactly_pinned(self):
        dependencies = [
            line.strip()
            for line in (ROOT / "requirements.txt").read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertEqual(
            dependencies,
            [
                "fastapi==0.115.12",
                "uvicorn==0.34.2",
                "huggingface-hub==0.30.2",
                "numpy==1.26.4",
                "soundfile==0.13.1",
            ],
        )
        self.assertTrue(
            all(
                re.fullmatch(r"[a-z0-9-]+==[^=\s]+", dependency)
                for dependency in dependencies
            )
        )

    def test_compatibility_is_remote_and_precedes_inference(self):
        compatibility = (ROOT / "compatibility.py").read_text()
        modal_compatibility = (ROOT / "modal_compatibility.py").read_text()
        provision = (ROOT / "modal_provision.py").read_text()
        self.assertIn('evidence["compatible"] = compatible', compatibility)
        self.assertIn('"inferenceAttempted"] = False', compatibility)
        self.assertIn("smoke_volume.commit()", modal_compatibility)
        self.assertIn("check=False", modal_compatibility)
        provision_body = provision[
            provision.index("def provision()"):
            provision.index("@app.function", provision.index("def provision()"))
        ]
        self.assertLess(
            provision_body.index("/app/bootstrap_assets.py"),
            provision_body.index("/app/compatibility.py"),
        )

    def test_bootstrap_reuses_exact_assets_and_writes_validator_schema(self):
        bootstrap = (ROOT / "bootstrap_assets.py").read_text()
        self.assertIn('"status": "verified-existing"', bootstrap)
        self.assertIn('"networkUsed": False', bootstrap)
        self.assertIn("verify_manifest(manifest)", bootstrap)
        self.assertIn('"source": {', bootstrap)
        self.assertIn('"model": {', bootstrap)
        self.assertIn(
            "snapshot exists without its reviewed manifest",
            bootstrap,
        )

    def test_smoke_requires_compatibility_and_proves_non_copy_audio(self):
        smoke = (ROOT / "smoke.py").read_text()
        for expected in (
            'compatibility.get("compatible") is not True',
            '"allSamplesFinite"',
            '"nonSilent"',
            '"distinctFromInput"',
            '"correlationToInput"',
            '"plausibleAccompaniment"',
            '"privateAudioCommittedToGit"',
        ):
            self.assertIn(expected, smoke)
        self.assertIn("output.unlink(missing_ok=True)", smoke)

    def test_health_and_api_execution_fail_closed(self):
        app = (ROOT / "app.py").read_text()
        for expected in (
            '"sourceImageDigest"',
            '"modalAppId"',
            '"modalDeploymentId"',
            '"modalFunctionId"',
            '"modalImageId"',
            '"checkpointReady": assets_ok',
            '"smokeTested": smoke_ok',
            "if not assets_ok or not compatible or not smoke_ok",
        ):
            self.assertIn(expected, app)
        self.assertIn("invalid bearer token", app)

    def test_retained_evidence_uses_non_ignored_extensions(self):
        evidence_root = ROOT / "release-evidence"
        self.assertTrue((evidence_root / "modal-probe.txt").is_file())
        self.assertFalse(any(evidence_root.glob("*.log")))


if __name__ == "__main__":
    unittest.main()