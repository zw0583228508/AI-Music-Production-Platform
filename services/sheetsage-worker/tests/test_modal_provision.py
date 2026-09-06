import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location(
    "sheetsage_modal_provision", ROOT / "modal_provision.py"
)
provision = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(provision)


class ModalProvisionTests(unittest.TestCase):
    def test_real_smoke_reexecutes_in_a_reused_container(self):
        loaded = types.ModuleType("smoke")
        with patch.dict(sys.modules, {"smoke": loaded}), patch.object(
            provision.importlib, "reload", return_value=loaded
        ) as reload_module:
            provision.run_real_smoke()
        reload_module.assert_called_once_with(loaded)


if __name__ == "__main__":
    unittest.main()