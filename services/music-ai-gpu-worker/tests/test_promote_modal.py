import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).parents[1]
config_spec = importlib.util.spec_from_file_location(
    "modal_config", ROOT / "modal_config.py"
)
modal_config = importlib.util.module_from_spec(config_spec)
assert config_spec and config_spec.loader
sys.modules[config_spec.name] = modal_config
config_spec.loader.exec_module(modal_config)
promote_spec = importlib.util.spec_from_file_location(
    "music_gpu_promote_modal", ROOT / "promote_modal.py"
)
promote = importlib.util.module_from_spec(promote_spec)
assert promote_spec and promote_spec.loader
promote_spec.loader.exec_module(promote)


def expected_record(provider: str) -> dict:
    deployment = modal_config.DEPLOYMENTS[provider]
    return modal_config.build_promotion_record(
        deployment,
        modal_app_id="ap-Test",
        modal_deployment_id="v1",
        modal_function_id="fu-Test",
        modal_image_id="im-Test",
        endpoint_origin=f"https://{provider.lower().replace('_', '-')}.example.test",
        checkpoint_sha256="a" * 64,
        source_revision="b" * 40,
    )


def health(record: dict, **overrides) -> dict:
    payload = {
        "provider": record["provider"],
        "status": "ready",
        "ready": True,
        "healthy": True,
        "retryable": False,
        "modelVersion": record["modelVersion"],
        "checkpointSha256": record["checkpointSha256"],
        "revision": record["checkpointRevision"],
        "modalAppId": record["modalAppId"],
        "modalDeploymentId": record["modalDeploymentId"],
        "modalFunctionId": record["modalFunctionId"],
        "modalImageId": record["modalImageId"],
        "sourceRevision": record["sourceRevision"],
        "sourceImageDigest": record["sourceImageDigest"],
        "runtimeReady": True,
        "runtime": {"pythonVersion": record["runtime"]["python"]},
        "framework": {
            "cuda_image": record["runtime"]["cudaImage"],
            "cuda": record["runtime"]["cuda"],
            "pytorch": record["runtime"]["pytorch"],
            "torchvision": record["runtime"]["torchvision"],
            "torchaudio": record["runtime"]["torchaudio"],
            "torch_index_url": record["runtime"]["torchIndexUrl"],
            "transformers": record["runtime"]["transformers"],
            "accelerate": record["runtime"]["accelerate"],
        },
    }
    return {**payload, **overrides}


class PromotionHealthContractTests(unittest.TestCase):
    def test_each_provider_retries_only_its_exact_startup_contract(self):
        for provider in sorted(promote.PROMOTED_PROVIDERS):
            with self.subTest(provider=provider):
                record = expected_record(provider)
                responses = iter([
                    health(
                        record,
                        status="starting",
                        ready=False,
                        healthy=False,
                        retryable=True,
                        retryAfterSeconds=5,
                        runtimeReady=False,
                    ),
                    health(record),
                ])
                with mock.patch.object(promote.time, "sleep") as sleep:
                    promote.verify_live_health_with_retries(
                        lambda: next(responses), record
                    )
                sleep.assert_called_once_with(5)

    def test_runtime_errors_and_identity_mismatches_are_not_retried(self):
        record = expected_record("MT3")
        failures = (
            health(record, status="not_ready", ready=False, healthy=False),
            health(record, modalImageId="im-Other"),
            health(
                record,
                status="starting",
                ready=False,
                healthy=False,
                retryable=True,
                retryAfterSeconds=10,
            ),
            health(
                record,
                status="starting",
                ready=False,
                healthy=False,
                retryable=True,
                retryAfterSeconds=5,
                modalImageId="im-Other",
            ),
        )
        for payload in failures:
            with self.subTest(payload=payload):
                fetch = mock.Mock(return_value=payload)
                with self.assertRaises(ValueError), mock.patch.object(
                    promote.time, "sleep"
                ) as sleep:
                    promote.verify_live_health_with_retries(fetch, record)
                self.assertEqual(fetch.call_count, 1)
                sleep.assert_not_called()

    def test_authenticated_fetch_requires_the_provider_trusted_origin(self):
        with self.assertRaisesRegex(ValueError, "trusted provider"):
            promote.trusted_endpoint_origin(
                "https://attacker.example.test",
                "https://mt3.example.test",
            )
        self.assertEqual(
            promote.trusted_endpoint_origin(
                "https://mt3.example.test",
                "https://mt3.example.test",
            ),
            "https://mt3.example.test",
        )

    def test_startup_state_is_bounded(self):
        record = expected_record("ALL_IN_ONE")
        startup = health(
            record,
            status="starting",
            ready=False,
            healthy=False,
            retryable=True,
            retryAfterSeconds=5,
            runtimeReady=False,
        )
        with self.assertRaises(TimeoutError), mock.patch.object(
            promote.time, "sleep"
        ) as sleep:
            promote.verify_live_health_with_retries(
                lambda: startup, record, attempts=2
            )
        sleep.assert_called_once_with(5)