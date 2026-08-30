import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("modal_config", ROOT / "modal_config.py")
modal_config = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = modal_config
spec.loader.exec_module(modal_config)


class ModalDeploymentConfigurationTests(unittest.TestCase):
    def test_each_manifest_provider_has_a_bounded_deployment(self):
        self.assertEqual(
            set(modal_config.DEPLOYMENTS),
            {"BS_ROFORMER", "ACE_STEP", "MT3", "ALL_IN_ONE"},
        )
        self.assertTrue(set(modal_config.DEPLOYMENTS) <= set(modal_config.MANIFEST["providers"]))
        for provider, deployment in modal_config.DEPLOYMENTS.items():
            self.assertEqual(deployment.provider, provider)
            self.assertGreaterEqual(deployment.timeout_seconds, 30)
            self.assertGreater(deployment.max_containers, 0)
            self.assertIn(deployment.gpu, {"L4", "L40S"})
            self.assertEqual(deployment.max_containers, 1)
            self.assertTrue((ROOT / "runners" / deployment.requirements_file).is_file())
            self.assertRegex(deployment.source_image_digest, r"^sha256:[0-9a-f]{64}$")

    def test_environment_is_provider_isolated_and_uses_durable_mounts(self):
        for deployment in modal_config.DEPLOYMENTS.values():
            environment = modal_config.worker_environment(deployment)
            self.assertEqual(environment["MUSIC_GPU_ENABLED_PROVIDERS"], deployment.provider)
            self.assertTrue(environment["MUSIC_GPU_JOB_DB"].startswith(modal_config.JOB_MOUNT))
            self.assertEqual(environment["MUSIC_GPU_JOB_OUTPUT_ROOT"], modal_config.OUTPUT_MOUNT)
            self.assertNotIn("MUSIC_GPU_OUTPUT_ROOT", environment)
            self.assertEqual(environment["MUSIC_GPU_MAX_CONCURRENT_JOBS"], "1")
            self.assertNotIn("MUSIC_AI_WORKER_TOKEN", environment)
            self.assertEqual(
                environment["MUSIC_GPU_CONTAINER_DIGEST"], deployment.source_image_digest
            )

    def test_secret_and_volume_names_are_explicitly_versioned(self):
        self.assertEqual(modal_config.RUNTIME_SECRET_NAME, "music-ai-worker-runtime")
        self.assertTrue(modal_config.MODEL_VOLUME_NAME.endswith("-v1"))
        self.assertTrue(modal_config.JOB_VOLUME_NAME.endswith("-v1"))
        self.assertTrue(modal_config.OUTPUT_VOLUME_NAME.endswith("-v1"))

    def test_modal_uses_documented_concurrency_decorator(self):
        source = (ROOT / "modal_app.py").read_text()
        self.assertEqual(source.count("@modal.concurrent(max_inputs=1)"), 4)
        self.assertNotIn('"max_inputs":', source)