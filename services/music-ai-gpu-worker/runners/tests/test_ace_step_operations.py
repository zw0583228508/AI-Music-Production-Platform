"""ACE-Step operation contract tests use fakes only."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from runners import ace_step
from runners.common import RunnerError


class AceStepOperationTests(unittest.TestCase):
    def source_request(self, operation: str, **extra):
        return {
            "operation": operation,
            "sourceAudio": {
                "artifactId": "source-1",
                "url": "https://objects.example.test/source",
            },
            **extra,
        }

    def test_all_explicit_operations_map_to_official_task_types(self) -> None:
        for operation in sorted(ace_step.OPERATIONS):
            extra = {"instrument": "bass"} if operation in {"LEGO", "EXTRACT"} else {}
            if operation == "REPAINT":
                extra["region"] = {
                    "unit": "time",
                    "start": 4,
                    "end": 8,
                    "crossfadeSeconds": 0.5,
                }
            with self.subTest(operation=operation):
                normalized = ace_step._operation_parameters(
                    self.source_request(operation, **extra)
                )
                self.assertEqual(normalized["task_type"], operation.lower())
                self.assertEqual(normalized["source_artifact_id"], "source-1")

    def test_focused_operations_require_an_instrument(self) -> None:
        for operation in ("LEGO", "EXTRACT"):
            with self.subTest(operation=operation), self.assertRaisesRegex(
                RunnerError, "focused instrument"
            ):
                ace_step._operation_parameters(self.source_request(operation))

    def test_repaint_converts_bar_and_beat_regions_from_song_model(self) -> None:
        song = {
            "tempoMap": [{"time": 0, "bpm": 120}],
            "meterMap": [{"bar": 1, "meter": "3/4"}],
        }
        self.assertEqual(
            ace_step._region_seconds(
                {"songModel": song},
                {"unit": "bar", "start": 2, "end": 4},
            ),
            (1.5, 4.5),
        )
        self.assertEqual(
            ace_step._region_seconds(
                {"songModel": song},
                {"unit": "beat", "start": 4, "end": 8},
            ),
            (2.0, 4.0),
        )

    def test_repaint_honors_later_tempo_and_meter_changes(self) -> None:
        song = {
            "tempoMap": [
                {"time": 0, "bpm": 120},
                {"time": 4, "bpm": 60},
            ],
            "meterMap": [
                {"bar": 1, "meter": "4/4"},
                {"bar": 3, "meter": "3/4"},
            ],
        }
        self.assertEqual(
            ace_step._region_seconds(
                {"songModel": song},
                {"unit": "bar", "start": 3, "end": 5},
            ),
            (4.0, 10.0),
        )

    def test_official_backend_receives_source_and_repaint_fields(self) -> None:
        captured: dict[str, object] = {}

        class RuntimeView:
            def cleanup(self) -> None:
                captured["cleaned"] = True

        class Params:
            def __init__(self, **kwargs):
                captured["params"] = kwargs

        class Config:
            def __init__(self, **kwargs):
                captured["config"] = kwargs

        class Result:
            success = True
            error = None
            audios = [{"path": "candidate.flac"}]

        backend = ace_step.OfficialAceStepBackend.__new__(
            ace_step.OfficialAceStepBackend
        )
        backend.GenerationParams = Params
        backend.GenerationConfig = Config
        backend.dit_handler = object()
        backend.llm_handler = object()
        backend._runtime_view = RuntimeView()
        backend.generate_music = lambda *_args, **_kwargs: Result()

        with tempfile.TemporaryDirectory() as raw:
            source = Path(raw) / "source.wav"
            source.write_bytes(b"source")
            backend.generate(
                prompt="cinematic strings",
                seed=7,
                duration_seconds=30,
                candidates=1,
                output_dir=Path(raw),
                source_path=source,
                operation={
                    "operation": "REPAINT",
                    "task_type": "repaint",
                    "repainting_start": 2.0,
                    "repainting_end": 5.0,
                    "crossfade_seconds": 0.4,
                },
            )

        params = captured["params"]
        self.assertEqual(params["task_type"], "repaint")
        self.assertEqual(params["src_audio"], str(source))
        self.assertEqual(params["repainting_start"], 2.0)
        self.assertEqual(params["repainting_end"], 5.0)
        self.assertEqual(params["repaint_wav_crossfade_sec"], 0.4)
        self.assertEqual(params["chunk_mask_mode"], "explicit")
        self.assertTrue(captured["cleaned"])


if __name__ == "__main__":
    unittest.main()