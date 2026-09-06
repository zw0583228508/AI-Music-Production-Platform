import json
import importlib.util
import os
import tempfile
import unittest
from contextlib import chdir
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request


ROOT = Path(__file__).parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SongFormerLicenseBlockTests(unittest.TestCase):
    def test_songformer_model_and_license_identities_are_immutable(self):
        model = json.loads((ROOT / "model_manifest.json").read_text())
        license_data = json.loads((ROOT / "license_manifest.json").read_text())
        status = json.loads((ROOT / "installation-status.json").read_text())
        review = json.loads(
            (ROOT / "release-evidence" / "license-review-v1.json").read_text()
        )
        stop = json.loads(
            (ROOT / "release-evidence" / "modal-app-stopped-v1.json").read_text()
        )
        self.assertEqual(status["schemaVersion"], 1)
        self.assertEqual(model["provider"], "SONGFORMER")
        self.assertEqual(
            model["source"]["commit"],
            "139b2aa3b14bd1c6d961d0994e9fc975f1ef7fd5",
        )
        self.assertEqual(
            {
                (item["path"], item["repository"], item["commit"])
                for item in model["source"]["submodules"]
            },
            {
                (
                    "src/third_party/MuQ",
                    "https://github.com/tencent-ailab/MuQ.git",
                    "28847ea50cd31ac4b8b6a7dacc051ad7d1c7606a",
                ),
                (
                    "src/third_party/musicfm",
                    "https://github.com/minzwon/musicfm.git",
                    "b83ebedb401bcef639b26b05c0c8bee1dc2dfe71",
                ),
            },
        )
        self.assertEqual(
            {
                (
                    item["component"],
                    item["repository"],
                    item["revision"],
                    item["path"],
                    item["remoteBytes"],
                    item["remoteSha256"],
                    item.get("upstreamMd5"),
                    item["locallyVerified"],
                )
                for item in model["assets"]
            },
            {
                (
                    "SONGFORMER",
                    "ASLP-lab/SongFormer",
                    "a75880ed1b7375ac71860ec6c4fc9c899cf99515",
                    "SongFormer.safetensors",
                    104468437,
                    "87f17bfbed37014c6af4314abd9eb6971a94e3a95e9fc70f9e5ee33bdacb487b",
                    "5a24800e12ab357744f8b47e523ba3e6",
                    False,
                ),
                (
                    "SONGFORMER",
                    "ASLP-lab/SongFormer",
                    "a75880ed1b7375ac71860ec6c4fc9c899cf99515",
                    "SongFormer.pt",
                    104493286,
                    "25d749cc9a51dc0a999ea61c5c7ff42df7ed8ba95295a0530a82430f9483c14c",
                    "2c66c0bb91364e318e90dbc2d9a79ee2",
                    False,
                ),
                (
                    "MUSICFM",
                    "minzwon/MusicFM",
                    "4513b38bc25ad1d227b1980819b9691ba97f4d87",
                    "pretrained_msd.pt",
                    1316802088,
                    "218b483a0256ddef736267425fabb166fd97008983696bb9270def464b47bded",
                    "df930aceac8209818556c4a656a0714c",
                    False,
                ),
                (
                    "MUSICFM",
                    "minzwon/MusicFM",
                    "4513b38bc25ad1d227b1980819b9691ba97f4d87",
                    "msd_stats.json",
                    2277,
                    "c36c61ab10ca4d2e7fdfefc3fcc15205316bec276a06a47baa3641a62c546f22",
                    "75ab2e47b093e07378f7f703bdb82c14",
                    False,
                ),
                (
                    "MUQ",
                    "OpenMuQ/MuQ-large-msd-iter",
                    "0562a57814f6f8bbd9fdea0a25921a2fce1a841a",
                    "model.safetensors",
                    1333825096,
                    "273febab2be02872c37d2c37e48a9d6c52c1c9392f3eeeabd498efa281ccb7a6",
                    None,
                    False,
                ),
                (
                    "MUQ",
                    "OpenMuQ/MuQ-large-msd-iter",
                    "0562a57814f6f8bbd9fdea0a25921a2fce1a841a",
                    "config.json",
                    3133,
                    "237335ee27d8fb951ce778701a12a79e06c51ae636dd786f97e45f51ce532543",
                    None,
                    False,
                ),
            },
        )
        self.assertEqual(model["licenseGate"]["status"], "BLOCKED_LICENSE")
        self.assertIs(model["licenseGate"]["provisioningAllowed"], False)
        self.assertIs(model["licenseGate"]["deploymentAllowed"], False)
        self.assertEqual(license_data["classification"], "BLOCKED_LICENSE")
        self.assertEqual(
            license_data["components"]["musicfm"]["checkpointLicense"],
            "UNVERIFIED",
        )
        self.assertEqual(
            license_data["components"]["muq"]["checkpointLicense"],
            "CC-BY-NC-4.0",
        )
        self.assertIs(
            license_data["overall"]["researchDeploymentAllowed"],
            False,
        )
        self.assertEqual(
            license_data["components"]["songformer"]["sourceCommit"],
            model["source"]["commit"],
        )
        self.assertEqual(
            license_data["components"]["songformer"]["modelRevision"],
            model["modelSources"]["songformer"]["revision"],
        )
        self.assertEqual(
            license_data["components"]["musicfm"]["modelRevision"],
            model["modelSources"]["musicfm"]["revision"],
        )
        self.assertEqual(
            license_data["components"]["muq"]["modelRevision"],
            model["modelSources"]["muq"]["revision"],
        )
        self.assertEqual(review["conclusion"], status["providers"]["SONGFORMER"]["classification"])
        self.assertEqual(
            review["musicfm"]["checkpoint"]["remoteSha256"],
            next(
                item["remoteSha256"]
                for item in model["assets"]
                if item["component"] == "MUSICFM"
                and item["path"] == "pretrained_msd.pt"
            ),
        )
        self.assertEqual(
            review["deployment"]["observationSha256"],
            status["providers"]["SONGFORMER"]["evidence"][
                "modalStopObservationSha256"
            ],
        )
        self.assertEqual(
            stop["recordSha256"],
            "a4f1070637935c24d2cb099e727d4a427aaf083a81fe8cdd201dcb41a708f3a4",
        )

    def test_bootstrap_rejects_before_any_provisioning_work(self):
        bootstrap = load_module(
            "songformer_bootstrap_test",
            ROOT / "bootstrap_assets.py",
        )
        with tempfile.TemporaryDirectory() as directory, chdir(directory):
            with self.assertRaises(bootstrap.SongFormerLicenseBlocked):
                bootstrap.main()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_worker_health_and_analyze_are_fail_closed(self):
        worker = load_module("songformer_app_test", ROOT / "app.py")
        health = worker.health()
        self.assertEqual(health["status"], "blocked_license")
        self.assertIs(health["ready"], False)
        self.assertIs(health["runtimeReady"], False)
        self.assertIs(health["checkpointReady"], False)
        self.assertIs(health["smokeTested"], False)
        request = worker.AnalyzeRequest(
            provider="SONGFORMER",
            sourceUrl="https://example.invalid/song.wav",
        )
        with self.assertRaises(HTTPException) as failure:
            worker.analyze(request)
        self.assertEqual(failure.exception.status_code, 503)
        self.assertIn("checkpoint rights", failure.exception.detail)

    def test_worker_auth_requires_a_token(self):
        worker = load_module("songformer_auth_test", ROOT / "app.py")
        request = Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/health",
                "headers": [],
            }
        )
        with patch.dict(
            os.environ,
            {"SONGFORMER_WORKER_TOKEN": "", "MUSIC_AI_WORKER_TOKEN": ""},
        ):
            with self.assertRaises(HTTPException) as failure:
                worker.auth(request)
        self.assertEqual(failure.exception.status_code, 401)

    def test_modal_module_exposes_no_remote_or_web_function_while_blocked(self):
        source = (ROOT / "modal_app.py").read_text()
        self.assertNotIn("@modal.asgi_app", source)
        self.assertNotIn("@app.function", source)
        self.assertNotIn("Volume.from_name", source)
        self.assertNotIn("Image.from_dockerfile", source)


if __name__ == "__main__":
    unittest.main()