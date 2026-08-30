"""ACE-Step 1.5 Base runner using a mounted official checkpoint only."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .common import (RunnerError, checkpoint_sha256, durable_job_dir, emit,
                     require_cuda, validate_audio)

PROVIDER = "ACE_STEP"
MODEL_VERSION = "ace-step-1.5-base"
BACKEND_DISTRIBUTION = "ace-step"
BACKEND_VERSION = "1.5.0"
BACKEND_SOURCE_REVISION = "ACE-Step/ACE-Step@v1.5.0"
MAX_CANDIDATES = 4
MAX_SECONDS = 120


class OfficialAceStepBackend:
    """Thin adapter around ACE-Step's official local-checkpoint pipeline."""
    def __init__(self, checkpoint: Path) -> None:
        torch = require_cuda()
        if not checkpoint.is_dir():
            raise RunnerError("ACE-Step checkpoint is not a mounted directory")
        try:
            # The official package exposes this pipeline; no remote-code loader is used.
            from acestep.pipeline_ace_step import ACEStepPipeline
        except ImportError as exc:
            raise RunnerError("official ace-step package is not installed") from exc
        try:
            self.pipeline = ACEStepPipeline.from_pretrained(
                str(checkpoint), local_files_only=True, torch_dtype=torch.float16
            ).to("cuda")
        except Exception as exc:
            raise RunnerError(f"unable to load mounted ACE-Step checkpoint: {type(exc).__name__}") from exc

    def generate(self, *, prompt: str, seed: int, duration_seconds: float,
                 candidates: int) -> tuple[list[Any], int]:
        try:
            result = self.pipeline.generate(
                prompt=prompt, seed=seed, duration=duration_seconds,
                num_samples=candidates,
            )
        except Exception as exc:
            raise RunnerError(f"ACE-Step inference failed: {type(exc).__name__}") from exc
        # Official pipeline releases return either ``audios`` or a list of samples.
        audios = getattr(result, "audios", result)
        sample_rate = int(getattr(result, "sample_rate", 44100))
        if not isinstance(audios, (list, tuple)):
            audios = [audios]
        return list(audios), sample_rate


def _parameters(request: dict[str, Any]) -> tuple[str, int, float, int]:
    prompt = request.get("prompt")
    if not isinstance(prompt, str):
        song = request.get("songModel") or request.get("song")
        prompt = song.get("prompt") if isinstance(song, dict) else None
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000:
        raise RunnerError("canonical prompt is required and must be at most 4000 characters")
    params = request.get("parameters") if isinstance(request.get("parameters"), dict) else {}
    seed = params.get("seed", request.get("seed", 0))
    count = params.get("candidateCount", request.get("candidateCount", 1))
    duration = params.get("durationSeconds", request.get("durationSeconds", 30))
    if not isinstance(seed, int) or seed < 0 or seed > 2**32 - 1:
        raise RunnerError("seed must be an unsigned 32-bit integer")
    if not isinstance(count, int) or not 1 <= count <= MAX_CANDIDATES:
        raise RunnerError(f"candidateCount must be between 1 and {MAX_CANDIDATES}")
    if not isinstance(duration, (int, float)) or not 1 <= duration <= MAX_SECONDS:
        raise RunnerError(f"durationSeconds must be between 1 and {MAX_SECONDS}")
    return prompt.strip(), seed, float(duration), count


def _write_audio(value: Any, sample_rate: int, path: Path) -> None:
    try:
        import numpy as np
        import soundfile as sf
        if hasattr(value, "detach"):
            value = value.detach().float().cpu().numpy()
        data = np.asarray(value)
        if data.ndim == 1:
            data = data[:, None]
        elif data.ndim == 2 and data.shape[0] <= 8 and data.shape[1] > data.shape[0]:
            data = data.T
        if data.ndim != 2:
            raise RunnerError("ACE-Step returned audio with an invalid shape")
        sf.write(str(path), data, sample_rate, format="FLAC")
    except RunnerError:
        raise
    except Exception as exc:
        raise RunnerError(f"could not persist ACE-Step output: {type(exc).__name__}") from exc


def provenance(checkpoint: Path) -> dict[str, str]:
    return {"provider": PROVIDER, "modelVersion": MODEL_VERSION,
            "checkpointSha256": checkpoint_sha256(checkpoint),
            "backend": BACKEND_DISTRIBUTION, "backendVersion": BACKEND_VERSION,
            "sourceRevision": BACKEND_SOURCE_REVISION, "device": "cuda"}


def run_job(request: dict[str, Any], checkpoint: Path,
            backend_cls=OfficialAceStepBackend) -> dict[str, Any]:
    require_cuda()
    prompt, seed, duration, count = _parameters(request)
    work = durable_job_dir(request, PROVIDER)
    audios, sample_rate = backend_cls(checkpoint).generate(
        prompt=prompt, seed=seed, duration_seconds=duration, candidates=count
    )
    if len(audios) != count:
        raise RunnerError("ACE-Step returned a different number of candidates")
    candidates = []
    for number, audio in enumerate(audios):
        artifact_path = work / f"candidate-{number + 1}.flac"
        _write_audio(audio, sample_rate, artifact_path)
        artifact = validate_audio(artifact_path)
        candidates.append({"id": f"candidate-{number + 1}", "seed": seed + number,
                           "artifact": artifact, "artifacts": [artifact],
                           "provenance": provenance(checkpoint)})
    return {"candidates": candidates, "provenance": provenance(checkpoint)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--smoke", action="store_true")
    mode.add_argument("--job", action="store_true")
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--checkpoint", required=True)
    args = parser.parse_args(argv)
    try:
        if args.provider != PROVIDER or args.model_version != MODEL_VERSION:
            raise RunnerError("provider or model version does not match this runner")
        checkpoint = Path(args.checkpoint)
        if args.smoke:
            prompt = os.environ.get("MUSIC_GPU_SMOKE_PROMPT")
            if not prompt:
                raise RunnerError("MUSIC_GPU_SMOKE_PROMPT is required for real smoke inference")
            result = run_job({"requestId": f"smoke-{os.urandom(8).hex()}", "prompt": prompt,
                              "seed": 0, "durationSeconds": 2, "candidateCount": 1}, checkpoint)
            emit({"smokeTested": True, **provenance(checkpoint),
                  "output": {"samples": len(result["candidates"])}})
        else:
            emit(run_job(json.load(sys.stdin), checkpoint))
        return 0
    except (RunnerError, json.JSONDecodeError) as exc:
        print(f"runner error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())