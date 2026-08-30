"""ACE-Step 1.5 Base runner using a mounted official checkpoint only."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .common import (RunnerError, artifact_descriptor, attest_checkpoint, cached_result,
                     durable_job_dir, emit, require_cuda, runtime_provenance, save_result)

PROVIDER = "ACE_STEP"
MODEL_VERSION = "ace-step-1.5-base"
BACKEND_DISTRIBUTION = "ace-step"
BACKEND_VERSION = "ca1e85fe9430179831e6bc6be790c332190a3866"
BACKEND_SOURCE_REVISION = "ace-step/ACE-Step-1.5@ca1e85fe9430179831e6bc6be790c332190a3866"
MODEL_SOURCE = "ACE-Step/acestep-v15-base"
MAX_CANDIDATES = 4
MAX_SECONDS = 120


class OfficialAceStepBackend:
    """Adapter for the documented official inference API at the pinned revision."""
    def __init__(self, checkpoint: Path) -> None:
        require_cuda()
        if not checkpoint.is_dir():
            raise RunnerError("ACE-Step checkpoint is not a mounted directory")
        try:
            from acestep.handler import AceStepHandler
            from acestep.inference import GenerationConfig, GenerationParams, generate_music
            from acestep.llm_inference import LLMHandler
        except ImportError as exc:
            raise RunnerError("official ace-step package is not installed") from exc
        try:
            self.dit_handler = AceStepHandler()
            self.llm_handler = LLMHandler()
            self.dit_handler.initialize_service(
                checkpoint_dir=str(checkpoint),
                config_path=os.environ.get("MUSIC_PROVIDER_ACE_STEP_CONFIG_PATH",
                                           "acestep-v15-base"),
                device="cuda",
            )
        except Exception as exc:
            raise RunnerError(f"unable to load mounted ACE-Step checkpoint: {type(exc).__name__}") from exc
        self.GenerationConfig = GenerationConfig
        self.GenerationParams = GenerationParams
        self.generate_music = generate_music

    def generate(self, *, prompt: str, seed: int, duration_seconds: float,
                 candidates: int, output_dir: Path) -> list[dict[str, Any]]:
        try:
            params = self.GenerationParams(
                task_type="text2music", caption=prompt, duration=duration_seconds,
                thinking=False,
            )
            config = self.GenerationConfig(
                batch_size=candidates, audio_format="flac", use_random_seed=False,
                seeds=[seed + index for index in range(candidates)],
            )
            result = self.generate_music(
                self.dit_handler, self.llm_handler, params, config,
                save_dir=str(output_dir),
            )
        except Exception as exc:
            raise RunnerError(f"ACE-Step inference failed: {type(exc).__name__}") from exc
        if not result.success:
            raise RunnerError(f"ACE-Step generation failed: {result.error or 'unknown error'}")
        if not isinstance(result.audios, list):
            raise RunnerError("ACE-Step returned invalid audio metadata")
        return result.audios


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


def provenance(digest: str) -> dict[str, str]:
    return {"provider": PROVIDER, "modelVersion": MODEL_VERSION,
            "checkpointSha256": digest,
            "backend": BACKEND_DISTRIBUTION, "backendVersion": BACKEND_VERSION,
            "revision": BACKEND_SOURCE_REVISION, "sourceRevision": BACKEND_SOURCE_REVISION,
            "model": MODEL_SOURCE, "device": "cuda", **runtime_provenance()}


def run_job(request: dict[str, Any], checkpoint: Path,
            backend_cls=OfficialAceStepBackend) -> dict[str, Any]:
    prompt, seed, duration, count = _parameters(request)
    digest = attest_checkpoint(checkpoint, PROVIDER)
    work = durable_job_dir(request, PROVIDER)
    prior = cached_result(work)
    if prior is not None:
        return prior
    require_cuda()
    audios = backend_cls(checkpoint).generate(
        prompt=prompt, seed=seed, duration_seconds=duration, candidates=count,
        output_dir=work,
    )
    if len(audios) != count:
        raise RunnerError("ACE-Step returned a different number of candidates")
    candidates = []
    for number, audio in enumerate(audios):
        if not isinstance(audio, dict) or not isinstance(audio.get("path"), str):
            raise RunnerError("ACE-Step returned an invalid audio entry")
        artifact_path = Path(audio["path"])
        if not artifact_path.is_absolute():
            artifact_path = work / artifact_path
        if work.resolve() not in artifact_path.resolve().parents:
            raise RunnerError("ACE-Step output escaped the durable job directory")
        artifact = artifact_descriptor(artifact_path, PROVIDER, work.name)
        candidates.append({"id": f"candidate-{number + 1}", "seed": seed + number,
                           "artifact": artifact, "artifacts": [artifact],
                           "provenance": provenance(digest)})
    result = {"candidates": candidates, "provenance": provenance(digest)}
    save_result(work, result)
    return result


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
            emit({"smokeTested": True, **result["provenance"],
                  "output": {"samples": len(result["candidates"])}})
        else:
            emit(run_job(json.load(sys.stdin), checkpoint))
        return 0
    except (RunnerError, json.JSONDecodeError) as exc:
        print(f"runner error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())