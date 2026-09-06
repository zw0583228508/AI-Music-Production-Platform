"""Focused offline contract tests for the isolated MusicGen deployment."""
from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class MusicGenConfigTest(unittest.TestCase):
    def test_manifest_has_pinned_source_and_model_revisions(self) -> None:
        manifest = json.loads((ROOT / "model_manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["source"]["revision"], "896ec7c47f5e5d1e5aa1e4b260c4405328bf009d")
        self.assertEqual(manifest["runtime"]["python"], "3.9")
        self.assertEqual(manifest["runtime"]["pytorch"], "2.1.0+cu118")
        self.assertEqual(manifest["models"]["text"]["requested_revision"], "15ccdc9")
        self.assertEqual(manifest["models"]["melody"]["requested_revision"], "6fdf8d3")
        self.assertEqual(manifest["models"]["text"]["resolved_revision"], "15ccdc92099879e47b6da12c350cdb71d4eab3ca")
        self.assertEqual(manifest["models"]["melody"]["resolved_revision"], "6fdf8d3d815995108c9bdb5183414ff464b171ac")
        self.assertNotIn("main", [item["requested_revision"] for item in manifest["models"].values()
                                  if isinstance(item["requested_revision"], str)])
        jasco = manifest["models"]["jasco"]
        self.assertEqual(jasco["provider_id"], "JASCO_CHORDS_DRUMS_MELODY")
        self.assertEqual(jasco["repository"], "facebook/jasco")
        self.assertEqual(jasco["status"], "BLOCKED_NO_WEIGHTS")
        self.assertIsNone(jasco["requested_revision"])
        self.assertIn("JASCO_CHORDS_DRUMS_MELODY", manifest["provider_registry"])

    def test_private_volume_and_license_contract(self) -> None:
        spec = importlib.util.spec_from_file_location("musicgen_config", ROOT / "modal_config.py")
        assert spec and spec.loader
        config = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(config)
        self.assertEqual(config.RUNTIME_SECRET_NAME, "music-ai-worker-runtime")
        self.assertNotEqual(config.RUNTIME_SECRET_NAME, config.LICENSE_SECRET_NAME)
        self.assertIn("private", config.MODEL_VOLUME_NAME)
        self.assertIn("private", config.SMOKE_VOLUME_NAME)
        self.assertIn("HF_HUB_OFFLINE", config.worker_environment())
        self.assertTrue(config.image_evidence().startswith("sha256:"))

    def test_control_and_workload_interpreters_are_separate(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        modal_app = (ROOT / "modal_app.py").read_text(encoding="utf-8")
        provision = (ROOT / "modal_provision.py").read_text(encoding="utf-8")
        self.assertNotIn('ENV PATH="/opt/musicgen-venv/bin:${PATH}"', dockerfile)
        self.assertIn("@modal.web_server(port=8015)", modal_app)
        self.assertNotIn("from app import", modal_app)
        self.assertIn('"/opt/musicgen-venv/bin/python", "-m", "uvicorn"', modal_app)
        self.assertNotIn("from app import", provision)
        self.assertNotIn("from smoke import", provision)
        self.assertIn('"/opt/musicgen-venv/bin/python", "/app/workload_entrypoint.py"', provision)

    def test_workload_launches_are_argument_lists_without_shell_interpolation(self) -> None:
        config_spec = importlib.util.spec_from_file_location("musicgen_config_for_path", ROOT / "modal_config.py")
        assert config_spec and config_spec.loader
        config = importlib.util.module_from_spec(config_spec)
        config_spec.loader.exec_module(config)
        environment = config.workload_environment()
        self.assertTrue(environment["PATH"].startswith("/opt/musicgen-venv/bin:"))
        source = (ROOT / "modal_provision.py").read_text(encoding="utf-8")
        self.assertIn("subprocess.run(", source)
        self.assertIn("check=False", source)
        self.assertNotIn("shell=True", source)

    def test_blocked_jasco_has_no_executable_path_and_cannot_follow_musicgen_readiness(self) -> None:
        source = (ROOT / "app.py").read_text(encoding="utf-8")
        self.assertIn('@app.get("/providers")', source)
        self.assertIn('@app.post("/jasco")', source)
        self.assertIn('SPEC["models"]["jasco"].get("status") == "BLOCKED_NO_WEIGHTS"', source)
        self.assertIn("JASCO is BLOCKED_NO_WEIGHTS", source)
        self.assertNotIn("from audiocraft.models import JASCO", source)
        self.assertNotIn("def _generate_jasco", source)
        jasco_handler = source[source.index("def jasco("):source.index('@app.get("/artifacts/{artifact_id}")')]
        self.assertNotIn("asset_state()", jasco_handler)
        self.assertNotIn("smoke_state()", jasco_handler)

    def test_installation_status_acknowledges_pins_without_claiming_provisioning(self) -> None:
        status = json.loads((ROOT / "installation-status.json").read_text(encoding="utf-8"))
        manifest = json.loads((ROOT / "model_manifest.json").read_text(encoding="utf-8"))
        for provider, model_key in (("MUSICGEN_LARGE", "text"), ("MUSICGEN_MELODY_LARGE", "melody")):
            record = status["providers"][provider]
            self.assertEqual(record["classification"], "BLOCKED_NO_WEIGHTS")
            self.assertEqual(record["evidence"]["resolvedModelRevision"],
                             manifest["models"][model_key]["resolved_revision"])
            self.assertFalse(record["evidence"]["assetInventoryPresent"])
            self.assertFalse(record["evidence"]["realSmokeProofPresent"])
            self.assertFalse(record["evidence"]["deploymentCompleted"])
            self.assertFalse(record["evidence"]["endpointOrApiCompleted"])
