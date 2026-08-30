"""BS-RoFormer (viperx) two-stem separation runner."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .common import (RunnerError, artifact_descriptor, attest_checkpoint, cached_result,
                     download_source, durable_job_dir, emit, move_artifact, request_value,
                     materialize_source, require_cuda, require_distribution_version,
                     runtime_provenance, save_result, file_sha256)

PROVIDER = "BS_ROFORMER"
MODEL_VERSION = "bs-roformer-viperx-v1"
BACKEND_DISTRIBUTION = "bs-roformer-infer"
BACKEND_VERSION = "0.1.5"
BACKEND_SOURCE_REVISION = "openmirlab/bs-roformer-infer@b0f1386fcced25f559f3e61c9f08a73cd9bddf80"


class BSRoformerInferBackend:
    """Official public session API with explicit local model/config paths."""
    def __init__(self, checkpoint: Path, output_dir: Path) -> None:
        require_distribution_version(BACKEND_DISTRIBUTION, BACKEND_VERSION)
        config = Path(os.environ.get("MUSIC_PROVIDER_BS_ROFORMER_CONFIG_PATH", ""))
        if not config.is_file():
            raise RunnerError("mounted BS-RoFormer config path is required")
        expected_config = os.environ.get(
            "MUSIC_PROVIDER_BS_ROFORMER_CONFIG_SHA256", ""
        ).strip().lower()
        if (len(expected_config) != 64 or file_sha256(config) != expected_config):
            raise RunnerError("mounted BS-RoFormer config SHA-256 is missing or mismatched")
        try:
            from bs_roformer import BSRoformerSession
        except ImportError as exc:
            raise RunnerError("bs-roformer-infer is not installed") from exc
        try:
            self.session = BSRoformerSession(
                model_path=checkpoint, config_path=config, device="cuda",
                backend="torch", progress=False,
            ).load()
        except Exception as exc:
            raise RunnerError(f"unable to load mounted BS-RoFormer checkpoint: {type(exc).__name__}") from exc
        self.output_dir = output_dir

    def separate(self, source: Path) -> list[Path]:
        try:
            manifest = self.session.infer(
                source.parent, store_dir=self.output_dir, output_format="flac16"
            )
        except Exception as exc:
            raise RunnerError(f"BS-RoFormer inference failed: {type(exc).__name__}") from exc
        outputs = {
            item.output_id: Path(item.output_path)
            for item in manifest.outputs
            if Path(item.input_path).resolve() == source.resolve()
        }
        if set(outputs) != {"vocals", "instrumental"}:
            raise RunnerError("mounted BS-RoFormer config is not a two-stem model")
        return [outputs["vocals"], outputs["instrumental"]]


def run_job(request: dict[str, Any], checkpoint: Path, backend_cls=BSRoformerInferBackend,
            *, smoke: bool = False) -> dict[str, Any]:
    if not checkpoint.is_file():
        raise RunnerError("BS-RoFormer checkpoint is missing from durable storage")
    digest = attest_checkpoint(checkpoint, PROVIDER)
    work = durable_job_dir(request, PROVIDER)
    prior = cached_result(work)
    if prior is not None:
        return prior
    require_cuda()
    source = materialize_source(request, work / "source.wav", checkpoint, smoke)
    outputs = backend_cls(checkpoint, work).separate(source)
    if len(outputs) != 2:
        raise RunnerError("BS-RoFormer must produce exactly two stems")
    artifacts = []
    seen: set[str] = set()
    for index, output in enumerate(outputs):
        output = output if output.is_absolute() else work / output
        stem = "vocals" if "vocal" in output.name.lower() else "instrumental"
        if stem in seen:
            stem = f"stem{index + 1}"
        seen.add(stem)
        suffix = output.suffix.lower()
        if suffix not in {".wav", ".flac"}:
            raise RunnerError("BS-RoFormer output must be WAV or FLAC")
        final = move_artifact(output, work / f"{stem}{suffix}")
        artifact = artifact_descriptor(final, PROVIDER, work.name)
        artifact["stem"] = stem
        artifacts.append(artifact)
    result = {"artifacts": artifacts, "stems": artifacts, "provenance": provenance(digest)}
    save_result(work, result)
    return result


def provenance(digest: str) -> dict[str, str]:
    return {"provider": PROVIDER, "modelVersion": MODEL_VERSION,
            "checkpointSha256": digest,
            "backend": BACKEND_DISTRIBUTION, "backendVersion": BACKEND_VERSION,
            "revision": BACKEND_SOURCE_REVISION, "sourceRevision": BACKEND_SOURCE_REVISION,
            "model": MODEL_VERSION, "device": "cuda", **runtime_provenance()}


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
            result = run_job({"requestId": f"smoke-bs-roformer-{os.urandom(8).hex()}"},
                             checkpoint, smoke=True)
            emit({"smokeTested": True, **result["provenance"], "output": {"stems": len(result["stems"])}})
        else:
            payload = json.load(sys.stdin)
            emit(run_job(payload, checkpoint))
        return 0
    except (RunnerError, json.JSONDecodeError) as exc:
        print(f"runner error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())