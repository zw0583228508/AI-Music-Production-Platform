import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from license_gate import authorization_state, require_authorization
from inference import infer
import smoke


class ContractTest(unittest.TestCase):
    def test_immutable_research_only_contract(self):
        spec = json.loads((ROOT / "model_manifest.json").read_text())
        license_manifest = json.loads((ROOT / "license_manifest.json").read_text())
        self.assertEqual(spec["provider"], "LADA_BAND")
        self.assertEqual(license_manifest["license_status"], "UNVERIFIED")
        self.assertEqual(license_manifest["routing_status"], "BLOCKED_LICENSE")
        self.assertFalse(license_manifest["research_use_permitted"])
        self.assertFalse(license_manifest["commercial_use_permitted"])
        self.assertFalse(
            license_manifest["environment_values_are_authorization_evidence"]
        )
        self.assertTrue(
            all(len(spec[name]["revision"]) == 40 for name in ("source", "model"))
        )
        self.assertEqual(
            spec["model"]["required_trees"],
            ["checkpoints", "pretrained"],
        )

    def test_fail_closed_evidence_and_real_contract(self):
        app = (ROOT / "app.py").read_text()
        bootstrap = (ROOT / "bootstrap_assets.py").read_text()
        self.assertIn("invalid bearer token", app)
        self.assertIn("real-audio smoke", app)
        self.assertIn("artifactSha256", app)
        self.assertIn("tree_sha", bootstrap)
        self.assertLess(
            bootstrap.index(
                'require_authorization("LaDA-Band asset provisioning")'
            ),
            bootstrap.index("from huggingface_hub import snapshot_download"),
        )

    def test_environment_and_token_cannot_substitute_for_license_evidence(self):
        with patch.dict(
            os.environ,
            {
                "LADA_BAND_ACCEPT_NONCOMMERCIAL_RESEARCH": "accepted",
                "HF_TOKEN": "not-a-real-token",
            },
            clear=False,
        ):
            authorized, message = authorization_state()
            self.assertFalse(authorized)
            self.assertIn("BLOCKED_LICENSE", message)
            with self.assertRaisesRegex(RuntimeError, "BLOCKED_LICENSE"):
                require_authorization("test")

    def test_modal_paths_stop_before_modal_import_or_gpu_allocation(self):
        for name in ("modal_provision.py", "modal_app.py"):
            source = (ROOT / name).read_text()
            self.assertLess(
                source.index("require_authorization("),
                source.index("import modal"),
            )

    def test_inference_boundary_executes_zero_subprocesses_while_blocked(self):
        with patch("inference.subprocess.run") as run:
            with self.assertRaisesRegex(RuntimeError, "BLOCKED_LICENSE"):
                infer(
                    b"not-reached",
                    Path("/tmp/not-created.wav"),
                    Path("/tmp/not-read"),
                    None,
                    None,
                )
            run.assert_not_called()

    def test_smoke_entry_executes_zero_inference_while_blocked(self):
        with patch("smoke.infer") as run_inference:
            with self.assertRaisesRegex(RuntimeError, "BLOCKED_LICENSE"):
                smoke.main()
            run_inference.assert_not_called()

    def test_docker_build_stops_before_upstream_or_dependency_downloads(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        gate = dockerfile.index(
            "BLOCKED_LICENSE: LaDA-Band image build refused before upstream download"
        )
        self.assertLess(gate, dockerfile.index("apt-get update"))
        self.assertLess(gate, dockerfile.index("RUN git clone"))
        self.assertIn('"runtimeBuildAuthorized": true', dockerfile)

    def test_retained_manual_gate_metadata_is_hash_bound(self):
        evidence = json.loads(
            (ROOT / "release-evidence/license-review.json").read_text()
        )
        self.assertEqual(
            evidence["decision"]["classification"],
            "BLOCKED_LICENSE",
        )
        self.assertEqual(
            evidence["model"]["selectedMetadata"]["gated"],
            "manual",
        )
        self.assertEqual(
            evidence["model"]["selectedMetadata"]["cardData"]["license"],
            "other",
        )
        self.assertFalse(evidence["model"]["approvedAccountEvidenceRetained"])
        self.assertFalse(evidence["model"]["acceptedTermsEvidenceRetained"])