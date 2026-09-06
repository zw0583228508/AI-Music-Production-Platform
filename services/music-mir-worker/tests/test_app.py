import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import app


TOKEN = "test-worker-token"


def valid_marker(provider: str) -> dict:
    record = app.MANIFEST["providers"][provider]
    evidence = {
        "MADMOM": {
            "beatCount": 40,
            "downbeatCount": 10,
            "tempoBpm": 120.0,
            "activationFrames": 1500,
        },
        "TORCHCREPE": {
            "model": "full",
            "frameCount": 100,
            "voicedFrameCount": 80,
            "minFrequencyHz": 100.0,
            "maxFrequencyHz": 500.0,
            "meanPeriodicity": 0.75,
        },
        "PYLOUDNORM": {
            "integratedLUFS": -14.2,
            "loudnessRange": 3.1,
            "samplePeak": 0.9,
        },
        "ESSENTIA": {
            "key": "A",
            "scale": "minor",
            "confidence": 0.9,
            "hpcpBins": 12,
            "hpcpFinite": True,
        },
        "CHROMA": {
            "frameCount": 32,
            "beatCount": 33,
            "librosaChromaFrames": 1000,
            "essentiaHpcpBins": 12,
            "probabilitiesNormalized": True,
            "candidateChordFrames": 32,
        },
    }[provider]
    return {
        "schemaVersion": 2,
        "provider": provider,
        "modelVersion": record["modelVersion"],
        "identitySha256": app._provider_identity_sha256(provider),
        "workerSourceTreeSha256": record["workerSourceTreeSha256"],
        "packageTrees": record["installedPackageTrees"],
        "runtime": record["runtime"],
        "sourceFixture": {
            "sha256": "1" * 64,
            "bytes": 1000,
            "durationSeconds": 45.0,
            "retained": True,
        },
        "evaluationFixture": {
            "sha256": "2" * 64,
            "bytes": 500,
            "durationSeconds": 15.0,
            "retained": False,
        },
        "featureExecutionSucceeded": True,
        "resultSha256": "3" * 64,
        "evidence": evidence,
    }


class WorkerTests(unittest.TestCase):
    def test_health_requires_authentication(self):
        request = type("Request", (), {"headers": {}})()
        with patch.dict("os.environ", {"MIR_WORKER_TOKEN": TOKEN}, clear=False):
            with self.assertRaises(HTTPException) as raised:
                app._auth(request)
        self.assertEqual(raised.exception.status_code, 401)

    def test_runtime_exposes_only_explicitly_enabled_providers(self):
        disabled = app.ALL_PROVIDERS[-1]
        enabled = tuple(provider for provider in app.ALL_PROVIDERS if provider != disabled)
        with patch.object(app, "PROVIDERS", enabled), self.assertRaises(HTTPException) as raised:
            app._require_enabled(disabled)
        self.assertEqual(raised.exception.status_code, 404)

    def test_exact_marker_contract_accepts_all_provider_evidence_and_rejects_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(app, "READINESS_ROOT", root):
                for provider in app.ALL_PROVIDERS:
                    marker = valid_marker(provider)
                    (root / f"{provider.lower()}.json").write_text(json.dumps(marker))
                    self.assertTrue(app._execution_ready(provider))
                    marker["identitySha256"] = "0" * 64
                    (root / f"{provider.lower()}.json").write_text(json.dumps(marker))
                    self.assertFalse(app._execution_ready(provider))

    def test_package_tree_drift_is_not_ready(self):
        manifest = {
            "providers": {
                "MADMOM": {
                    "runtime": {
                        "python": sys.version.split()[0],
                        "packages": {},
                        "requirementsLockSha256": "a" * 64,
                    },
                    "installedPackageTrees": {
                        "fake-package": {
                            "version": "1.0",
                            "sha256": "a" * 64,
                            "files": 1,
                            "bytes": 1,
                        }
                    },
                }
            }
        }
        with (
            patch.object(app, "MANIFEST", manifest),
            patch.object(app, "RUNTIME_LOCK_PATH", Path(__file__)),
            patch.object(app, "_file_sha256", return_value="a" * 64),
            patch.object(app, "_distribution_tree", return_value={
                "version": "1.0",
                "sha256": "b" * 64,
                "files": 1,
                "bytes": 1,
            }),
        ):
            ready, reason = app._package_ready("MADMOM")
        self.assertFalse(ready)
        self.assertIn("package tree", reason)

    def test_package_tree_is_rechecked_after_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock = Path(temporary) / "requirements.lock"
            lock.write_text("locked-runtime")
            expected_tree = {
                "version": "1.0",
                "sha256": "a" * 64,
                "files": 1,
                "bytes": 1,
            }
            drifted_tree = {**expected_tree, "sha256": "b" * 64}
            record = copy.deepcopy(app.MANIFEST["providers"]["MADMOM"])
            record["runtime"]["python"] = sys.version.split()[0]
            record["runtime"]["packages"] = {}
            record["runtime"]["requirementsLockSha256"] = app._file_sha256(lock)
            record["installedPackageTrees"] = {"fake-package": expected_tree}
            manifest = {
                **app.MANIFEST,
                "providers": {**app.MANIFEST["providers"], "MADMOM": record},
            }
            with (
                patch.object(app, "MANIFEST", manifest),
                patch.object(app, "RUNTIME_LOCK_PATH", lock),
                patch.object(
                    app,
                    "_distribution_tree",
                    side_effect=[expected_tree, drifted_tree],
                ) as distribution_tree,
            ):
                ready, reason = app._package_ready("MADMOM")
                self.assertTrue(ready, reason)
                ready, reason = app._package_ready("MADMOM")
        self.assertFalse(ready)
        self.assertIn("package tree", reason)
        self.assertEqual(distribution_tree.call_count, 2)

    def test_runtime_lock_drift_is_rechecked_after_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock = Path(temporary) / "requirements.lock"
            lock.write_text("locked-runtime")
            record = copy.deepcopy(app.MANIFEST["providers"]["MADMOM"])
            record["runtime"]["python"] = sys.version.split()[0]
            record["runtime"]["packages"] = {}
            record["runtime"]["requirementsLockSha256"] = app._file_sha256(lock)
            record["installedPackageTrees"] = {}
            manifest = {
                **app.MANIFEST,
                "providers": {**app.MANIFEST["providers"], "MADMOM": record},
            }
            with (
                patch.object(app, "MANIFEST", manifest),
                patch.object(app, "RUNTIME_LOCK_PATH", lock),
            ):
                ready, reason = app._package_ready("MADMOM")
                self.assertTrue(ready, reason)
                lock.write_text("drifted-runtime")
                ready, reason = app._package_ready("MADMOM")
        self.assertFalse(ready)
        self.assertIn("requirements lock", reason)

    def test_worker_source_tree_is_rehashed_after_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            worker = root / "worker.py"
            worker.write_text("verified")
            manifest = {**app.MANIFEST, "workerSourceFiles": ["worker.py"]}
            with patch.object(app, "MANIFEST", manifest), patch.object(app, "ROOT", root):
                verified = app._worker_source_tree_sha256()
                worker.write_text("drifted")
                drifted = app._worker_source_tree_sha256()
        self.assertNotEqual(verified, drifted)

    def test_model_asset_drift_is_not_ready(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "model.bin"
            model.write_bytes(b"verified-model")
            record = copy.deepcopy(app.MANIFEST["providers"]["MADMOM"])
            record["model"]["artifacts"] = [{
                "location": "asset-root",
                "path": "model.bin",
                "bytes": len(b"verified-model"),
                "sha256": app.hashlib.sha256(b"verified-model").hexdigest(),
            }]
            manifest = {**app.MANIFEST, "providers": {**app.MANIFEST["providers"], "MADMOM": record}}
            with patch.object(app, "MANIFEST", manifest), patch.object(app, "ASSET_ROOT", root):
                self.assertTrue(app._model_assets_ready("MADMOM"))
                model.write_bytes(b"drifted-model")
                self.assertFalse(app._model_assets_ready("MADMOM"))

    def test_identity_drift_blocks_before_source_decode(self):
        provider = app.PROVIDERS[0]
        request = app.AnalysisRequest(
            provider=provider,
            sourceUrl="https://example.com/private.wav",
        )
        with (
            patch.object(app, "_identity_ready", return_value=(False, "identity drift")),
            patch.object(app, "_decode") as decode,
        ):
            with self.assertRaises(HTTPException) as raised:
                app.analyze(request)
        self.assertEqual(raised.exception.status_code, 503)
        decode.assert_not_called()

    def test_smoke_evidence_drift_blocks_before_source_decode(self):
        provider = app.PROVIDERS[0]
        request = app.AnalysisRequest(
            provider=provider,
            sourceUrl="https://example.com/private.wav",
        )
        with (
            patch.object(app, "_identity_ready", return_value=(True, None)),
            patch.object(app, "_execution_marker", return_value=(None, "smoke drift")),
            patch.object(app, "_decode") as decode,
        ):
            with self.assertRaises(HTTPException) as raised:
                app.analyze(request)
        self.assertEqual(raised.exception.status_code, 503)
        decode.assert_not_called()

    def test_path_and_body_provider_must_match(self):
        first = app.PROVIDERS[0]
        second = next(provider for provider in app.ALL_PROVIDERS if provider != first)
        request = app.AnalysisRequest(provider=second, audioBase64="YWJj")
        with self.assertRaises(HTTPException) as raised:
            app.analyze_provider(first, request)
        self.assertEqual(raised.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()