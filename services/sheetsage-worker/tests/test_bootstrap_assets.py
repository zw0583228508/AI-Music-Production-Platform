import hashlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.asset_root = Path(self.temporary.name) / "assets"
        spec = importlib.util.spec_from_file_location("bootstrap_assets_test", ROOT / "bootstrap_assets.py")
        self.bootstrap = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"SHEETSAGE_ASSET_ROOT": str(self.asset_root)}):
            spec.loader.exec_module(self.bootstrap)
        self.original_hashes = self.bootstrap.SPEC["required_asset_sha256"]
        self.files = {"sheetsage/model.pt": b"sheet", "madmom_infer/models/downbeats/model.pkl": b"beat"}
        self.bootstrap.SPEC["required_asset_sha256"] = {
            name: hashlib.sha256(content).hexdigest() for name, content in self.files.items()
        }
        self.bootstrap.SPEC["recovery"]["required_asset_count"] = len(self.files)

    def tearDown(self):
        self.bootstrap.SPEC["required_asset_sha256"] = self.original_hashes
        self.temporary.cleanup()

    def archive(self, files=None):
        path = Path(self.temporary.name) / "source.tar"
        with tarfile.open(path, "w") as bundle:
            for name, content in (files or self.files).items():
                info = tarfile.TarInfo(name)
                info.size = len(content)
                bundle.addfile(info, io.BytesIO(content))
        return path

    def environment(self, archive):
        return {
            self.bootstrap.SPEC["license"]["acceptance_environment"]:
                self.bootstrap.SPEC["license"]["required_value"],
            self.bootstrap.SPEC["recovery"]["source_environment"]: archive.as_uri(),
            self.bootstrap.SPEC["recovery"]["sha256_environment"]:
                hashlib.sha256(archive.read_bytes()).hexdigest(),
        }

    def test_restores_every_manifest_asset_and_inventory(self):
        archive = self.archive()
        with patch.dict(os.environ, self.environment(archive), clear=False):
            self.bootstrap.restore_from_recovery_source()
        inventory = json.loads((self.asset_root / "assets.manifest.json").read_text())
        self.assertEqual({entry["path"] for entry in inventory["assets"]}, set(self.files))
        for name, content in self.files.items():
            self.assertEqual((self.asset_root / name).read_bytes(), content)

    def test_wrong_archive_checksum_leaves_live_assets_untouched(self):
        existing = self.asset_root / "sheetsage/model.pt"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"existing")
        archive = self.archive()
        environment = self.environment(archive)
        environment[self.bootstrap.SPEC["recovery"]["sha256_environment"]] = "0" * 64
        with patch.dict(os.environ, environment, clear=False), self.assertRaisesRegex(
            RuntimeError, "archive SHA-256 mismatch"
        ):
            self.bootstrap.restore_from_recovery_source()
        self.assertEqual(existing.read_bytes(), b"existing")
        self.assertFalse((self.asset_root / "assets.manifest.json").exists())

    def test_asset_hash_mismatch_leaves_live_assets_untouched(self):
        archive = self.archive({**self.files, "sheetsage/model.pt": b"wrong"})
        with patch.dict(os.environ, self.environment(archive), clear=False), self.assertRaisesRegex(
            RuntimeError, "asset SHA-256 mismatch"
        ):
            self.bootstrap.restore_from_recovery_source()
        self.assertFalse(self.asset_root.exists())

    def test_archive_must_contain_exact_manifest_inventory(self):
        archive = self.archive({**self.files, "extra.bin": b"not allowed"})
        with patch.dict(os.environ, self.environment(archive), clear=False), self.assertRaisesRegex(
            RuntimeError, "contents do not exactly match"
        ):
            self.bootstrap.restore_from_recovery_source()
        self.assertFalse(self.asset_root.exists())

    def test_drill_verifies_archive_without_touching_live_asset_root(self):
        existing = self.asset_root / "keep.txt"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"production")
        archive = self.archive()
        with patch.dict(os.environ, self.environment(archive), clear=False):
            result = self.bootstrap.drill_recovery_source()
        self.assertEqual(result["assets"], len(self.files))
        self.assertTrue(result["verified"])
        self.assertEqual(existing.read_bytes(), b"production")
        self.assertEqual([path for path in self.asset_root.rglob("*") if path.is_file()], [existing])

    def test_download_failure_does_not_expose_private_source(self):
        private_url = "https://private.example.invalid/archive?secret=restricted"
        environment = {
            self.bootstrap.SPEC["license"]["acceptance_environment"]:
                self.bootstrap.SPEC["license"]["required_value"],
            self.bootstrap.SPEC["recovery"]["source_environment"]: private_url,
            self.bootstrap.SPEC["recovery"]["sha256_environment"]: "0" * 64,
        }
        with patch.dict(os.environ, environment, clear=False), patch.object(
            self.bootstrap, "urlopen", side_effect=OSError(f"failed: {private_url}")
        ), self.assertRaises(RuntimeError) as raised:
            self.bootstrap.drill_recovery_source()
        self.assertNotIn(private_url, str(raised.exception))
        self.assertIsNone(raised.exception.__cause__)
        self.assertFalse(self.asset_root.exists())

    def test_cancelled_drill_discards_private_download_from_disposable_storage(self):
        private_url = "https://private.example.invalid/archive?secret=restricted"
        persistent_root = Path(self.temporary.name) / "persistent"
        disposable_root = Path(self.temporary.name) / "disposable"
        persistent_root.mkdir()
        disposable_root.mkdir()
        existing = self.asset_root / "keep.txt"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"production")
        drill_paths = []

        class DrillCancelled(BaseException):
            pass

        class InterruptedResponse(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_):
                self.close()

            def read(self, size=-1):
                if self.tell():
                    raise DrillCancelled(f"cancelled while reading {private_url}")
                return super().read(4 if size < 0 else min(size, 4))

        real_temporary_directory = tempfile.TemporaryDirectory

        def tracked_temporary_directory(*args, **kwargs):
            kwargs["dir"] = disposable_root
            temporary = real_temporary_directory(*args, **kwargs)
            drill_paths.append(Path(temporary.name))
            return temporary

        environment = {
            self.bootstrap.SPEC["license"]["acceptance_environment"]:
                self.bootstrap.SPEC["license"]["required_value"],
            self.bootstrap.SPEC["recovery"]["source_environment"]: private_url,
            self.bootstrap.SPEC["recovery"]["sha256_environment"]: "0" * 64,
        }
        with self.assertLogs(level=logging.DEBUG) as captured, patch.dict(
            os.environ, environment, clear=False
        ), patch.object(
            self.bootstrap.tempfile, "TemporaryDirectory", side_effect=tracked_temporary_directory
        ), patch.object(
            self.bootstrap, "urlopen", return_value=InterruptedResponse(b"private archive bytes")
        ), self.assertRaises(DrillCancelled) as raised:
            logging.debug("starting SheetSage recovery cancellation test")
            self.bootstrap.drill_recovery_source()

        self.assertEqual(len(drill_paths), 1)
        self.assertFalse(drill_paths[0].exists())
        self.assertEqual(list(disposable_root.iterdir()), [])
        self.assertEqual(list(persistent_root.iterdir()), [])
        self.assertEqual(existing.read_bytes(), b"production")
        self.assertEqual([path for path in self.asset_root.rglob("*") if path.is_file()], [existing])
        failure_output = "\n".join((*captured.output, str(raised.exception)))
        self.assertNotIn(private_url, failure_output)
        self.assertIsNone(raised.exception.__cause__)


if __name__ == "__main__":
    unittest.main()