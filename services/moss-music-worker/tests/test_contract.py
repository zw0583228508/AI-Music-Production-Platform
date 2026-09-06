from __future__ import annotations
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

def load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module

class MossMusicContractTest(unittest.TestCase):
    def test_two_immutable_identities_runtime_and_fixture(self):
        spec = json.loads((ROOT / "model_manifest.json").read_text())
        self.assertEqual(spec["source"]["revision"], "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e")
        self.assertEqual(set(spec["models"]), {"MOSS_MUSIC_INSTRUCT", "MOSS_MUSIC_THINKING"})
        self.assertNotEqual(*(model["revision"] for model in spec["models"].values()))
        self.assertTrue(all(len(model["revision"]) == 40 for model in spec["models"].values()))
        self.assertEqual(spec["runtime"]["torch"], "2.9.1+cu128")
        self.assertEqual(spec["runtime"]["torchaudio"], "2.9.1+cu128")
        self.assertEqual(spec["runtime"]["torchcodec"], "0.8.0")
        self.assertEqual(spec["runtime"]["torchcodec_wheel"]["variant"], "cpu")
        self.assertEqual(
            spec["runtime"]["torchcodec_wheel"]["sha256"],
            "2ec2e874dfb6fbf9bbeb792bea56317529636e78db175f56aad1e4efd6e12502",
        )
        self.assertEqual(spec["runtime"]["huggingfaceHub"], "0.36.2")
        self.assertEqual(spec["runtime"]["gradio"], "5.44.1")
        self.assertEqual(spec["runtime"]["pydantic"], "2.11.10")
        self.assertEqual(spec["runtime"]["ffmpeg"], "7.1.1")
        self.assertEqual(spec["smoke_input"]["sha256"], "460f18e2333b27d6aff92cf2dc8181232a34ef5d08212ae74240f1ca93561540")
        self.assertNotIn("main", json.dumps(spec))

    def test_private_offline_serving_configuration(self):
        config = load("moss_config", "modal_config.py")
        self.assertTrue(all("private" in value for value in (
            config.MODEL_VOLUME_NAME,
            config.SMOKE_VOLUME_NAME,
            config.OUTPUT_VOLUME_NAME,
        )))
        self.assertEqual(config.worker_environment()["HF_HUB_OFFLINE"], "1")
        self.assertEqual(config.worker_environment(online=True)["HF_HUB_OFFLINE"], "0")
        evidence_inputs = (ROOT / "modal_config.py").read_text()
        for required in ("compatibility.py", "modal_compatibility.py", "preflight.py", "modal_provision.py"):
            self.assertIn(required, evidence_inputs)

    def test_official_install_split_avoids_conflicting_extra(self):
        docker = (ROOT / "Dockerfile").read_text()
        self.assertIn("torchcodec-0.8.0-cp312-cp312-manylinux_2_28_x86_64.whl", docker)
        self.assertIn("sha256=2ec2e874dfb6fbf9bbeb792bea56317529636e78db175f56aad1e4efd6e12502", docker)
        self.assertIn("pip install -e /opt/moss-music", docker)
        self.assertNotIn('moss-music[torch-runtime]', docker)
        self.assertIn('moss-sglang/python[all]', docker)
        self.assertIn("/opt/moss-venv/bin/pip check", docker)
        self.assertNotIn("--no-deps", docker)
        self.assertNotIn("--force", docker)
        self.assertIn("m.version('torchcodec') == '0.8.0'", docker)
        self.assertIn("m.version('huggingface-hub') == '0.36.2'", docker)
        self.assertIn("m.version('gradio') == '5.44.1'", docker)
        self.assertNotIn("nvidia-cudnn-cu12==9.16.0.29", docker)
        self.assertIn("nvidia/cuda@sha256:ea73ae92", docker)
        self.assertNotIn("/app/preflight.py", docker)
        self.assertNotIn("COPY services/moss-music-worker/ /app/", docker)
        self.assertIn("COPY services/moss-music-worker/*.py /app/", docker)
        self.assertIn(
            "COPY services/moss-music-worker/Dockerfile "
            "services/moss-music-worker/requirements.txt /app/",
            docker,
        )
        compatibility_source = (ROOT / "compatibility.py").read_text()
        self.assertIn('read_text("direct_url.json")', compatibility_source)
        self.assertIn('"torchcodecWheel": _torchcodec_wheel_evidence()', compatibility_source)
        compatibility_probe = (ROOT / "modal_compatibility.py").read_text()
        self.assertIn("modal.Image.from_dockerfile", compatibility_probe)
        self.assertIn('"/app/compatibility.py"', compatibility_probe)
        self.assertIn("check=True", compatibility_probe)
        provision = (ROOT / "modal_provision.py").read_text()
        self.assertLess(
            provision.index('"/app/compatibility.py"'),
            provision.index('"/app/bootstrap_assets.py"'),
        )
        self.assertIn('"/app/compatibility.py"], env=environment, check=True', provision)

    def test_ffmpeg_prefix_and_full_media_preflight_contract(self):
        config = load("moss_config_media", "modal_config.py")
        environment = config.workload_environment()
        self.assertTrue(environment["PATH"].startswith("/opt/moss-ffmpeg/bin:"))
        self.assertTrue(environment["LD_LIBRARY_PATH"].startswith("/opt/moss-ffmpeg/lib"))
        preflight = (ROOT / "preflight.py").read_text()
        for required in ("import torchcodec", '("wav", wav_path)', '("mp3", mp3_path)',
                         "torchaudio.functional.resample", "torch.stack", '"tensorBatch"'):
            self.assertIn(required, preflight)

    def test_bootstrap_publishes_clean_content_addressed_generation(self):
        bootstrap = load("moss_bootstrap_test", "bootstrap_assets.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bootstrap.ASSETS = root
            bootstrap.SPEC = {
                "provider_family": "MOSS_MUSIC",
                "asset_manifest": "model-assets.json",
                "source": {"revision": "s" * 40},
                "runtime": {"torch": "2.9.1+cu128"},
                "models": {
                    "MOSS_MUSIC_INSTRUCT": {
                        "repository": "owner/model",
                        "revision": "a" * 40,
                        "role": "DIRECT_MUSICAL_SEMANTIC_REASONING",
                    },
                },
            }
            stale = root / ".staging" / f"MOSS_MUSIC_INSTRUCT-{os.getpid()}"
            stale.mkdir(parents=True)
            (stale / "stale.bin").write_bytes(b"stale")
            def snapshot_download(**arguments):
                destination = Path(arguments["local_dir"])
                destination.mkdir(parents=True, exist_ok=True)
                (destination / "weights.bin").write_bytes(b"real-model-bytes")
            fake_hub = types.SimpleNamespace(snapshot_download=snapshot_download)
            with mock.patch.dict(sys.modules, {"huggingface_hub": fake_hub}):
                bootstrap.main()
            manifest = json.loads((root / "model-assets.json").read_text())
            self.assertEqual(manifest["schemaVersion"], 2)
            self.assertIs(manifest["complete"], True)
            item = manifest["models"]["MOSS_MUSIC_INSTRUCT"]
            generation = root / item["path"]
            self.assertEqual((generation / "weights.bin").read_bytes(), b"real-model-bytes")
            self.assertFalse((generation / "stale.bin").exists())
            canonical = json.dumps(item["files"], separators=(",", ":"), sort_keys=True).encode()
            self.assertEqual(item["inventorySha256"], hashlib.sha256(canonical).hexdigest())

    def test_compatibility_and_smoke_proofs_fail_closed_on_drift(self):
        app = load("moss_app_test", "app.py")
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            os.environ, {"MOSS_MUSIC_IMAGE_EVIDENCE": "sha256:" + "f" * 64}
        ):
            root = Path(directory)
            app.ASSETS = root / "assets"
            app.SMOKE = root / "smoke"
            app.ASSETS.mkdir()
            app.SMOKE.mkdir()
            app.runtime_state = lambda: (True, "verified")
            packages = {
                key: app.SPEC["runtime"][key]
                for key in (
                    "torch", "torchaudio", "torchcodec", "transformers", "accelerate",
                    "huggingfaceHub", "gradio", "pydantic", "fastapi",
                )
            }
            compatibility = {
                "schemaVersion": 2,
                "providerFamily": "MOSS_MUSIC",
                "imageEvidence": "sha256:" + "f" * 64,
                "source": {**app.SPEC["source"], "install": "base-package-without-torch-runtime-extra"},
                "sglang": {**app.SPEC["sglang"], "install": "python[all]"},
                "runtime": app.SPEC["runtime"],
                "torchcodecWheel": app.SPEC["runtime"]["torchcodec_wheel"],
                "pipCheck": {"passed": True},
                "mediaPreflight": {
                    "passed": True,
                    "packages": packages,
                    "ffmpeg": "ffmpeg version 7.1.1",
                    "formats": {"wav": {}, "mp3": {}},
                    "tensorBatch": {"device": "cpu"},
                },
            }
            compatibility_path = app.SMOKE / app.SPEC["compatibility_evidence"]
            compatibility_path.write_text(json.dumps(compatibility, sort_keys=True))
            self.assertTrue(app.compatibility_state()[0])
            models = {}
            for provider, expected in app.SPEC["models"].items():
                model_root = app.ASSETS / provider
                model_root.mkdir()
                file_path = model_root / "weights.bin"
                file_path.write_bytes(provider.encode())
                files = [{
                    "path": "weights.bin",
                    "bytes": file_path.stat().st_size,
                    "sha256": hashlib.sha256(file_path.read_bytes()).hexdigest(),
                }]
                canonical = json.dumps(files, separators=(",", ":"), sort_keys=True).encode()
                models[provider] = {
                    **expected,
                    "path": provider,
                    "inventorySha256": hashlib.sha256(canonical).hexdigest(),
                    "files": files,
                }
            inventory = {
                "schemaVersion": 2,
                "complete": True,
                "source": app.SPEC["source"],
                "runtime": app.SPEC["runtime"],
                "models": models,
            }
            manifest_path = app.ASSETS / app.SPEC["asset_manifest"]
            manifest_path.write_text(json.dumps(inventory, sort_keys=True))
            proof_models = {}
            for provider, expected in app.SPEC["models"].items():
                response = f"Verified musical reasoning for {provider}."
                encoded = response.encode()
                proof_models[provider] = {
                    "providerId": provider,
                    "repository": expected["repository"],
                    "revision": expected["revision"],
                    "role": expected["role"],
                    "realInference": True,
                    "outputChannel": "MUSICAL_SEMANTIC_REASONING",
                    "semanticReasoning": response,
                    "responseBytes": len(encoded),
                    "responseSha256": hashlib.sha256(encoded).hexdigest(),
                }
            proof = {
                "schemaVersion": 2,
                "providerFamily": "MOSS_MUSIC",
                "source": app.SPEC["source"],
                "imageEvidence": "sha256:" + "f" * 64,
                "assetManifestSha256": app.sha(manifest_path),
                "compatibilityEvidenceSha256": app.compatibility_state()[2],
                "input": {**app.SPEC["smoke_input"], "realSong": True},
                "models": proof_models,
            }
            proof_path = app.SMOKE / app.SPEC["smoke_proof"]
            proof_path.write_text(json.dumps(proof, sort_keys=True))
            self.assertTrue(app.smoke_state()[0])
            proof["models"]["MOSS_MUSIC_THINKING"]["revision"] = "0" * 40
            proof_path.write_text(json.dumps(proof, sort_keys=True))
            self.assertFalse(app.smoke_state()[0])