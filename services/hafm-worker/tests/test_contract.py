import json,re,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCE_REVISION="d9aa19a5820a4c1563ab405d437933480f71d5b9"
MODEL_REVISION="1653c3c7bffdc9b4b2d57d8b6e4f5bb3002a64fe"
class ContractTest(unittest.TestCase):
 def test_exact_pins_and_license(self):
  s=json.loads((ROOT/"model_manifest.json").read_text());l=json.loads((ROOT/"license_manifest.json").read_text())
  self.assertEqual(s["provider"],"HAFM");self.assertEqual(l["license"],"Apache-2.0")
  self.assertEqual(s["source"],{"repository":"HackerHyper/HAFM","revision":SOURCE_REVISION})
  self.assertEqual(s["model"],{"repository":"zhuqijian/HAFM","revision":MODEL_REVISION})
  self.assertEqual(s["inference"]["command"],"python infer_simple.py --vocal_path <vocal> --output_path <output> --config configs/ar.yaml")
  self.assertEqual(l["source_repository"],"HackerHyper/HAFM");self.assertEqual(l["model_repository"],"zhuqijian/HAFM")
 def test_image_uses_real_upstream_tree_without_invented_install_file(self):
  d=(ROOT/"Dockerfile").read_text()
  self.assertIn(f"checkout --detach {SOURCE_REVISION}",d)
  self.assertIn('test "$(git -C /opt/hafm rev-parse HEAD)"',d)
  self.assertNotIn("pip install -r /opt/hafm/requirements.txt",d)
  self.assertNotIn("COPY requirements.txt /opt/hafm",d)
  self.assertIn("test -f /opt/hafm/README.md",d);self.assertIn("test -f /opt/hafm/infer.py",d)
  self.assertIn("test ! -e /opt/hafm/requirements.txt",d);self.assertIn('grep -F "python infer_simple.py" /opt/hafm/README.md',d)
 def test_worker_production_requirements_are_exactly_pinned(self):
  dependencies=[line.strip() for line in (ROOT/"requirements.txt").read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")]
  self.assertEqual(dependencies,["fastapi==0.115.12","uvicorn==0.34.2","huggingface-hub==0.30.2","soundfile==0.13.1"])
  self.assertTrue(all(re.fullmatch(r"[a-z0-9-]+==[^=\\s]+",dependency) for dependency in dependencies))
 def test_modal_detects_the_isolated_python_runtime(self):
  d=(ROOT/"Dockerfile").read_text()
  for name in ("python","python3","python3.10"):
   self.assertIn(f"ln -sf /opt/hafm-venv/bin/{name} /usr/local/bin/{name}",d)
  self.assertIn("python --version",d)
  self.assertIn('CMD ["/opt/hafm-venv/bin/python"',d)
 def test_offline_fail_closed_and_provenance(self):
  c=(ROOT/"modal_config.py").read_text();a=(ROOT/"app.py").read_text();m=(ROOT/"modal_app.py").read_text();s=(ROOT/"smoke.py").read_text();p=(ROOT/"modal_provision.py").read_text()
  self.assertIn('"HF_HUB_OFFLINE"',c);self.assertIn("invalid bearer token",a);self.assertIn("real-audio smoke",a);self.assertIn("artifactSha256",a)
  self.assertIn('MODEL_VOLUME_NAME="hafm-models-private-v1"',c);self.assertIn("modal.Volume.from_name(MODEL_VOLUME_NAME",m)
  self.assertIn('"realInference":True',s);self.assertIn('SPEC["smoke_fixture"]',s)
  self.assertIn("independently sourced real vocal smoke fixture",s);self.assertNotIn("/opt/hafm/assets/smoke_vocal.wav",s)
  self.assertIn('proof.unlink(missing_ok=True)',s);self.assertIn('"provisioned-not-ready"',p)
  provision_body=p[p.index("def provision():"):p.index("@app.function",p.index("def provision():"))]
  self.assertNotIn("/app/smoke.py",provision_body);self.assertIn("model_volume.commit()",provision_body)
  self.assertIn("def run_real_vocal_smoke():",p);self.assertIn("env=worker_environment()",p)
  self.assertIn('"checkpointReady":assets_ok',a);self.assertIn('"smokeTested":smoke_ok',a)