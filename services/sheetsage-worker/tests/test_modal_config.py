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
        self.assertEqual(config.CANDIDATE_ENDPOINT_LABEL, "sheetsage-candidate")
        self.assertEqual(config.RUNTIME_SECRET_NAME, "music-ai-worker-runtime")
        self.assertEqual(config.LICENSE_SECRET_NAME, "sheetsage-noncommercial-license-v1")
        self.assertEqual(config.MODEL_VOLUME_NAME, "sheetsage-models-v1")
        self.assertEqual(config.SMOKE_VOLUME_NAME, "sheetsage-smoke-v1")
        self.assertEqual(config.image_build_args(), {"SHEETSAGE_ACCEPT_MODEL_LICENSE": "1"})
        self.assertEqual(config.worker_environment()["HF_HUB_OFFLINE"], "1")
        self.assertEqual(config.worker_environment()["SHEETSAGE_MAX_SPOOLED_ANALYSES"], "1")
        self.assertEqual(
            config.worker_environment()["SHEETSAGE_MAX_AUDIO_BYTES"],
            str(config.MAX_AUDIO_BYTES),
        )
        self.assertEqual(
            config.EPHEMERAL_DISK_KIB,
            config.EPHEMERAL_DISK_MIB * 1024,
        )

    def test_modal_worker_capacity_is_safe(self):
        config.validate_worker_capacity(
            config.worker_environment(),
            ephemeral_disk_mib=config.EPHEMERAL_DISK_MIB,
            max_concurrent_inputs=config.MAX_CONCURRENT_INPUTS,
        )

    def test_rejects_upload_and_headroom_larger_than_ephemeral_disk(self):
        environment = config.worker_environment()
        environment["SHEETSAGE_MAX_AUDIO_BYTES"] = str(1800 * config.MIB)
        with self.assertRaisesRegex(ValueError, "exceeds Modal ephemeral disk"):
            config.validate_worker_capacity(
                environment,
                ephemeral_disk_mib=config.EPHEMERAL_DISK_MIB,
                max_concurrent_inputs=config.MAX_CONCURRENT_INPUTS,
            )

    def test_rejects_spooling_above_modal_input_concurrency(self):
        environment = config.worker_environment()
        environment["SHEETSAGE_MAX_SPOOLED_ANALYSES"] = "3"
        with self.assertRaisesRegex(ValueError, "exceed Modal input concurrency"):
            config.validate_worker_capacity(
                environment,
                ephemeral_disk_mib=config.EPHEMERAL_DISK_MIB,
                max_concurrent_inputs=config.MAX_CONCURRENT_INPUTS,
            )


if __name__ == "__main__":
    unittest.main()