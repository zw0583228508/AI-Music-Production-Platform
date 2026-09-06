"""Focused offline contract tests for the isolated MusicGen deployment."""
from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class MusicGenConfigTest(unittest.TestCase):
    def test_manifest_has_only_pinned_source_and_short_resolution_inputs(self) -> None:
        manifest = json.loads((ROOT / "model_manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["source"]["revision"], "896ec7c47f5e5d1e5aa1e4b260c4405328bf009d")
        self.assertEqual(manifest["runtime"]["python"], "3.9")
        self.assertEqual(manifest["runtime"]["pytorch"], "2.1.0+cu118")
        self.assertEqual(manifest["models"]["text"]["requested_revision"], "15ccdc9")
        self.assertEqual(manifest["models"]["melody"]["requested_revision"], "6fdf8d3")
        self.assertIsNone(manifest["models"]["text"]["resolved_revision"])
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

    def test_jasco_contract_is_registered_and_fail_closed(self) -> None:
        source = (ROOT / "app.py").read_text(encoding="utf-8")
        smoke = (ROOT / "smoke.py").read_text(encoding="utf-8")
        self.assertIn('@app.get("/providers")', source)
        self.assertIn('@app.post("/jasco")', source)
        self.assertIn("JASCO requires finite 12-bin chroma", source)
        self.assertIn("JASCO requires drum or melody audio conditioning", source)
        self.assertIn('proof["jasco"]["nonSilent"] is True', source)
        self.assertIn("MUSICGEN_JASCO_DRUM_SMOKE_AUDIO", smoke)
        self.assertIn("jasco_not_copy", smoke)