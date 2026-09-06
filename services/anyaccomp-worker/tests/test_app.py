import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("anyapp", ROOT / "app.py")
module = importlib.util.module_from_spec(spec)
import sys
sys.path.insert(0, str(ROOT))
spec.loader.exec_module(module)

class AnyAccompBoundaryTests(unittest.TestCase):
    def test_manifest_refuses_unpinned_source_and_weights(self):
        self.assertIsNone(module.SPEC["source"]["revision"])
        self.assertIsNone(module.SPEC["weights"]["revision"])
        self.assertFalse(module.state()[0])

    def test_smoke_requires_all_real_inference_guards(self):
        with tempfile.TemporaryDirectory() as temp:
            previous = module.ASSETS
            module.ASSETS = Path(temp)
            try:
                (module.ASSETS / module.SPEC["asset_manifest"]).write_text(json.dumps({}))
                self.assertFalse(module.smoke()[0])
            finally:
                module.ASSETS = previous