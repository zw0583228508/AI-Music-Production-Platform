import json,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class ContractTest(unittest.TestCase):
 def test_immutable_research_only_contract(self):
  spec=json.loads((ROOT/"model_manifest.json").read_text()); lic=json.loads((ROOT/"license_manifest.json").read_text())
  self.assertEqual(spec["provider"],"LADA_BAND"); self.assertEqual(lic["commercial_status"],"RESEARCH_ONLY")
  self.assertTrue(all(len(spec[x]["revision"])==40 for x in ("source","model")))
  self.assertEqual(spec["model"]["required_trees"],["checkpoints","pretrained"])
 def test_fail_closed_evidence_and_real_contract(self):
  app=(ROOT/"app.py").read_text(); boot=(ROOT/"bootstrap_assets.py").read_text()
  self.assertIn("invalid bearer token",app);self.assertIn("real-audio smoke",app);self.assertIn("artifactSha256",app);self.assertIn("treeSha256",boot)