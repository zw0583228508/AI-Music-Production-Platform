import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("sheetsage_modal_config", ROOT / "modal_config.py")
config = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(config)


class ModalConfigTests(unittest.TestCase):
    def test_isolated_names_and_endpoint_contract(self):
        self.assertEqual(config.APP_NAME, "sheetsage-worker")
        self.assertEqual(config.ENDPOINT_LABEL, "sheetsage")
        self.assertEqual(config.RUNTIME_SECRET_NAME, "music-ai-worker-runtime")
        self.assertEqual(config.MODEL_VOLUME_NAME, "sheetsage-models-v1")
        self.assertEqual(config.SMOKE_VOLUME_NAME, "sheetsage-smoke-v1")
        self.assertEqual(config.image_build_args(), {})
        self.assertEqual(config.worker_environment()["HF_HUB_OFFLINE"], "1")


if __name__ == "__main__":
    unittest.main()