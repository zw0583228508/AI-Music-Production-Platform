"""BS-RoFormer (viperx) two-stem separation runner."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .common import (RunnerError, checkpoint_sha256, download_source, durable_job_dir,
                     emit, move_artifact, request_value, require_cuda, validate_audio)

PROVIDER = "BS_ROFORMER"
MODEL_VERSION = "bs-roformer-viperx-v1"
BACKEND_DISTRIBUTION = "audio-separator"
BACKEND_VERSION = "0.30.1"
BACKEND_SOURCE_REVISION = "viperx/BS-Roformer@v1"


class AudioSeparatorBackend:
    """Approved audio-separator API; its model directory is always local."""
    def __init__(self, checkpoint: Path, output_dir: Path) -> None:
        try:
            from audio_separator.separator import Separator
        except ImportError as exc:
            raise RunnerError("audio-separator is not installed") from exc
        self.separator = Separator(
            log_level=30, model_file_dir=str(checkpoint.parent), output_dir=str(output_dir)
        )
        try:
            self.separator.load_model(model_filename=checkpoint.name)
        except Exception as exc:
            raise RunnerError(f"unable to load mounted BS-RoFormer checkpoint: {type(exc).__name__}") from exc

    def separate(self, source: Path) -> list[Path]:
        try:
            values = self.separator.separate(str(source))
        except Exception as exc:
            raise RunnerError(f"BS-RoFormer inference failed: {type(exc).__name__}") from exc
        return [Path(value) for value in values]


def run_job(request: dict[str, Any], checkpoint: Path, backend_cls=AudioSeparatorBackend) -> dict[str, Any]:
    require_cuda()
    if not checkpoint.is_file():
        raise RunnerError("BS-RoFormer checkpoint is missing from durable storage")
    work = durable_job_dir(request, PROVIDER)
    source = download_source(request_value(request, "sourceUrl"), work / "source.wav")
    outputs = backend_cls(checkpoint, work).separate(source)
    if len(outputs) != 2:
        raise RunnerError("BS-RoFormer must produce exactly two stems")
    artifacts = []
    seen: set[str] = set()
    for index, output in enumerate(outputs):
        stem = "vocals" if "vocal" in output.name.lower() else "instrumental"
        if stem in seen:
            stem = f"stem{index + 1}"
        seen.add(stem)
        suffix = output.suffix.lower()
        if suffix not in {".wav", ".flac"}:
            raise RunnerError("BS-RoFormer output must be WAV or FLAC")
        final = move_artifact(output, work / f"{stem}{suffix}")
        artifact = validate_audio(final)
        artifact["stem"] = stem
        artifacts.append(artifact)
    return {"artifacts": artifacts, "stems": artifacts, "provenance": provenance(checkpoint)}


def provenance(checkpoint: Path) -> dict[str, str]:
    return {"provider": PROVIDER, "modelVersion": MODEL_VERSION,
            "checkpointSha256": checkpoint_sha256(checkpoint),
            "backend": BACKEND_DISTRIBUTION, "backendVersion": BACKEND_VERSION,
            "sourceRevision": BACKEND_SOURCE_REVISION, "device": "cuda"}


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
            source = __import__("os").environ.get("MUSIC_GPU_SMOKE_INPUT")
            if not source:
                raise RunnerError("MUSIC_GPU_SMOKE_INPUT is required for real smoke inference")
            result = run_job({"requestId": "smoke-bs-roformer", "sourceUrl": source}, checkpoint)
            emit({"smokeTested": True, **provenance(checkpoint), "output": {"stems": len(result["stems"])}})
        else:
            payload = json.load(sys.stdin)
            emit(run_job(payload, checkpoint))
        return 0
    except (RunnerError, json.JSONDecodeError) as exc:
        print(f"runner error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())