import ast
from datetime import datetime, timedelta, timezone
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
    def test_recovery_drill_is_scheduled_without_any_volume_mount(self):
        tree = ast.parse((ROOT / "modal_provision.py").read_text())
        drill = next(
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "drill_recovery_assets"
        )
        app_function = next(
            decorator
            for decorator in drill.decorator_list
            if isinstance(decorator, ast.Call)
            and isinstance(decorator.func, ast.Attribute)
            and decorator.func.attr == "function"
        )
        keywords = {keyword.arg: keyword.value for keyword in app_function.keywords}
        self.assertIn("schedule", keywords)
        self.assertNotIn("volumes", keywords)

    def test_recovery_freshness_monitor_is_independently_scheduled(self):
        tree = ast.parse((ROOT / "modal_provision.py").read_text())
        monitor = next(
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "monitor_recovery_drill_freshness"
        )
        app_function = next(
            decorator
            for decorator in monitor.decorator_list
            if isinstance(decorator, ast.Call)
            and isinstance(decorator.func, ast.Attribute)
            and decorator.func.attr == "function"
        )
        keywords = {keyword.arg: keyword.value for keyword in app_function.keywords}
        self.assertIn("schedule", keywords)

    def test_fresh_recovery_record_is_healthy_and_redacted(self):
        now = datetime(2026, 9, 6, tzinfo=timezone.utc)
        record = {
            "completedAt": (now - timedelta(days=1)).isoformat(),
            "verification": {
                "verified": True,
                "assetCount": 15,
                "productionVolumeMounted": False,
            },
        }
        result = provision.require_fresh_recovery_drill(record, now)
        self.assertEqual(result["assetCount"], 15)
        self.assertNotIn("archive", str(record).lower())
        self.assertNotIn("url", str(record).lower())

    def test_missing_or_stale_recovery_record_alerts(self):
        now = datetime(2026, 9, 6, tzinfo=timezone.utc)
        with self.assertRaisesRegex(RuntimeError, "no valid successful heartbeat"):
            provision.require_fresh_recovery_drill(None, now)
        stale = {
            "completedAt": (
                now
                - timedelta(
                    seconds=provision.RECOVERY_SUCCESS_MAX_AGE_SECONDS + 1
                )
            ).isoformat(),
            "verification": {
                "verified": True,
                "assetCount": 15,
                "productionVolumeMounted": False,
            },
        }
        with self.assertRaisesRegex(RuntimeError, "heartbeat is stale"):
            provision.require_fresh_recovery_drill(stale, now)

    def test_real_smoke_reexecutes_in_a_reused_container(self):
        loaded = types.ModuleType("smoke")
        with patch.dict(sys.modules, {"smoke": loaded}), patch.object(
            provision.importlib, "reload", return_value=loaded
        ) as reload_module:
            provision.run_real_smoke()
        reload_module.assert_called_once_with(loaded)


if __name__ == "__main__":
    unittest.main()