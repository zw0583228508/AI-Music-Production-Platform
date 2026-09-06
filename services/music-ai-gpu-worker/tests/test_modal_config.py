import importlib.util
import json
import subprocess
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
compat_spec = importlib.util.spec_from_file_location(
    "mt3_transformers_compat_patch", ROOT / "mt3_transformers_compat_patch.py"
)
compat_patch = importlib.util.module_from_spec(compat_spec)
assert compat_spec and compat_spec.loader
compat_spec.loader.exec_module(compat_patch)
your_compat_spec = importlib.util.spec_from_file_location(
    "your_mt3_transformers_compat_patch",
    ROOT / "your_mt3_transformers_compat_patch.py",
)
your_compat_patch = importlib.util.module_from_spec(your_compat_spec)
assert your_compat_spec and your_compat_spec.loader
your_compat_spec.loader.exec_module(your_compat_patch)


class ModalDeploymentConfigurationTests(unittest.TestCase):
    def test_ace_step_uses_an_isolated_webhook_label(self):
        modal_app_source = (ROOT / "modal_app.py").read_text()
        self.assertIn('@modal.asgi_app(label="ace-step-isolated")', modal_app_source)
        self.assertNotIn('@modal.asgi_app(label="ace-step")', modal_app_source)

    def test_mt3_uses_an_isolated_webhook_and_model_volume(self):
        modal_app_source = (ROOT / "modal_app.py").read_text()
        self.assertIn('@modal.asgi_app(label="mt3-isolated")', modal_app_source)
        self.assertNotIn('@modal.asgi_app(label="mt3")', modal_app_source)
        self.assertEqual(
            modal_config.provider_model_volume_name("MT3"),
            "music-ai-mt3-models-v1",
        )
        self.assertNotEqual(
            modal_config.provider_model_volume_name("MT3"),
            modal_config.MODEL_VOLUME_NAME,
        )
        self.assertIn("model_volumes[provider]", modal_app_source)

    def test_each_manifest_provider_has_a_bounded_deployment(self):
        self.assertEqual(
            set(modal_config.DEPLOYMENTS),
            {"BS_ROFORMER", "ACE_STEP", "MT3", "MR_MT3", "YOUR_MT3", "ALL_IN_ONE"},
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
            self.assertTrue(
                deployment.cuda_image.startswith(("nvidia/cuda:", "nvidia/cuda@sha256:"))
            )
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
            if deployment.provider in {"MT3", "BS_ROFORMER"}:
                self.assertNotIn("MUSIC_GPU_CONTAINER_DIGEST", environment)
                self.assertNotIn("MUSIC_GPU_SOURCE_REVISION", environment)
            else:
                self.assertEqual(
                    environment["MUSIC_GPU_CONTAINER_DIGEST"],
                    deployment.source_image_digest,
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
        bs_environment = modal_config.worker_environment(
            modal_config.DEPLOYMENTS["BS_ROFORMER"]
        )
        self.assertEqual(
            bs_environment["MUSIC_PROVIDER_BS_ROFORMER_CHECKPOINT_SHA256"],
            checkpoint_bootstrap.BS_CHECKPOINT_SHA256,
        )
        self.assertEqual(
            bs_environment["MUSIC_PROVIDER_BS_ROFORMER_CONFIG_SHA256"],
            checkpoint_bootstrap.BS_CONFIG_SHA256,
        )
        self.assertEqual(
            bs_environment["MUSIC_PROVIDER_BS_ROFORMER_CONFIG_PATH"],
            f"{modal_config.MODEL_MOUNT}/bs-roformer-viperx-v1.yaml",
        )
        self.assertEqual(
            bs_environment["MUSIC_GPU_SMOKE_INPUT_PATH"],
            f"{modal_config.MODEL_MOUNT}/_smoke/bs-roformer-real-song-v1.wav",
        )
        self.assertEqual(
            bs_environment["MUSIC_PROVIDER_BS_ROFORMER_SMOKE_INPUT_SHA256"],
            "b2626121f7f2987843d7212c82b8f1222f2f023fc3d4b07c07ede1b24535feb9",
        )
        self.assertEqual(
            modal_config.DEPLOYMENTS["BS_ROFORMER"].endpoint_label,
            "bs-roformer-isolated",
        )
        self.assertIn(
            '@modal.asgi_app(label="bs-roformer-isolated")',
            (ROOT / "modal_app.py").read_text(),
        )

    def test_image_build_args_inject_wave_two_host_identity_only(self):
        for deployment in modal_config.DEPLOYMENTS.values():
            build_args = modal_config.provider_image_build_args(deployment)
            expected = {
                    "PROVIDER_REQUIREMENTS",
                    "CUDA_IMAGE",
                    "CUDA_RUNTIME",
                    "PYTORCH_SPEC",
                    "TORCHVISION_SPEC",
                    "TORCHAUDIO_SPEC",
                    "TORCH_INDEX_URL",
                    "TRANSFORMERS_SPEC",
                    "ACCELERATE_SPEC",
            }
            if deployment.provider in {
                "MT3", "BS_ROFORMER", "MR_MT3", "YOUR_MT3",
            }:
                expected.add("SOURCE_IMAGE_DIGEST")
                self.assertEqual(build_args["SOURCE_IMAGE_DIGEST"], deployment.source_image_digest)
            if deployment.provider in {"MT3", "BS_ROFORMER"}:
                expected.add("SOURCE_REVISION")
                self.assertRegex(
                    build_args["SOURCE_REVISION"],
                    r"^(?:[a-f0-9]{40}|UNSET)$",
                )
            self.assertEqual(set(build_args), expected)
            self.assertNotIn("MUSIC_GPU_SOURCE_IMAGE_DIGEST", build_args)

    def test_mt3_direct_docker_build_uses_the_reviewed_transformers_pin(self):
        dockerfile = (ROOT / "Dockerfile.mt3").read_text()
        self.assertIn("ARG TRANSFORMERS_SPEC=transformers==4.38.2", dockerfile)
        self.assertEqual(
            modal_config.DEPLOYMENTS["MT3"].transformers,
            "4.38.2",
        )
        self.assertRegex(
            modal_config.DEPLOYMENTS["MT3"].cuda_image,
            r"^nvidia/cuda@sha256:[0-9a-f]{64}$",
        )
        self.assertIn(
            "ghcr.io/astral-sh/uv@sha256:",
            dockerfile,
        )
        bs_dockerfile = (ROOT / "Dockerfile.bs-roformer").read_text()
        self.assertRegex(
            modal_config.DEPLOYMENTS["BS_ROFORMER"].cuda_image,
            r"^nvidia/cuda@sha256:[0-9a-f]{64}$",
        )
        self.assertIn("ghcr.io/astral-sh/uv@sha256:", bs_dockerfile)
        self.assertIn("ARG SOURCE_IMAGE_DIGEST", bs_dockerfile)
        self.assertIn(
            "MUSIC_GPU_CONTAINER_DIGEST=${SOURCE_IMAGE_DIGEST}",
            bs_dockerfile,
        )
        self.assertIn(
            "ghcr.io/astral-sh/uv@sha256:"
            "1ececcacbbde240ffca54d400df86e4fdd38f29c1a2366299279d197e92eaed3",
            dockerfile,
        )
        self.assertIn("MUSIC_GPU_RUNTIME_IDENTITY=1", dockerfile)
        self.assertIn("MUSIC_GPU_CONTAINER_DIGEST=${SOURCE_IMAGE_DIGEST}", dockerfile)
        self.assertIn("MUSIC_GPU_SOURCE_REVISION=${SOURCE_REVISION}", dockerfile)

    def test_wave_two_has_compatible_transformers_and_isolated_yourmt3_extras(self):
        mr = (ROOT / "Dockerfile.mr-mt3").read_text()
        your = (ROOT / "Dockerfile.your-mt3").read_text()
        self.assertIn("ARG TRANSFORMERS_SPEC=transformers==4.48.3", mr)
        self.assertIn("ARG TRANSFORMERS_SPEC=transformers==4.45.1", your)
        self.assertIn("git-lfs", mr)
        self.assertIn("git-lfs", your)
        self.assertIn("git lfs install --system", your)
        self.assertNotIn("requirements-your-mt3.txt", mr)
        self.assertIn("requirements-your-mt3.txt", your)
        requirements = (ROOT / "runners" / "requirements-your-mt3.txt").read_text()
        self.assertIn("mt3-infer[full]", requirements)
        self.assertNotIn(
            "mt3-infer[full]",
            (ROOT / "runners" / "requirements-mt3.txt").read_text(),
        )
        self.assertEqual(modal_config.DEPLOYMENTS["MT3"].transformers, "4.38.2")
        self.assertEqual(modal_config.DEPLOYMENTS["YOUR_MT3"].transformers, "4.45.1")

    def test_wave_two_patch_is_hash_guarded_and_provider_isolated(self):
        expected = {
            "MR_MT3": (
                compat_patch,
                "mt3_transformers_compat_patch.py",
                "2e453e6750207d86831d5ae9dd604b0968c6e59290ae4b15bbd902f8b7abb4aa",
                "f0b0344fd90e50d861d47691b5d140eea97d3b73674682b7188677a9c719d9ea",
            ),
            "YOUR_MT3": (
                your_compat_patch,
                "your_mt3_transformers_compat_patch.py",
                "b2cc683b55f5d3284c0788d59f8f0a7c39b03535731aeb7a62c81c86c351f480",
                "b2cc683b55f5d3284c0788d59f8f0a7c39b03535731aeb7a62c81c86c351f480",
            ),
        }
        with self.assertRaisesRegex(RuntimeError, "source hash mismatch"):
            compat_patch.patch_content(compat_patch.ORIGINAL_FRAGMENT)
        with self.assertRaisesRegex(RuntimeError, "source hash mismatch"):
            your_compat_patch.patch_content(b"unreviewed")
        self.assertEqual(
            your_compat_patch.PATCHED_SHA256,
            your_compat_patch.ORIGINAL_SHA256,
        )
        self.assertEqual(your_compat_patch.EXPECTED_TRANSFORMERS_VERSION, "4.45.1")
        for provider, (module, script, source_sha, patch_sha) in expected.items():
            details = modal_config.MANIFEST["providers"][provider]
            docker = (
                ROOT / f"Dockerfile.{provider.lower().replace('_', '-')}"
            ).read_text()
            self.assertEqual(module.ORIGINAL_SHA256, source_sha)
            self.assertEqual(module.PATCHED_SHA256, patch_sha)
            self.assertEqual(details["adapter_source_sha256"], source_sha)
            self.assertEqual(details["adapter_patch_sha256"], patch_sha)
            self.assertIn(script, docker)
            self.assertEqual(
                modal_config.worker_environment(modal_config.DEPLOYMENTS[provider])[
                    "MUSIC_GPU_COMPATIBILITY_PATCH_SHA256"
                ],
                patch_sha,
            )
        self.assertNotIn(
            "your_mt3_transformers_compat_patch.py",
            (ROOT / "Dockerfile.mr-mt3").read_text(),
        )
        self.assertNotIn(
            "COPY services/music-ai-gpu-worker/mt3_transformers_compat_patch.py",
            (ROOT / "Dockerfile.your-mt3").read_text(),
        )
        legacy_docker = (ROOT / "Dockerfile.mt3").read_text()
        self.assertNotIn("mt3_transformers_compat_patch", legacy_docker)
        self.assertNotIn(
            "MUSIC_GPU_COMPATIBILITY_PATCH_SHA256",
            modal_config.worker_environment(modal_config.DEPLOYMENTS["MT3"]),
        )

    def test_wave_two_source_identity_is_host_computed_and_injected(self):
        modal_app = (ROOT / "modal_app.py").read_text()
        for provider in ("MR_MT3", "YOUR_MT3"):
            dockerfile = ROOT / f"Dockerfile.{provider.lower().replace('_', '-')}"
            self.assertTrue(dockerfile.is_file())
            self.assertIn("ARG SOURCE_IMAGE_DIGEST", dockerfile.read_text())
            self.assertIn("MUSIC_GPU_CONTAINER_DIGEST=${SOURCE_IMAGE_DIGEST}", dockerfile.read_text())
            self.assertNotIn("/provenance/runners/", dockerfile.read_text())
        self.assertNotIn("SOURCE_IMAGE_DIGEST", modal_app)
        for deployment in modal_config.DEPLOYMENTS.values():
            if deployment.provider in {"MT3", "BS_ROFORMER"}:
                observed = modal_config.provider_image_build_args(deployment)[
                    "SOURCE_IMAGE_DIGEST"
                ]
            else:
                observed = modal_config.worker_environment(deployment)[
                    "MUSIC_GPU_CONTAINER_DIGEST"
                ]
            self.assertEqual(observed, deployment.source_image_digest)

    def test_source_digest_covers_every_copied_executable_input(self):
        source = (ROOT / "modal_config.py").read_text()
        for required_input in (
            'SOURCE_ROOT / "app.py"',
            'SOURCE_ROOT / "modal_config.py"',
            'SOURCE_ROOT / "model_manifest.json"',
            'SOURCE_ROOT / "runners" / "__init__.py"',
            'SOURCE_ROOT / "runners" / "common.py"',
            'SOURCE_ROOT / "runners" / f"{provider.lower()}.py"',
        ):
            self.assertIn(required_input, source)
        for provider, deployment in modal_config.DEPLOYMENTS.items():
            dockerfile = (
                ROOT / f"Dockerfile.{provider.lower().replace('_', '-')}"
            ).read_text()
            self.assertNotIn("COPY services/music-ai-gpu-worker /app", dockerfile)
            self.assertIn(
                "app.py services/music-ai-gpu-worker/modal_config.py "
                "services/music-ai-gpu-worker/model_manifest.json /app/",
                dockerfile,
            )
            self.assertIn(
                f"runners/{provider.lower()}.py /app/runners/",
                dockerfile,
            )
            self.assertIn(
                f"runners/{deployment.requirements_file} /tmp/provider-requirements.txt",
                dockerfile,
            )
            if provider in {"MR_MT3", "YOUR_MT3"}:
                self.assertIn("SOURCE_IMAGE_DIGEST", dockerfile)
                self.assertNotIn("/provenance/runners/", dockerfile)
            else:
                self.assertIn("MUSIC_GPU_SOURCE_ROOT=/provenance", dockerfile)
                self.assertIn("/provenance/runners/", dockerfile)

    def test_secret_and_volume_names_are_explicitly_versioned(self):
        self.assertEqual(modal_config.RUNTIME_SECRET_NAME, "music-ai-worker-runtime")
        self.assertTrue(modal_config.MODEL_VOLUME_NAME.endswith("-v1"))
        self.assertEqual(
            modal_config.MT3_MODEL_VOLUME_NAME,
            "music-ai-mt3-models-v1",
        )
        self.assertTrue(modal_config.MR_MT3_MODEL_VOLUME_NAME.endswith("-v1"))
        self.assertEqual(
            modal_config.YOUR_MT3_MODEL_VOLUME_NAME,
            "music-ai-your-mt3-models-v2",
        )
        self.assertTrue(modal_config.JOB_VOLUME_NAME.endswith("-v1"))
        self.assertTrue(modal_config.OUTPUT_VOLUME_NAME.endswith("-v1"))

    def test_modal_uses_documented_concurrency_decorator(self):
        source = (ROOT / "modal_app.py").read_text()
        self.assertEqual(source.count("@modal.concurrent(max_inputs=1)"), 4)
        self.assertNotIn('"max_inputs":', source)

    def test_modal_images_use_distinct_provider_dockerfiles(self):
        source = (ROOT / "modal_app.py").read_text()
        self.assertIn("MUSIC_GPU_MODAL_DEPLOY_PROVIDERS", source)
        self.assertIn('"ACE_STEP,MT3,ALL_IN_ONE"', source)
        self.assertIn('LICENSE_BLOCKED_PROVIDERS = {"BS_ROFORMER"}', source)
        self.assertIn("release_providers & LICENSE_BLOCKED_PROVIDERS", source)
        self.assertEqual(source.count("modal.Image.from_dockerfile("), 4)
        dockerfiles = {
            provider: ROOT / f"Dockerfile.{provider.lower().replace('_', '-')}"
            for provider in modal_config.DEPLOYMENTS
            if provider not in {"MR_MT3", "YOUR_MT3"}
        }
        self.assertEqual(len(set(dockerfiles.values())), 4)
        for provider, dockerfile in dockerfiles.items():
            self.assertTrue(dockerfile.is_file())
            self.assertIn(
                f"Modal image identity: {provider}",
                dockerfile.read_text(),
            )
            self.assertIn(
                f'PROVIDER_DOCKERFILES["{provider}"]',
                source,
            )

    def test_wave_two_mt3_app_registers_only_its_own_providers(self):
        source = (ROOT / "mt3_family_modal_app.py").read_text()
        self.assertIn('APP_NAME = "music-ai-mt3-family-worker"', source)
        self.assertIn('Dockerfile.mr-mt3', source)
        self.assertIn('Dockerfile.your-mt3', source)
        self.assertIn('MR_MT3_MODEL_VOLUME_NAME', source)
        self.assertIn('YOUR_MT3_MODEL_VOLUME_NAME', source)
        self.assertIn('promotion_secret_name(provider)', source)
        self.assertNotIn("from modal_app import", source)
        for prohibited in ("ACE_STEP", "BS_ROFORMER", '"MT3"', "ALL_IN_ONE"):
            self.assertNotIn(prohibited, source)

    def test_modal_apps_are_provider_isolated(self):
        names = {
            provider: modal_config.provider_app_name(provider)
            for provider in modal_config.DEPLOYMENTS
        }
        self.assertEqual(len(set(names.values())), len(names))
        self.assertEqual(names["ACE_STEP"], "music-ai-gpu-worker-ace-step")
        self.assertEqual(names["MR_MT3"], "music-ai-mt3-family-worker-mr-mt3")
        source = (ROOT / "modal_app.py").read_text()
        self.assertIn('provider_apps["ACE_STEP"].cls', source)
        family_source = (ROOT / "mt3_family_modal_app.py").read_text()
        self.assertIn('provider_apps["MR_MT3"].cls', family_source)

    def test_wave_two_identity_does_not_read_legacy_image_inputs(self):
        """Matches the boundary of the MR/Your production and bootstrap images."""
        with tempfile.TemporaryDirectory() as directory:
            isolated = Path(directory)
            # A deployed Wave 2 image has neither Dockerfiles nor /provenance.
            # Its host-computed digest is injected at image build time.
            with mock.patch.object(modal_config, "SOURCE_ROOT", isolated), mock.patch.dict(
                __import__("os").environ,
                {
                    "MUSIC_GPU_RUNTIME_IDENTITY": "1",
                    "MUSIC_GPU_CONTAINER_DIGEST": "sha256:" + "a" * 64,
                },
            ):
                deployment = modal_config.DEPLOYMENTS["MR_MT3"]
            self.assertEqual(deployment.source_image_digest, "sha256:" + "a" * 64)

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

    def test_signed_promotion_bundle_records_identity_and_rotates_atomically(self):
        deployment = modal_config.DEPLOYMENTS["ACE_STEP"]
        record = modal_config.build_promotion_record(
            deployment,
            modal_app_id="ap-TestApp",
            modal_deployment_id="dp-TestDeployment",
            modal_function_id="fu-TestFunction",
            modal_image_id="im-TestImage123",
            endpoint_origin="https://workspace--music-ai-gpu-worker-ace-step.modal.run",
            checkpoint_sha256="A" * 64,
            source_revision="git-source-revision-1",
        )
        self.assertEqual(record["checkpointSha256"], "a" * 64)
        self.assertEqual(record["checkpointRevision"], deployment.source_revision)
        self.assertEqual(record["runtime"]["pytorch"], deployment.pytorch)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ace-step-promotion.json"
            private_key = Path(directory) / "promotion-private.pem"
            subprocess.run(
                [
                    "openssl", "genpkey", "-algorithm", "Ed25519",
                    "-out", str(private_key),
                ],
                check=True,
                capture_output=True,
            )
            first = modal_config.write_promotion_bundle(
                path, record, private_key
            )
            rotated_record = {
                **record,
                "modalImageId": "im-TestImage456",
                "checkpointSha256": "b" * 64,
            }
            second = modal_config.write_promotion_bundle(
                path, rotated_record, private_key
            )
            identity_path = Path(directory) / "worker-identity.json"
            identity = modal_config.write_worker_identity(identity_path, record)
            self.assertNotEqual(first["signature"], second["signature"])
            self.assertEqual(json.loads(path.read_text()), second)
            self.assertEqual(json.loads(identity_path.read_text()), identity)
            self.assertEqual(identity["MUSIC_GPU_MODAL_APP_ID"], "ap-TestApp")
            self.assertEqual(list(Path(directory).glob(".*.tmp")), [])

    def test_source_revision_is_passed_to_the_modal_worker(self):
        with mock.patch.dict(
            __import__("os").environ,
            {"MUSIC_GPU_SOURCE_REVISION": "git-source-revision-1"},
        ):
            environment = modal_config.worker_environment(
                modal_config.DEPLOYMENTS["ACE_STEP"]
            )
        self.assertEqual(
            environment["MUSIC_GPU_SOURCE_REVISION"],
            "git-source-revision-1",
        )

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

    def test_reviewed_manifest_checkpoint_hash_is_passed_to_mt3(self):
        environment = modal_config.worker_environment(
            modal_config.DEPLOYMENTS["MT3"]
        )
        self.assertEqual(
            environment["MUSIC_PROVIDER_MT3_CHECKPOINT_SHA256"],
            "33f6bc4c0410a1c7c1c426c5406566de0b7418af2dc3dfd798496f70cef85622",
        )
        details = modal_config.MANIFEST["providers"]["MT3"]
        self.assertEqual(details["model_version"], "mt3-pytorch-multitrack")
        self.assertEqual(details["checkpoint_license"], "Apache-2.0")
        self.assertEqual(
            details["checkpoint_asset_sha256"],
            "b8a3807ed265059abd25ad7f68142c06c35e8f6144dcaa45bd55946a3745398f",
        )
        self.assertTrue(
            details["official_checkpoint"]["all_converted_assignments_exact"]
        )

    def test_retained_mt3_l4_proof_is_historical_and_not_current_release_evidence(self):
        record = json.loads((ROOT / "smoke_proofs" / "mt3-l4.json").read_text())
        proof = record["proof"]
        provenance = proof["provenance"]
        deployment = modal_config.DEPLOYMENTS["MT3"]
        self.assertEqual(proof["provider"], deployment.provider)
        self.assertNotEqual(proof["modelVersion"], deployment.model_version)
        self.assertNotEqual(proof["revision"], deployment.source_revision)
        self.assertEqual(
            proof["checkpointSha256"],
            modal_config.worker_environment(deployment)[
                "MUSIC_PROVIDER_MT3_CHECKPOINT_SHA256"
            ],
        )
        self.assertTrue(proof["smokeTested"])
        self.assertTrue(proof["smokeFixture"]["nonSilent"])
        self.assertGreater(proof["output"]["notes"], 0)
        self.assertEqual(provenance["gpu"], "NVIDIA L4")
        self.assertEqual(provenance["modalImageId"], provenance["imageId"])
        self.assertRegex(
            provenance["sourceImageDigest"], r"^sha256:[0-9a-f]{64}$"
        )
        self.assertEqual(proof["checkpointLicense"], "NOASSERTION")
        self.assertEqual(
            proof["sourcePatch"],
            "Dockerfile.mt3:checkpoint-import-relocation",
        )
        for field in (
            "sourceRevision",
            "conversionSourceRevision",
            "upstreamSourceRevision",
            "checkpointLicense",
            "sourcePatch",
        ):
            self.assertEqual(provenance[field], proof[field])

    def test_mt3_bootstrap_verifies_files_and_publishes_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = {
                "config.json": b'{"model_type":"t5"}',
                "mt3.pth": b"reviewed-converted-weight",
            }
            reviewed = {
                name: {
                    "url": f"https://example.test/{name}",
                    "sha256": __import__("hashlib").sha256(content).hexdigest(),
                    "bytes": len(content),
                    "max_bytes": 1024,
                }
                for name, content in artifacts.items()
            }
            canonical = __import__("hashlib").sha256(
                b"config.json"
                + artifacts["config.json"]
                + b"mt3.pth"
                + artifacts["mt3.pth"]
            ).hexdigest()

            def download(url, destination, expected, max_bytes):
                content = artifacts[destination.name]
                self.assertEqual(
                    __import__("hashlib").sha256(content).hexdigest(), expected
                )
                self.assertLessEqual(len(content), max_bytes)
                destination.write_bytes(content)

            details = checkpoint_bootstrap.MANIFEST["providers"]["MT3"]
            with mock.patch.object(
                checkpoint_bootstrap, "MODEL_ROOT", root
            ), mock.patch.object(
                checkpoint_bootstrap,
                "SMOKE_FIXTURE",
                root / "_smoke" / "structured-click-track-32s.wav",
            ), mock.patch.object(
                checkpoint_bootstrap, "MT3_FILES", reviewed
            ), mock.patch.object(
                checkpoint_bootstrap, "_download_verified", side_effect=download
            ), mock.patch.dict(
                details, {"checkpoint_sha256": canonical}
            ):
                result = checkpoint_bootstrap.bootstrap_provider("MT3")

            destination = root / "mt3-official-multitrack"
            self.assertEqual(
                {item.name for item in destination.iterdir()}, set(artifacts)
            )
            self.assertEqual(result["digest"], canonical)
            self.assertEqual(list(root.glob(".bootstrap-mt3-*")), [])

    def test_bs_roformer_bootstrap_pins_and_atomically_publishes_weights_and_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            cache.mkdir()
            weights = b"verified-viperx-weights"
            config = b"verified-viperx-config"
            (cache / checkpoint_bootstrap.BS_CHECKPOINT_FILENAME).write_bytes(weights)
            (cache / checkpoint_bootstrap.BS_CONFIG_FILENAME).write_bytes(config)

            def hf_hub_download(**kwargs):
                self.assertEqual(
                    kwargs["repo_id"], "puar-playground/bs-roformer"
                )
                self.assertEqual(
                    kwargs["revision"],
                    "b1361b816daca507f079d85e935c291bcb0a5351",
                )
                return str(cache / kwargs["filename"])

            fake_hub = types.SimpleNamespace(hf_hub_download=hf_hub_download)
            with mock.patch.object(
                checkpoint_bootstrap, "MODEL_ROOT", root
            ), mock.patch.object(
                checkpoint_bootstrap,
                "SMOKE_FIXTURE",
                root / "_smoke" / "structured-click-track-32s.wav",
            ), mock.patch.object(
                checkpoint_bootstrap,
                "BS_CHECKPOINT_SHA256",
                __import__("hashlib").sha256(weights).hexdigest(),
            ), mock.patch.object(
                checkpoint_bootstrap, "BS_CHECKPOINT_SIZE", len(weights)
            ), mock.patch.object(
                checkpoint_bootstrap,
                "BS_CONFIG_SHA256",
                __import__("hashlib").sha256(config).hexdigest(),
            ), mock.patch.object(
                checkpoint_bootstrap, "BS_CONFIG_SIZE", len(config)
            ), mock.patch.dict(
                checkpoint_bootstrap.UNVERIFIED_SOURCES, {}, clear=True
            ), mock.patch.dict(sys.modules, {"huggingface_hub": fake_hub}):
                result = checkpoint_bootstrap.bootstrap_provider("BS_ROFORMER")

            self.assertEqual(
                (root / "bs-roformer-viperx-v1.ckpt").read_bytes(), weights
            )
            self.assertEqual(
                (root / "bs-roformer-viperx-v1.yaml").read_bytes(), config
            )
            self.assertEqual(
                result["revision"],
                "b1361b816daca507f079d85e935c291bcb0a5351",
            )
            self.assertEqual(list(root.glob(".bootstrap-bs_roformer-*")), [])

    def test_bs_roformer_bootstrap_is_blocked_before_checkpoint_download(self):
        fake_hub = types.SimpleNamespace(
            hf_hub_download=mock.Mock(
                side_effect=AssertionError("blocked bootstrap reached Hugging Face")
            )
        )
        with mock.patch.object(
            checkpoint_bootstrap, "_write_smoke_fixture"
        ), mock.patch.dict(sys.modules, {"huggingface_hub": fake_hub}):
            with self.assertRaisesRegex(
                RuntimeError, "checkpoint-owner license"
            ):
                checkpoint_bootstrap.bootstrap_provider("BS_ROFORMER")
        fake_hub.hf_hub_download.assert_not_called()

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

    def test_all_in_one_bootstrap_stages_every_verified_asset_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            details = checkpoint_bootstrap.MANIFEST["providers"]["ALL_IN_ONE"]

            def download(asset, destination):
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = (
                    b"structure"
                    if asset["kind"] == "structure-model"
                    else b"demucs"
                )
                destination.write_bytes(source)
                asset["size"] = len(source)
                asset["sha256"] = __import__("hashlib").sha256(source).hexdigest()

            assets = [dict(asset) for asset in details["assets"]]
            aggregate = __import__("hashlib").sha256()
            for asset in sorted(assets, key=lambda item: item["path"]):
                content = b"structure" if asset["kind"] == "structure-model" else b"demucs"
                aggregate.update(asset["path"].encode())
                aggregate.update(content)
            test_details = {
                **details,
                "assets": assets,
                "checkpoint_sha256": aggregate.hexdigest(),
            }
            manifest = {
                **checkpoint_bootstrap.MANIFEST,
                "providers": {
                    **checkpoint_bootstrap.MANIFEST["providers"],
                    "ALL_IN_ONE": test_details,
                },
            }
            with mock.patch.object(checkpoint_bootstrap, "MODEL_ROOT", root), \
                    mock.patch.object(
                        checkpoint_bootstrap, "SMOKE_FIXTURE",
                        root / "_smoke" / "non-silent-440hz-1s.wav",
                    ), mock.patch.object(
                        checkpoint_bootstrap, "MANIFEST", manifest,
                    ), mock.patch.object(
                        checkpoint_bootstrap, "_download_asset", side_effect=download,
                    ):
                result = checkpoint_bootstrap.bootstrap_provider("ALL_IN_ONE")
            destination = root / "all-in-one"
            self.assertTrue(destination.is_dir())
            self.assertFalse(list(root.glob(".bootstrap-all_in_one-*")))
            self.assertEqual(result["digest"], aggregate.hexdigest())
            self.assertEqual(
                {item.relative_to(destination).as_posix()
                 for item in destination.rglob("*") if item.is_file()},
                {asset["path"] for asset in assets},
            )
