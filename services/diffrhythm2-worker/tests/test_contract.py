import json,unittest
from pathlib import Path
ROOT=Path(__file__).parents[1]
class DiffRhythmContract(unittest.TestCase):
 def test_immutable_manifest_and_license(self):
  m=json.loads((ROOT/"model_manifest.json").read_text())
  self.assertEqual(m["provider"],"DIFFRHYTHM_2"); self.assertEqual(m["license"]["weights"],"Apache-2.0")
  self.assertEqual(len(m["source"]["revision"]),40); self.assertNotIn("main",json.dumps(m))
 def test_private_provisioning_only_contract(self):
  source=(ROOT/"modal_provision.py").read_text(); config=(ROOT/"modal_config.py").read_text()
  self.assertIn("private",config); self.assertIn("bootstrap_assets.py",source)
  self.assertIn('RUNTIME_SECRET_NAME="music-ai-worker-runtime"',config)
  self.assertNotIn("diffrhythm2-runtime-v1",config)
  self.assertIn("HF_HUB_OFFLINE=1", (ROOT/"Dockerfile").read_text())
 def test_image_verifies_checkout_and_prints_requirements_before_install(self):
  docker=(ROOT/"Dockerfile").read_text()
  revision="13a7b091f45124f611e36ee674973234f38d55b6"
  self.assertIn('actual_revision="$(git -C /opt/diffrhythm2 rev-parse HEAD)"',docker)
  self.assertNotIn("$$(git -C /opt/diffrhythm2 rev-parse HEAD)",docker)
  self.assertIn(f'test "${{actual_revision}}" = "{revision}"',docker)
  inspection=docker.index("cat /opt/diffrhythm2/requirements.txt")
  installation=docker.index("pip install --no-cache-dir -r /opt/diffrhythm2/requirements.txt")
  self.assertLess(inspection,installation)
 def test_image_has_native_build_toolchain_for_pinned_pyopenjtalk(self):
  docker=(ROOT/"Dockerfile").read_text()
  install=next(line for line in docker.splitlines() if "apt-get install" in line)
  self.assertIn("build-essential",install)
  self.assertIn("cmake",install)
  self.assertIn("python3.11-dev",install)
 def test_modal_python_detection_uses_the_exact_venv_interpreter(self):
  docker=(ROOT/"Dockerfile").read_text()
  target="/opt/diffrhythm2-venv/bin/python"
  for command in ("python","python3","python3.11"):
   self.assertIn(f"ln -s {target} /usr/local/bin/{command}",docker)
  self.assertIn("assert sys.version_info[:2] == (3, 11)",docker)
  self.assertIn(f'CMD ["{target}","-m","uvicorn"',docker)
 def test_bearer_token_prefers_provider_specific_then_shared_runtime(self):
  source=(ROOT/"app.py").read_text()
  provider=source.index('os.getenv("DIFFRHYTHM2_API_TOKEN")')
  shared=source.index('os.getenv("MUSIC_AI_WORKER_TOKEN")',provider)
  self.assertLess(provider,shared)
  self.assertIn('(os.getenv("DIFFRHYTHM2_API_TOKEN") or "").strip() or (os.getenv("MUSIC_AI_WORKER_TOKEN") or "").strip()',source)
 def test_real_smoke_and_offline_serving_gates_remain_enforced(self):
  app=(ROOT/"app.py").read_text(); smoke=(ROOT/"smoke.py").read_text()
  provision=(ROOT/"modal_provision.py").read_text()
  self.assertIn('proof["realInference"] is True',app)
  self.assertIn('proof["nonSilent"] is True',app)
  self.assertIn('proof["notSourceCopy"] is True',app)
  self.assertIn('"lyricsConditioned":True',smoke)
  self.assertIn('"rhythmConditioned":True',smoke)
  self.assertIn("def smoke_real_audio():",provision)
  self.assertIn("smoke_image=image.add_local_file(",provision)
  self.assertIn("@app.function(image=smoke_image",provision)
  self.assertIn('"DIFFRHYTHM2_SMOKE_AUDIO":fixture',provision)
  self.assertIn('completed.stderr.split())[-4000:]',provision)