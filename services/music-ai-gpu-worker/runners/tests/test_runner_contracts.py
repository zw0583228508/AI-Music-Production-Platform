"""Contract tests use fakes only; they do not attest model inference."""
from __future__ import annotations

import hashlib
import tempfile
import unittest
import os
import sys
import types
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from runners import ace_step, bs_roformer, mt3
from runners import common
from runners.common import RunnerError


def _make_ace_checkpoint(parent: Path) -> Path:
    root = parent / ace_step.COMPOSITE_ROOT_NAME
    root.mkdir()
    for name in ace_step.REQUIRED_SUBTREES:
        (root / name).mkdir()
    for name in ace_step.REQUIRED_BASE_FILES:
        (root / ace_step.BASE_CONFIG_NAME / name).write_bytes(
            f"attested-{name}".encode()
        )
    return root


class RunnerContractTests(unittest.TestCase):
    def test_mt3_uses_official_model_rate_audio_resampling(self) -> None:
        calls = {}

        def load_audio(path, sr):
            calls["load"] = (path, sr)
            return [0.0] * sr, sr

        def transcribe(samples, **kwargs):
            calls["transcribe"] = (len(samples), kwargs)
            return object()

        fake_mt3 = types.ModuleType("mt3_infer")
        fake_mt3.__path__ = []
        fake_mt3.get_model_info = lambda model: {
            "metadata": {"sample_rate": 16_000},
        }
        fake_mt3.transcribe = transcribe
        fake_utils = types.ModuleType("mt3_infer.utils")
        fake_utils.__path__ = []
        fake_audio = types.ModuleType("mt3_infer.utils.audio")
        fake_audio.load_audio = load_audio
        with patch.object(mt3, "require_distribution_version"), patch.object(
            mt3, "_midi_notes", return_value=[]
        ), patch.dict(sys.modules, {
            "mt3_infer": fake_mt3,
            "mt3_infer.utils": fake_utils,
            "mt3_infer.utils.audio": fake_audio,
        }), patch.dict(os.environ, {"MT3_INFER_MODEL": "mr_mt3"}):
            mt3.OfficialMt3Backend().transcribe(
                Path("/tmp/reviewed-44k-fixture.wav"), Path("/models/mr_mt3/mt3.pth")
            )

        self.assertEqual(calls["load"], ("/tmp/reviewed-44k-fixture.wav", 16_000))
        self.assertEqual(calls["transcribe"][1]["sr"], 16_000)
        self.assertEqual(calls["transcribe"][1]["model"], "mr_mt3")

    def test_smoke_fixture_must_be_inside_model_volume(self) -> None:
        with tempfile.TemporaryDirectory() as volume, tempfile.TemporaryDirectory() as other:
            fixture = Path(other) / "smoke.wav"
            fixture.write_bytes(b"not-read-because-location-is-rejected")
            with patch.dict(os.environ, {
                "MUSIC_GPU_CHECKPOINT_ROOT": volume,
                "MUSIC_GPU_SMOKE_INPUT_PATH": str(fixture),
            }), self.assertRaisesRegex(RunnerError, "inside"):
                common.smoke_input_path(Path(volume) / "model.ckpt", "YOUR_MT3")

    def test_smoke_fixture_uses_job_audio_validation(self) -> None:
        with tempfile.TemporaryDirectory() as volume:
            fixture = Path(volume) / "smoke.wav"
            fixture.write_bytes(b"fixture")
            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            with patch.dict(os.environ, {
                "MUSIC_GPU_CHECKPOINT_ROOT": volume,
                "MUSIC_GPU_SMOKE_INPUT_PATH": str(fixture),
                "MUSIC_PROVIDER_YOUR_MT3_SMOKE_INPUT_SHA256": digest,
            }), patch.object(common, "validate_audio") as validate:
                self.assertEqual(
                    common.smoke_input_path(
                        Path(volume) / "model.ckpt", "YOUR_MT3",
                    ),
                    fixture,
                )
                validate.assert_called_once_with(fixture)

    def test_smoke_fixture_must_match_provider_sha256_pin(self) -> None:
        with tempfile.TemporaryDirectory() as volume:
            fixture = Path(volume) / "smoke.wav"
            fixture.write_bytes(b"tampered-fixture")
            with patch.dict(os.environ, {
                "MUSIC_GPU_CHECKPOINT_ROOT": volume,
                "MUSIC_GPU_SMOKE_INPUT_PATH": str(fixture),
                "MUSIC_PROVIDER_YOUR_MT3_SMOKE_INPUT_SHA256": "0" * 64,
            }), patch.object(common, "validate_audio"), self.assertRaisesRegex(
                RunnerError, "does not match"
            ):
                common.smoke_input_path(
                    Path(volume) / "model.ckpt", "YOUR_MT3",
                )

    def test_unpinned_mt3_fixture_preserves_existing_smoke_contract(self) -> None:
        with tempfile.TemporaryDirectory() as volume:
            fixture = Path(volume) / "smoke.wav"
            fixture.write_bytes(b"reviewed-existing-fixture")
            with patch.dict(os.environ, {
                "MUSIC_GPU_CHECKPOINT_ROOT": volume,
                "MUSIC_GPU_SMOKE_INPUT_PATH": str(fixture),
            }, clear=True), patch.object(common, "validate_audio") as validate:
                self.assertEqual(
                    common.smoke_input_path(
                        Path(volume) / "model.ckpt", "MT3",
                    ),
                    fixture,
                )
                validate.assert_called_once_with(fixture)

    def test_verified_provider_pins(self) -> None:
        self.assertEqual(bs_roformer.BACKEND_VERSION, "0.1.5")
        self.assertEqual(
            bs_roformer.BACKEND_PACKAGE_ARTIFACT_SHA256,
            "46f3d5eb4b666a54adcb67524258c3cb6f96e185db97a3e1e1ef7efaea4e1848",
        )
        self.assertIn("b0f1386fcced25f559f3e61c9f08a73cd9bddf80",
                      bs_roformer.BACKEND_SOURCE_REVISION)
        self.assertEqual(ace_step.MODEL_SOURCE, "ACE-Step/acestep-v15-base")
        self.assertIn("e432212fec32b8965a14ffa57ae653438d6abd14",
                      ace_step.MODEL_SNAPSHOT)
        self.assertIn("19671f406d603126926c1b7e2adc169acbcade22",
                      ace_step.SHARED_MODEL_SNAPSHOT)
        self.assertIn("ca1e85fe9430179831e6bc6be790c332190a3866",
                      ace_step.BACKEND_SOURCE_REVISION)

    def test_ace_backend_uses_documented_api_with_fake_modules(self) -> None:
        calls = {}
        class Handler:
            def initialize_service(self, **kwargs):
                calls["initialize"] = kwargs
                runtime_root = Path(kwargs["project_root"])
                runtime_base = runtime_root / kwargs["config_path"]
                calls["runtime_root"] = runtime_root
                calls["model_targets"] = {
                    name: (runtime_base / name).resolve()
                    for name in ace_step.REQUIRED_BASE_FILES
                }
                # Reproduce the official handler's source synchronization.
                for name in (
                    "configuration_acestep_v15.py",
                    "modeling_acestep_v15_base.py",
                    "apg_guidance.py",
                ):
                    (runtime_base / name).write_text("# synced by handler\n")
                return "loaded", True
        class LLM:
            def initialize_service(self, **_kwargs):
                calls["llm_initialize"] = True
        class Params:
            def __init__(self, **kwargs): calls["params"] = kwargs
        class Config:
            def __init__(self, **kwargs): calls["config"] = kwargs
        def generate(*args, **kwargs):
            calls["generate"] = kwargs
            return types.SimpleNamespace(success=True, audios=[{"path": "a.flac"}], error=None)
        modules = {
            "acestep": types.ModuleType("acestep"),
            "acestep.handler": types.SimpleNamespace(AceStepHandler=Handler),
            "acestep.llm_inference": types.SimpleNamespace(LLMHandler=LLM),
            "acestep.inference": types.SimpleNamespace(
                GenerationConfig=Config, GenerationParams=Params, generate_music=generate),
        }
        with tempfile.TemporaryDirectory() as raw, \
             patch.dict(sys.modules, modules), patch.object(ace_step, "require_cuda"), \
             patch.object(ace_step, "ace_runtime_provenance", return_value={}):
            root = _make_ace_checkpoint(Path(raw))
            original = {
                name: (root / ace_step.BASE_CONFIG_NAME / name).read_bytes()
                for name in ace_step.REQUIRED_BASE_FILES
            }
            original_digest = common.checkpoint_sha256(root)
            backend = ace_step.OfficialAceStepBackend(root)
            outputs = backend.generate(prompt="piano", seed=7, duration_seconds=2,
                                       candidates=1, output_dir=root)
            after = {
                name: (root / ace_step.BASE_CONFIG_NAME / name).read_bytes()
                for name in ace_step.REQUIRED_BASE_FILES
            }
            after_digest = common.checkpoint_sha256(root)
        self.assertEqual(outputs, [{"path": "a.flac"}])
        self.assertNotEqual(calls["initialize"]["project_root"], str(root.resolve()))
        self.assertEqual(calls["initialize"]["config_path"], "acestep-v15-base")
        self.assertNotIn("checkpoint_dir", calls["initialize"])
        self.assertFalse(calls["initialize"]["use_mlx_dit"])
        self.assertEqual(calls["initialize"]["device"], "cuda")
        self.assertEqual(calls["config"]["seeds"], [7])
        self.assertFalse(calls["params"]["thinking"])
        self.assertNotIn("llm_initialize", calls)
        self.assertEqual(
            os.environ["ACESTEP_CHECKPOINTS_DIR"], str(calls["runtime_root"])
        )
        self.assertFalse(calls["runtime_root"].exists())
        self.assertEqual(original, after)
        self.assertEqual(original_digest, after_digest)
        for target in calls["model_targets"].values():
            self.assertTrue(root.resolve() in target.parents)
        for name in (
            "configuration_acestep_v15.py",
            "modeling_acestep_v15_base.py",
            "apg_guidance.py",
        ):
            self.assertFalse((root / ace_step.BASE_CONFIG_NAME / name).exists())
        self.assertEqual(os.environ["PYTHONDONTWRITEBYTECODE"], "1")

    def test_ace_backend_fails_closed_when_shared_subtree_missing(self) -> None:
        with tempfile.TemporaryDirectory() as raw, \
             patch.object(ace_step, "require_cuda"), \
             patch.object(ace_step, "ace_runtime_provenance", return_value={}):
            root = Path(raw) / ace_step.COMPOSITE_ROOT_NAME
            root.mkdir()
            (root / ace_step.BASE_CONFIG_NAME).mkdir()
            (root / "vae").mkdir()
            with self.assertRaisesRegex(RunnerError, "Qwen3-Embedding-0.6B"):
                ace_step.OfficialAceStepBackend(root)

    def test_ace_backend_rejects_config_other_than_base_basename(self) -> None:
        with tempfile.TemporaryDirectory() as raw, \
             patch.dict(os.environ, {
                 "MUSIC_PROVIDER_ACE_STEP_CONFIG_PATH": "../acestep-v15-base",
             }), patch.object(ace_step, "require_cuda"), \
             patch.object(ace_step, "ace_runtime_provenance", return_value={}):
            root = _make_ace_checkpoint(Path(raw))
            with self.assertRaisesRegex(RunnerError, "must equal"):
                ace_step.OfficialAceStepBackend(root)

    def test_ace_checkpoint_rejects_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            parent = Path(raw)
            root = _make_ace_checkpoint(parent)
            outside = parent / "outside.safetensors"
            outside.write_bytes(b"not-attested")
            model = root / ace_step.BASE_CONFIG_NAME / "model.safetensors"
            model.unlink()
            model.symlink_to(outside)
            with self.assertRaisesRegex(RunnerError, "escapes attested root"):
                ace_step._validated_composite_root(root)

    def test_ace_runtime_rejects_stale_torch_pin(self) -> None:
        versions = {
            "torch": "2.5.1+cu124",
            "torchvision": ace_step.TORCHVISION_VERSION,
            "torchaudio": ace_step.TORCHAUDIO_VERSION,
        }
        with patch.object(ace_step, "version", side_effect=lambda name: versions[name]):
            with self.assertRaisesRegex(RunnerError, "does not match"):
                ace_step.ace_runtime_provenance()
    def test_ace_rejects_unbounded_candidate_request(self) -> None:
        with self.assertRaisesRegex(RunnerError, "candidateCount"):
            ace_step._parameters({"prompt": "drums", "candidateCount": 99})

    def test_ace_rejects_empty_prompt(self) -> None:
        with self.assertRaisesRegex(RunnerError, "prompt"):
            ace_step._parameters({"prompt": "  "})

    def test_bs_requires_two_stems_from_fake_backend(self) -> None:
        class OneStem:
            def __init__(self, *_args): pass
            def separate(self, _source): return [Path("one.wav")]

        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            checkpoint = root / "model.ckpt"
            checkpoint.write_bytes(b"pinned")
            work = root / "output"
            work.mkdir()
            with patch.dict(os.environ, {"MUSIC_PROVIDER_BS_ROFORMER_CHECKPOINT_SHA256":
                                         "d5c7" + "0" * 60}), \
                 patch.object(bs_roformer, "attest_checkpoint", return_value="a" * 64), \
                 patch.object(bs_roformer, "require_cuda"), \
                 patch.object(bs_roformer, "durable_job_dir", return_value=work), \
                 patch.object(bs_roformer, "materialize_source", return_value=work / "source.wav"), \
                 patch.object(bs_roformer, "validate_audio", return_value={
                     "path": str(work / "source.wav"), "sha256": "f" * 64,
                 }):
                with self.assertRaisesRegex(RunnerError, "exactly two"):
                    bs_roformer.run_job({"sourceUrl": "https://example.test/a.wav"}, checkpoint, OneStem)

    def test_bs_backend_uses_explicit_local_assets_with_documented_api(self) -> None:
        calls = {}

        def proc_folder(args):
            calls["args"] = args
            source_dir = Path(args[args.index("--input_folder") + 1])
            output_dir = Path(args[args.index("--store_dir") + 1])
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / f"{next(source_dir.glob('*.wav')).stem}_vocals.wav").write_bytes(
                b"vocals"
            )
            (
                output_dir
                / f"{next(source_dir.glob('*.wav')).stem}_instrumental.wav"
            ).write_bytes(b"instrumental")

        package = types.ModuleType("bs_roformer")
        package.__path__ = []
        inference = types.ModuleType("bs_roformer.inference")
        inference.proc_folder = proc_folder
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            checkpoint = root / "model.ckpt"
            checkpoint.write_bytes(b"weights")
            config = root / "config.yaml"
            config.write_bytes(b"config")
            source = root / "source.wav"
            source.write_bytes(b"audio")
            with patch.dict(
                os.environ,
                {
                    "MUSIC_PROVIDER_BS_ROFORMER_CONFIG_PATH": str(config),
                    "MUSIC_PROVIDER_BS_ROFORMER_CONFIG_SHA256": common.file_sha256(
                        config
                    ),
                },
            ), patch.dict(
                sys.modules,
                {"bs_roformer": package, "bs_roformer.inference": inference},
            ), patch.object(
                bs_roformer, "require_distribution_version"
            ):
                outputs = bs_roformer.BSRoformerInferBackend(
                    checkpoint, root / "outputs"
                ).separate(source)

        self.assertEqual(
            outputs,
            [Path(raw) / "outputs/source_vocals.wav",
             Path(raw) / "outputs/source_instrumental.wav"],
        )
        self.assertEqual(
            calls["args"][calls["args"].index("--model_path") + 1],
            str(checkpoint),
        )
        self.assertEqual(
            calls["args"][calls["args"].index("--config_path") + 1],
            str(config),
        )
        self.assertNotIn("--model", calls["args"])

    def test_bs_provenance_separates_checkpoint_and_backend_revisions(self) -> None:
        with patch.object(
            bs_roformer,
            "runtime_provenance",
            return_value={
                "sourceImageDigest": "sha256:" + "b" * 64,
                "modalImageId": "im-Test",
                "cudaVersion": "12.4",
                "pytorchVersion": "2.5.1+cu124",
                "gpu": "NVIDIA L4",
            },
        ), patch.object(
            bs_roformer, "backend_package_tree_sha256", return_value="c" * 64,
        ), patch.dict(os.environ, {
            "MUSIC_PROVIDER_BS_ROFORMER_CONFIG_SHA256": "d" * 64,
        }):
            provenance = bs_roformer.provenance("a" * 64)
        self.assertEqual(
            provenance["revision"], bs_roformer.CHECKPOINT_SOURCE_REVISION
        )
        self.assertEqual(
            provenance["backendSourceRevision"],
            bs_roformer.BACKEND_SOURCE_REVISION,
        )
        self.assertEqual(provenance["configSha256"], "d" * 64)
        self.assertEqual(provenance["backendPackageTreeSha256"], "c" * 64)

    def test_ace_fails_when_fake_backend_returns_wrong_count(self) -> None:
        class OneCandidate:
            def __init__(self, *_args): pass
            def generate(self, **_kwargs): return [{"path": "one.flac"}]

        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            checkpoint = root / "checkpoint"
            checkpoint.mkdir()
            (checkpoint / "config.json").write_text("{}")
            work = root / "output"
            work.mkdir()
            with patch.dict(os.environ, {"MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256":
                                         "0" * 64}), \
                 patch.object(ace_step, "attest_checkpoint", return_value="a" * 64), \
                 patch.object(ace_step, "require_cuda"), \
                 patch.object(ace_step, "durable_job_dir", return_value=work):
                with self.assertRaisesRegex(RunnerError, "different number"):
                    ace_step.run_job({"prompt": "piano", "candidateCount": 2}, checkpoint, OneCandidate)


if __name__ == "__main__":
    unittest.main()