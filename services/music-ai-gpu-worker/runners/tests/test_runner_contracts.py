"""Contract tests use fakes only; they do not attest model inference."""
from __future__ import annotations

import tempfile
import unittest
import os
import sys
import types
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from runners import ace_step, bs_roformer
from runners.common import RunnerError


class RunnerContractTests(unittest.TestCase):
    def test_verified_provider_pins(self) -> None:
        self.assertEqual(bs_roformer.BACKEND_VERSION, "0.1.5")
        self.assertIn("b0f1386fcced25f559f3e61c9f08a73cd9bddf80",
                      bs_roformer.BACKEND_SOURCE_REVISION)
        self.assertEqual(ace_step.MODEL_SOURCE, "ACE-Step/acestep-v15-base")
        self.assertIn("ca1e85fe9430179831e6bc6be790c332190a3866",
                      ace_step.BACKEND_SOURCE_REVISION)

    def test_ace_backend_uses_documented_api_with_fake_modules(self) -> None:
        calls = {}
        class Handler:
            def initialize_service(self, **kwargs): calls["initialize"] = kwargs
        class LLM: pass
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
             patch.dict(sys.modules, modules), patch.object(ace_step, "require_cuda"):
            backend = ace_step.OfficialAceStepBackend(Path(raw))
            outputs = backend.generate(prompt="piano", seed=7, duration_seconds=2,
                                       candidates=1, output_dir=Path(raw))
        self.assertEqual(outputs, [{"path": "a.flac"}])
        self.assertEqual(calls["initialize"]["checkpoint_dir"], raw)
        self.assertEqual(calls["initialize"]["device"], "cuda")
        self.assertEqual(calls["config"]["seeds"], [7])

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
                 patch.object(bs_roformer, "download_source", return_value=work / "source.wav"):
                with self.assertRaisesRegex(RunnerError, "exactly two"):
                    bs_roformer.run_job({"sourceUrl": "https://example.test/a.wav"}, checkpoint, OneStem)

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