import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

WORKER = Path(__file__).resolve().parents[1]


def load(name: str, path: str):
    if str(WORKER) not in sys.path:
        sys.path.insert(0, str(WORKER))
    spec = importlib.util.spec_from_file_location(name, WORKER / path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


class AnyAccompContractTests(unittest.TestCase):
    def test_manifest_pins_exact_reviewed_source_model_and_checkpoint_set(self):
        manifest = json.loads((WORKER / "model_manifest.json").read_text())
        self.assertEqual(
            manifest["source"]["revision"],
            "82604b5e3107944ad4c49fc64900b86118ae2c62",
        )
        self.assertEqual(
            manifest["weights"]["revision"],
            "9aa9e62427337bf1df4caa3c4f3e6ad934522e71",
        )
        self.assertEqual(len(manifest["weights"]["files"]), 3)
        files = [
            {key: item[key] for key in ("path", "bytes", "sha256")}
            for item in manifest["weights"]["files"]
        ]
        encoded = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
        self.assertEqual(
            hashlib.sha256(encoded).hexdigest(),
            manifest["weights"]["checkpoint_set_sha256"],
        )
        self.assertTrue(all(len(item["sha256"]) == 64 for item in files))

    def test_retained_license_preimages_match_reviewed_hashes(self):
        review = json.loads(
            (WORKER / "release-evidence/license-review.json").read_text()
        )
        for filename, expected in (
            ("source-license.txt", review["source"]["licenseSha256"]),
            ("model-card.md", review["model"]["modelCardSha256"]),
        ):
            observed = hashlib.sha256(
                (WORKER / "release-evidence" / filename).read_bytes()
            ).hexdigest()
            self.assertEqual(observed, expected)
        self.assertTrue(review["decision"]["commercialDeploymentAuthorized"])
        self.assertFalse(review["decision"]["environmentValuesAreAuthorizationEvidence"])

    def test_procedural_fixture_is_deterministic_and_third_party_free(self):
        fixture = load("anyfixture", "fixture.py")
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            one = fixture.create_fixture_with_authorization(Path(first))
            two = fixture.create_fixture_with_authorization(Path(second))
        self.assertEqual(one["sha256"], two["sha256"])
        self.assertFalse(one["containsExternalRecording"])
        self.assertFalse(one["containsBiologicalVoice"])
        self.assertFalse(one["containsThirdPartyComposition"])
        self.assertEqual(
            one["authorizationScope"],
            "private AnyAccomp validation and regression testing only",
        )

    def test_inference_uses_only_built_in_runner(self):
        inference = load("anyinference", "inference.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "source").mkdir()
            vocal = root / "vocal.wav"
            vocal.write_bytes(b"fixture")
            output = root / "output.wav"
            completed = mock.Mock(returncode=0)

            def fake_run(command, **kwargs):
                output.write_bytes(b"R" * 45)
                self.assertEqual(command[1], str(WORKER / "runner.py"))
                self.assertNotIn("ANYACCOMP_INFERENCE_COMMAND", " ".join(command))
                return completed

            with mock.patch.object(inference.subprocess, "run", side_effect=fake_run):
                inference.run(vocal, output, "ignored", root)

    def test_inference_fails_closed_without_reviewed_source(self):
        inference = load("anyinference_missing", "inference.py")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(
                inference.InferenceError, "reviewed AnyAccomp source"
            ):
                inference.run(
                    Path(directory) / "input.wav",
                    Path(directory) / "output.wav",
                    "",
                    Path(directory),
                )

    def test_docker_runtime_is_digest_only_and_exactly_pinned(self):
        dockerfile = (WORKER / "Dockerfile").read_text()
        self.assertIn(
            "FROM nvidia/cuda@sha256:f4d8e1264366940438f0353da6f289c7bef069d993d111f8106086ccd18c4a30",
            dockerfile,
        )
        self.assertIn("torch==2.3.1", dockerfile)
        self.assertIn("torchaudio==2.3.1", dockerfile)
        self.assertIn("torchvision==0.18.1", dockerfile)
        self.assertNotIn("nvidia/cuda:", dockerfile)
        self.assertNotIn("python3.9", dockerfile)

    def test_health_is_blocked_when_assets_are_absent(self):
        app = load("anyapp_absent", "app.py")
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(app, "ASSETS", Path(directory)):
                payload = app.health_payload()
        self.assertEqual(payload["status"], "blocked")
        self.assertFalse(payload["ready"])
        self.assertFalse(payload["checkpointReady"])
        self.assertFalse(payload["smokeTested"])

    def test_artifact_capability_is_bound_to_name_and_expiry(self):
        app = load("anyapp_cap", "app.py")
        with mock.patch.dict("os.environ", {"ANYACCOMP_API_TOKEN": "test-token"}):
            first = app.artifact_capability("job/accompaniment.wav", 100)
            self.assertEqual(first, app.artifact_capability("job/accompaniment.wav", 100))
            self.assertNotEqual(
                first, app.artifact_capability("other/accompaniment.wav", 100)
            )
            self.assertNotEqual(
                first, app.artifact_capability("job/accompaniment.wav", 101)
            )


if __name__ == "__main__":
    unittest.main()