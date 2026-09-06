import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("mt3_family_bootstrap", ROOT / "mt3_family_bootstrap.py")
bootstrap = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = bootstrap
SPEC.loader.exec_module(bootstrap)


class Mt3FamilyBootstrapTests(unittest.TestCase):
    def test_fixture_is_exact_nonempty_32_second_wav(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = bootstrap.write_structured_smoke_fixture(Path(temporary))
            import wave
            with wave.open(str(fixture), "rb") as audio:
                self.assertEqual(audio.getframerate(), 44_100)
                self.assertEqual(audio.getnframes(), 44_100 * 32)
                self.assertEqual(audio.getnchannels(), 1)

    def test_yourmt3_fixture_is_native_rate_note_on_off_phrase(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = bootstrap.write_smoke_fixture("YOUR_MT3", Path(temporary))
            import wave
            with wave.open(str(fixture), "rb") as audio:
                self.assertEqual(audio.getframerate(), 16_000)
                self.assertEqual(audio.getnframes(), 16_000 * 12)
                self.assertEqual(audio.getnchannels(), 1)
            self.assertEqual(
                bootstrap.tree_sha256(fixture),
                "d32d6565800021f93f7904cf576c696c0f5d0f45bb8dc7b1badd0dc53cab69b7",
            )

    def test_yourmt3_smoke_subprocess_receives_exact_fixture_pin(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint = root / str(bootstrap.PROVIDERS["YOUR_MT3"]["checkpoint"])
            checkpoint.parent.mkdir(parents=True)
            checkpoint.write_bytes(b"reviewed checkpoint")
            checkpoint_sha256 = bootstrap.tree_sha256(checkpoint)
            observed_environment = {}

            def fake_run(command, **options):
                self.assertEqual(command[2], "runners.your_mt3")
                observed_environment.update(options["env"])
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({
                        "smokeTested": True,
                        "provider": "YOUR_MT3",
                        "checkpointSha256": checkpoint_sha256,
                        "output": {"notes": 1},
                    }),
                    stderr="",
                )

            with mock.patch.object(
                bootstrap.subprocess, "run", side_effect=fake_run
            ):
                evidence = bootstrap.run_smoke(
                    "YOUR_MT3", root, checkpoint, checkpoint_sha256
                )

            expected = bootstrap.PROVIDERS["YOUR_MT3"]["smoke_input_sha256"]
            self.assertEqual(
                observed_environment[
                    "MUSIC_PROVIDER_YOUR_MT3_SMOKE_INPUT_SHA256"
                ],
                expected,
            )
            self.assertEqual(evidence["fixtureSha256"], expected)

    def test_yourmt3_generated_fixture_hash_drift_stops_before_runner(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint = root / str(bootstrap.PROVIDERS["YOUR_MT3"]["checkpoint"])
            checkpoint.parent.mkdir(parents=True)
            checkpoint.write_bytes(b"reviewed checkpoint")
            checkpoint_sha256 = bootstrap.tree_sha256(checkpoint)
            with mock.patch.dict(
                bootstrap.PROVIDERS["YOUR_MT3"],
                {"smoke_input_sha256": "0" * 64},
            ), mock.patch.object(bootstrap.subprocess, "run") as run:
                with self.assertRaisesRegex(
                    RuntimeError, "generated smoke fixture SHA-256 mismatch"
                ):
                    bootstrap.run_smoke(
                        "YOUR_MT3", root, checkpoint, checkpoint_sha256
                    )
            run.assert_not_called()

    def test_bootstrap_records_observed_hash_only_after_smoke(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def fake_run(command, **_):
                if command == ["mt3-infer", "download", "mr_mt3"]:
                    target = root / "mr_mt3"
                    target.mkdir()
                    (target / "mt3.pth").write_bytes(b"reviewed bytes")
                    return SimpleNamespace(returncode=0, stdout="", stderr="")
                self.assertEqual(command[2], "runners.mr_mt3")
                digest = bootstrap.tree_sha256(root / "mr_mt3" / "mt3.pth")
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({
                        "smokeTested": True, "provider": "MR_MT3",
                        "checkpointSha256": digest, "output": {"notes": 1},
                    }),
                    stderr="",
                )

            with mock.patch.object(bootstrap.subprocess, "run", side_effect=fake_run):
                evidence = bootstrap.bootstrap("MR_MT3", root)
            self.assertEqual(evidence["provider"], "MR_MT3")
            self.assertEqual(evidence["toolkitModelId"], "mr_mt3")
            self.assertEqual(evidence["checkpointPath"], "mr_mt3/mt3.pth")
            self.assertEqual(len(evidence["inventory"]), 1)
            self.assertEqual(evidence["smoke"]["notes"], 1)
            persisted = json.loads((root / "_attestations" / "mr-mt3.json").read_text())
            self.assertEqual(persisted["checkpointSha256"], evidence["checkpointSha256"])

    def test_invalid_smoke_proof_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint = root / "mr_mt3"
            checkpoint.mkdir()
            checkpoint = checkpoint / "mt3.pth"
            checkpoint.write_bytes(b"x")
            with mock.patch.object(
                bootstrap.subprocess, "run",
                return_value=SimpleNamespace(returncode=0, stdout="{}", stderr=""),
            ):
                with self.assertRaisesRegex(RuntimeError, "evidence failed validation"):
                    bootstrap.run_smoke("MR_MT3", root, checkpoint, bootstrap.tree_sha256(checkpoint))

    def test_yourmt3_uses_exact_upstream_registry_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / str(bootstrap.PROVIDERS["YOUR_MT3"]["checkpoint"])
            path.parent.mkdir(parents=True)
            path.write_bytes(b"yourmt3 checkpoint")
            inventory = bootstrap.observed_inventory(root)
            selected = bootstrap.selected_checkpoint("YOUR_MT3", root, inventory)
            self.assertEqual(selected, path)

    def test_yourmt3_reuses_only_the_reviewed_immutable_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            details = bootstrap.PROVIDERS["YOUR_MT3"]
            target = root / str(details["checkpoint"])
            target.parent.mkdir(parents=True)
            reviewed = b"reviewed bytes"
            target.write_bytes(reviewed)
            with mock.patch.dict(
                details,
                {
                    "checkpoint_bytes": len(reviewed),
                    "checkpoint_sha256": bootstrap.tree_sha256(target),
                },
            ), mock.patch.object(bootstrap.urllib.request, "urlopen") as download:
                bootstrap.provision_checkpoint("YOUR_MT3", root)
            download.assert_not_called()

    def test_layout_mismatch_has_bounded_observed_diagnostic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "unrelated").write_bytes(b"x")
            with self.assertRaisesRegex(RuntimeError, "observed-layout mismatch") as error:
                bootstrap.selected_checkpoint("MR_MT3", root, bootstrap.observed_inventory(root))
            self.assertLessEqual(len(str(error.exception)), 2200)

    def test_other_provider_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            selected = root / "mr_mt3" / "mt3.pth"
            selected.parent.mkdir()
            selected.write_bytes(b"mr")
            unrelated = root / "yourmt3" / "other.ckpt"
            unrelated.parent.mkdir()
            unrelated.write_bytes(b"your")
            with self.assertRaisesRegex(RuntimeError, "unexpectedOtherProviderFiles"):
                bootstrap.selected_checkpoint(
                    "MR_MT3", root, bootstrap.observed_inventory(root)
                )

    def test_smoke_failure_contains_bounded_sanitized_stderr(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint = root / "mr_mt3" / "mt3.pth"
            checkpoint.parent.mkdir()
            checkpoint.write_bytes(b"x")
            terminal = " TERMINAL_EXCEPTION: YourMT3DecoderFailure"
            stderr = (
                "CUDA loader failed\x00 authorization: bearer-secret "
                + ("x" * 5000)
                + terminal
                + ("y" * 5000)
            )
            with mock.patch.object(
                bootstrap.subprocess, "run",
                return_value=SimpleNamespace(returncode=9, stdout="", stderr=stderr),
            ):
                with self.assertRaisesRegex(RuntimeError, "CUDA loader failed") as error:
                    bootstrap.run_smoke(
                        "MR_MT3", root, checkpoint, bootstrap.tree_sha256(checkpoint)
                    )
            message = str(error.exception)
            self.assertNotIn("bearer-secret", message)
            self.assertNotIn("\x00", message)
            self.assertIn("TERMINAL_EXCEPTION: YourMT3DecoderFailure", message)
            self.assertGreater(len(message), bootstrap.MAX_DIAGNOSTIC_CHARS)
            self.assertLessEqual(
                len(message), bootstrap.RUNNER_DIAGNOSTIC_CHARS + 100
            )

    def test_non_runner_provisioning_diagnostics_keep_the_smaller_bound(self):
        diagnostic = bootstrap.bounded_diagnostic("x" * 10_000)
        self.assertEqual(len(diagnostic), bootstrap.MAX_DIAGNOSTIC_CHARS)