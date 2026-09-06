from __future__ import annotations
import importlib.util, json, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class MossMusicContractTest(unittest.TestCase):
 def test_two_immutable_identities_and_roles(self):
  spec=json.loads((ROOT/"model_manifest.json").read_text())
  self.assertEqual(spec["source"]["revision"],"ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e")
  self.assertEqual(set(spec["models"]),{"MOSS_MUSIC_INSTRUCT","MOSS_MUSIC_THINKING"})
  self.assertNotEqual(*(m["revision"] for m in spec["models"].values()))
  self.assertTrue(all(len(m["revision"])==40 for m in spec["models"].values()))
  self.assertNotIn("main",json.dumps(spec))
 def test_private_offline_serving_configuration(self):
  module=importlib.util.spec_from_file_location("config",ROOT/"modal_config.py"); config=importlib.util.module_from_spec(module); module.loader.exec_module(config)
  self.assertTrue(all("private" in v for v in (config.MODEL_VOLUME_NAME,config.SMOKE_VOLUME_NAME,config.OUTPUT_VOLUME_NAME)))
  self.assertEqual(config.worker_environment()["HF_HUB_OFFLINE"],"1")
  self.assertEqual(config.worker_environment(online=True)["HF_HUB_OFFLINE"],"0")
 def test_real_smoke_and_fail_closed_contract(self):
  app=(ROOT/"app.py").read_text(); smoke=(ROOT/"smoke.py").read_text()
  self.assertIn("realInference",smoke); self.assertIn("MUSICAL_SEMANTIC_REASONING",app)
  self.assertIn("canonicalTruth",app); self.assertIn("artifactSha256",app)
  self.assertIn("invalid bearer token",app); self.assertIn("not assets or not smoke",app)
 def test_torch_and_cudnn_resolver_contract(self):
  spec=json.loads((ROOT/"model_manifest.json").read_text())
  docker=(ROOT/"Dockerfile").read_text()
  self.assertEqual(spec["runtime"]["torch"],"2.9.1+cu128")
  self.assertEqual(spec["runtime"]["cudnn"],{"package":"nvidia-cudnn-cu12","version":"9.10.2.21","resolution":"torch-wheel-transitive"})
  self.assertEqual(spec["sglang"]["revision"],"c28a945853c7fee357f55d976b8abce51874bd94")
  self.assertNotIn("nvidia-cudnn-cu12==9.16.0.29",docker)
  self.assertIn("/opt/moss-venv/bin/pip check",docker)
  self.assertIn("m.version('nvidia-cudnn-cu12') == '9.10.2.21'",docker)
  self.assertIn("ln -sf /usr/bin/python3.12 /usr/local/bin/python",docker)
 def test_ffmpeg_prefix_is_exposed_to_every_workload_and_preflighted(self):
  config_spec=importlib.util.spec_from_file_location("config_media",ROOT/"modal_config.py"); config=importlib.util.module_from_spec(config_spec); config_spec.loader.exec_module(config)
  environment=config.workload_environment()
  self.assertTrue(environment["PATH"].startswith("/opt/moss-ffmpeg/bin:"))
  self.assertTrue(environment["LD_LIBRARY_PATH"].startswith("/opt/moss-ffmpeg/lib"))
  self.assertIn("preflight.py", (ROOT/"Dockerfile").read_text())
  self.assertIn("preflight.py", (ROOT/"modal_provision.py").read_text())
  self.assertIn("workload_environment()", (ROOT/"modal_app.py").read_text())
  preflight=(ROOT/"preflight.py").read_text()
  self.assertIn("import torchcodec",preflight)
  self.assertIn("torchaudio.load",preflight)