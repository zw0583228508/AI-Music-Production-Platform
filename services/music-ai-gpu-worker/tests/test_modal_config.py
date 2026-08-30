import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("modal_config", ROOT / "modal_config.py")
modal_config = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = modal_config
spec.loader.exec_module(modal_config)
bootstrap_spec = importlib.util.spec_from_file_location(
    "checkpoint_bootstrap", ROOT / "checkpoint_bootstrap.py"
)
checkpoint_bootstrap = importlib.util.module_from_spec(bootstrap_spec)
assert bootstrap_spec and bootstrap_spec.loader
sys.modules[bootstrap_spec.name] = checkpoint_bootstrap
bootstrap_spec.loader.exec_module(checkpoint_bootstrap)


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
            self.assertTrue(deployment.cuda_image.startswith("nvidia/cuda:"))
            self.assertTrue(deployment.pytorch)

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
            module = deployment.provider.lower()
            self.assertEqual(
                environment[f"MUSIC_GPU_RUNNER_{deployment.provider}"],
                f"python -m runners.{module}",
            )
            self.assertEqual(
                environment[f"MUSIC_GPU_SMOKE_{deployment.provider}"],
                f"python -m runners.{module}",
            )

    def test_image_build_args_only_contain_dependency_inputs(self):
        for deployment in modal_config.DEPLOYMENTS.values():
            build_args = modal_config.provider_image_build_args(deployment)
            self.assertEqual(
                set(build_args),
                {
                    "PROVIDER_REQUIREMENTS",
                    "CUDA_IMAGE",
                    "CUDA_RUNTIME",
                    "PYTORCH_SPEC",
                    "TORCHVISION_SPEC",
                    "TORCHAUDIO_SPEC",
                    "TORCH_INDEX_URL",
                    "TRANSFORMERS_SPEC",
                    "ACCELERATE_SPEC",
                },
            )
            self.assertNotIn("MUSIC_GPU_SOURCE_IMAGE_DIGEST", build_args)

    def test_source_identity_is_runtime_only(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        modal_app = (ROOT / "modal_app.py").read_text()
        self.assertNotIn("MUSIC_GPU_SOURCE_IMAGE_DIGEST", dockerfile)
        self.assertNotIn("MUSIC_GPU_SOURCE_IMAGE_DIGEST", modal_app)
        for deployment in modal_config.DEPLOYMENTS.values():
            self.assertEqual(
                modal_config.worker_environment(deployment)[
                    "MUSIC_GPU_CONTAINER_DIGEST"
                ],
                deployment.source_image_digest,
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

    def test_modal_selection_defaults_to_only_verified_ace_and_is_strict(self):
        with mock.patch.dict(__import__("os").environ, {}, clear=False):
            __import__("os").environ.pop("MUSIC_GPU_MODAL_DEPLOY_PROVIDERS", None)
            self.assertEqual(set(modal_config.selected_deployments()), {"ACE_STEP"})
        self.assertEqual(
            set(modal_config.selected_deployments("MT3,BS_ROFORMER")),
            {"MT3", "BS_ROFORMER"},
        )
        with self.assertRaisesRegex(ValueError, "must not be empty"):
            modal_config.selected_deployments(" , ")
        with self.assertRaisesRegex(ValueError, "unknown"):
            modal_config.selected_deployments("NOT_A_PROVIDER")

    def test_ace_step_uses_its_official_cuda_128_stack(self):
        ace = modal_config.DEPLOYMENTS["ACE_STEP"]
        self.assertEqual(ace.cuda_runtime, "12.8.1")
        self.assertEqual(ace.pytorch, "2.10.0+cu128")
        self.assertEqual(ace.torchvision, "0.25.0+cu128")
        self.assertEqual(ace.torchaudio, "2.10.0+cu128")
        self.assertEqual(ace.transformers, "4.57.6")
        self.assertEqual(ace.accelerate, "1.12.0")
        self.assertTrue(ace.torch_index_url.endswith("/cu128"))
        self.assertEqual(
            modal_config.DEPLOYMENTS["MT3"].pytorch, "2.5.1+cu124"
        )

    def test_public_origin_is_deployment_controlled_and_validated(self):
        key = "MUSIC_GPU_PUBLIC_ORIGIN_ACE_STEP"
        with mock.patch.dict(
            __import__("os").environ,
            {key: "https://workspace--music-ai-gpu-worker-ace-step.modal.run"},
        ):
            environment = modal_config.worker_environment(
                modal_config.DEPLOYMENTS["ACE_STEP"]
            )
        self.assertEqual(
            environment["MUSIC_GPU_PUBLIC_ORIGIN"],
            "https://workspace--music-ai-gpu-worker-ace-step.modal.run",
        )
        with mock.patch.dict(__import__("os").environ, {key: "https://evil/x"}):
            with self.assertRaisesRegex(ValueError, "HTTPS origin"):
                modal_config.worker_environment(modal_config.DEPLOYMENTS["ACE_STEP"])

    def test_bootstrap_digest_matches_worker_canonical_algorithm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "b").write_bytes(b"second")
            (root / "a").write_bytes(b"first")
            self.assertEqual(
                checkpoint_bootstrap.checkpoint_sha256(root),
                __import__("hashlib").sha256(
                    b"a" + b"first" + b"b" + b"second"
                ).hexdigest(),
            )

    def test_uncertain_bootstrap_source_fails_without_creating_weights(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            checkpoint_bootstrap, "MODEL_ROOT", Path(directory)
        ), mock.patch.object(
            checkpoint_bootstrap,
            "SMOKE_FIXTURE",
            Path(directory) / "_smoke" / "non-silent-440hz-1s.wav",
        ):
            for provider in ("BS_ROFORMER", "MT3", "ALL_IN_ONE"):
                with self.assertRaisesRegex(RuntimeError, "bootstrap unavailable"):
                    checkpoint_bootstrap.bootstrap_provider(provider)
            self.assertTrue(checkpoint_bootstrap.SMOKE_FIXTURE.is_file())
            self.assertEqual(
                list(Path(directory).glob("bs-roformer-viperx-v1.ckpt")), []
            )

    def test_ace_bootstrap_builds_atomic_minimal_composite_and_keeps_old_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "ace-step-1.5-base"
            old.mkdir()
            for name in checkpoint_bootstrap.ACE_BASE_ALLOW_PATTERNS:
                (old / name).write_bytes(("base:" + name).encode())

            def snapshot_download(**kwargs):
                self.assertFalse(kwargs["force_download"])
                self.assertTrue(kwargs["resume_download"])
                target = Path(kwargs["local_dir"])
                if kwargs["repo_id"] == checkpoint_bootstrap.ACE_BASE_REPOSITORY:
                    self.assertEqual(kwargs["revision"], checkpoint_bootstrap.ACE_BASE_REVISION)
                    files = set(checkpoint_bootstrap.ACE_BASE_ALLOW_PATTERNS)
                else:
                    self.assertEqual(
                        kwargs["revision"],
                        "19671f406d603126926c1b7e2adc169acbcade22",
                    )
                    files = {
                        "config.json",
                        "vae/config.json",
                        "vae/diffusion_pytorch_model.safetensors",
                        "Qwen3-Embedding-0.6B/config.json",
                        "Qwen3-Embedding-0.6B/model.safetensors",
                    }
                for name in files:
                    (target / name).parent.mkdir(parents=True, exist_ok=True)
                    (target / name).write_bytes(("full:" + name).encode())
                return str(target)

            fake_hub = types.SimpleNamespace(snapshot_download=snapshot_download)
            with mock.patch.object(
                checkpoint_bootstrap, "MODEL_ROOT", root
            ), mock.patch.object(
                checkpoint_bootstrap,
                "SMOKE_FIXTURE",
                root / "_smoke" / "non-silent-440hz-1s.wav",
            ), mock.patch.dict(sys.modules, {"huggingface_hub": fake_hub}):
                result = checkpoint_bootstrap.bootstrap_provider("ACE_STEP")
            composite = root / "ace-step-1.5-runtime"
            self.assertTrue(old.is_dir())
            self.assertTrue((composite / "acestep-v15-base/model.safetensors").is_file())
            self.assertFalse((composite / "acestep-v15-turbo").exists())
            self.assertFalse((composite / "acestep-5Hz-lm-1.7B").exists())
            self.assertEqual(
                set(item.name for item in composite.iterdir()),
                {"config.json", "vae", "Qwen3-Embedding-0.6B", "acestep-v15-base"},
            )
            self.assertIn("19671f406d603126926c1b7e2adc169acbcade22", result["revision"])
            self.assertIn("e432212fec32b8965a14ffa57ae653438d6abd14", result["revision"])
            self.assertEqual(result["digest"], checkpoint_bootstrap.checkpoint_sha256(composite))