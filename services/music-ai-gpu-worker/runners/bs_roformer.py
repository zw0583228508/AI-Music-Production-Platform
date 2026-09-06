"""BS-RoFormer (viperx) two-stem separation runner."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

from .common import (RunnerError, artifact_descriptor, attest_checkpoint, cached_result,
                     download_source, durable_job_dir, emit, move_artifact, request_value,
                     materialize_source, require_cuda, require_distribution_version,
                     runtime_provenance, save_result, file_sha256, validate_audio)

PROVIDER = "BS_ROFORMER"
MODEL_VERSION = "bs-roformer-viperx-v1"
BACKEND_DISTRIBUTION = "bs-roformer-infer"
BACKEND_VERSION = "0.1.5"
BACKEND_SOURCE_REVISION = "openmirlab/bs-roformer-infer@b0f1386fcced25f559f3e61c9f08a73cd9bddf80"
BACKEND_PACKAGE_ARTIFACT_SHA256 = (
    "46f3d5eb4b666a54adcb67524258c3cb6f96e185db97a3e1e1ef7efaea4e1848"
)
CHECKPOINT_SOURCE_REVISION = (
    "puar-playground/bs-roformer@b1361b816daca507f079d85e935c291bcb0a5351"
)


class BSRoformerInferBackend:
    """Official folder API with explicit local model/config paths."""
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
            from bs_roformer.inference import proc_folder
        except ImportError as exc:
            raise RunnerError("bs-roformer-infer is not installed") from exc
        self.checkpoint = checkpoint
        self.config = config
        self.proc_folder = proc_folder
        self.output_dir = output_dir

    def separate(self, source: Path) -> list[Path]:
        try:
            self.proc_folder([
                "--model_type", "bs_roformer",
                "--model_path", str(self.checkpoint),
                "--config_path", str(self.config),
                "--input_folder", str(source.parent),
                "--store_dir", str(self.output_dir),
                "--device", "cuda",
            ])
        except Exception as exc:
            raise RunnerError(f"BS-RoFormer inference failed: {type(exc).__name__}") from exc
        vocals = self.output_dir / f"{source.stem}_vocals.wav"
        instrumental = self.output_dir / f"{source.stem}_instrumental.wav"
        if not vocals.is_file() or not instrumental.is_file():
            raise RunnerError("mounted BS-RoFormer config is not a two-stem model")
        return [vocals, instrumental]


@lru_cache(maxsize=1)
def backend_package_tree_sha256() -> str:
    distribution = importlib.metadata.distribution(BACKEND_DISTRIBUTION)
    files = distribution.files
    if not files:
        raise RunnerError("BS-RoFormer installed package tree is unavailable")
    digest = hashlib.sha256()
    file_count = 0
    for relative in sorted(files, key=lambda item: str(item)):
        path = Path(distribution.locate_file(relative))
        if not path.is_file():
            continue
        digest.update(str(relative).encode() + b"\0")
        digest.update(file_sha256(path).encode() + b"\0")
        file_count += 1
    if file_count == 0:
        raise RunnerError("BS-RoFormer installed package tree is empty")
    return digest.hexdigest()


def retained_audio_descriptor(value: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "stem", "format", "sampleRate", "channels", "durationSeconds",
        "bytes", "sha256", "peakAmplitude", "rmsAmplitude",
    )
    return {field: value[field] for field in fields if field in value}


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
    source = materialize_source(
        request, work / "source.wav", checkpoint, PROVIDER, smoke,
    )
    source_evidence = validate_audio(source)
    source_evidence.pop("path", None)
    if smoke:
        expected_input = os.getenv(
            "MUSIC_PROVIDER_BS_ROFORMER_SMOKE_INPUT_SHA256", ""
        ).strip().lower()
        if source_evidence.get("sha256") != expected_input:
            raise RunnerError("BS-RoFormer smoke input SHA-256 is missing or mismatched")
        source_evidence["fixtureKind"] = os.getenv(
            "MUSIC_PROVIDER_BS_ROFORMER_SMOKE_INPUT_KIND", ""
        ).strip()
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
    if {item["stem"] for item in artifacts} != {"vocals", "instrumental"}:
        raise RunnerError("BS-RoFormer must produce vocals and instrumental stems")
    stem_hashes = {item["sha256"] for item in artifacts}
    if len(stem_hashes) != 2 or source_evidence["sha256"] in stem_hashes:
        raise RunnerError("BS-RoFormer stems must be distinct from each other and input")
    result = {
        "artifacts": artifacts,
        "stems": artifacts,
        "inputEvidence": source_evidence,
        "provenance": provenance(digest),
    }
    save_result(work, result)
    return result


def provenance(digest: str) -> dict[str, str]:
    config_sha256 = os.getenv(
        "MUSIC_PROVIDER_BS_ROFORMER_CONFIG_SHA256", ""
    ).strip().lower()
    return {"provider": PROVIDER, "modelVersion": MODEL_VERSION,
            "checkpointSha256": digest,
            "configSha256": config_sha256,
            "backend": BACKEND_DISTRIBUTION, "backendVersion": BACKEND_VERSION,
            "backendPackageArtifactSha256": BACKEND_PACKAGE_ARTIFACT_SHA256,
            "backendPackageTreeSha256": backend_package_tree_sha256(),
            "revision": CHECKPOINT_SOURCE_REVISION,
            "backendSourceRevision": BACKEND_SOURCE_REVISION,
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
            stems = [
                retained_audio_descriptor(item) for item in result["stems"]
            ]
            emit({
                "smokeTested": True,
                **result["provenance"],
                "output": {
                    "input": result["inputEvidence"],
                    "stems": stems,
                    "stemCount": len(stems),
                    "allStemsNonSilent": True,
                    "distinctStemSha256": len(
                        {item["sha256"] for item in stems}
                    ) == len(stems),
                },
            })
        else:
            payload = json.load(sys.stdin)
            emit(run_job(payload, checkpoint))
        return 0
    except (RunnerError, json.JSONDecodeError) as exc:
        print(f"runner error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())