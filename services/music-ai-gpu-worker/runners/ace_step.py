"""ACE-Step 1.5 Base runner using a mounted official checkpoint only."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from importlib.metadata import PackageNotFoundError, version
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
MODEL_SNAPSHOT = "ACE-Step/acestep-v15-base@e432212fec32b8965a14ffa57ae653438d6abd14"
SHARED_MODEL_SOURCE = "ACE-Step/Ace-Step1.5"
SHARED_MODEL_SNAPSHOT = "ACE-Step/Ace-Step1.5@19671f406d603126926c1b7e2adc169acbcade22"
COMPOSITE_ROOT_NAME = "ace-step-1.5-runtime"
BASE_CONFIG_NAME = "acestep-v15-base"
REQUIRED_SUBTREES = (BASE_CONFIG_NAME, "vae", "Qwen3-Embedding-0.6B")
REQUIRED_BASE_FILES = ("config.json", "model.safetensors", "silence_latent.pt")
SMOKE_PROMPT = "instrumental piano and acoustic guitar, steady pulse, no vocals"
MAX_CANDIDATES = 4
MAX_SECONDS = 120
TORCH_VERSION = "2.10.0+cu128"
TORCHVISION_VERSION = "0.25.0+cu128"
TORCHAUDIO_VERSION = "2.10.0+cu128"


def _version_tuple(value: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in value.split("+", 1)[0].split("."))
    except ValueError as exc:
        raise RunnerError(f"invalid installed package version: {value}") from exc


def ace_runtime_provenance() -> dict[str, str]:
    """Validate the Linux x86_64 runtime declared by the pinned official source."""
    expected = {
        "torch": TORCH_VERSION,
        "torchvision": TORCHVISION_VERSION,
        "torchaudio": TORCHAUDIO_VERSION,
    }
    actual: dict[str, str] = {}
    for distribution, wanted in expected.items():
        try:
            installed = version(distribution)
        except PackageNotFoundError as exc:
            raise RunnerError(f"{distribution} {wanted} is required by ACE-Step") from exc
        if installed != wanted:
            raise RunnerError(
                f"{distribution} version {installed} does not match ACE-Step pin {wanted}"
            )
        actual[distribution] = installed
    try:
        transformers = version("transformers")
        accelerate = version("accelerate")
    except PackageNotFoundError as exc:
        raise RunnerError("transformers and accelerate are required by ACE-Step") from exc
    if not ((
        4, 51, 0
    ) <= _version_tuple(transformers) < (4, 58, 0)):
        raise RunnerError("transformers must satisfy >=4.51.0,<4.58.0")
    if _version_tuple(accelerate) < (1, 12, 0):
        raise RunnerError("accelerate must satisfy >=1.12.0")
    return {
        "torchVersion": actual["torch"],
        "torchvisionVersion": actual["torchvision"],
        "torchaudioVersion": actual["torchaudio"],
        "transformersVersion": transformers,
        "accelerateVersion": accelerate,
        "cudaBuild": "12.8",
    }


def _validated_composite_root(checkpoint: Path) -> Path:
    """Validate that every mounted dependency is confined to the attested tree."""
    if checkpoint.is_symlink() or not checkpoint.is_dir():
        raise RunnerError("ACE-Step composite checkpoint root is not a mounted directory")
    root = checkpoint.resolve()
    if checkpoint.name != COMPOSITE_ROOT_NAME:
        raise RunnerError(
            f"ACE-Step checkpoint root basename must be {COMPOSITE_ROOT_NAME}"
        )
    for name in REQUIRED_SUBTREES:
        subtree = checkpoint / name
        if not subtree.is_dir():
            raise RunnerError(f"ACE-Step required checkpoint subtree is missing: {name}")
        try:
            entries = (subtree, *subtree.rglob("*"))
            for entry in entries:
                resolved = entry.resolve(strict=True)
                if root != resolved and root not in resolved.parents:
                    raise RunnerError(
                        f"ACE-Step checkpoint entry escapes attested root: {entry}"
                    )
        except RunnerError:
            raise
        except (OSError, RuntimeError) as exc:
            raise RunnerError(f"invalid ACE-Step checkpoint subtree: {name}") from exc
    base = checkpoint / BASE_CONFIG_NAME
    for name in REQUIRED_BASE_FILES:
        source = base / name
        if not source.is_file():
            raise RunnerError(f"ACE-Step required base checkpoint file is missing: {name}")
    return root


def _create_runtime_view(root: Path) -> tempfile.TemporaryDirectory[str]:
    """Expose immutable model links while giving the handler a writable code area."""
    temporary = tempfile.TemporaryDirectory(prefix="ace-step-runtime-")
    view = Path(temporary.name)
    base_view = view / BASE_CONFIG_NAME
    base_view.mkdir()
    try:
        for name in REQUIRED_BASE_FILES:
            (base_view / name).symlink_to(root / BASE_CONFIG_NAME / name)
        for name in REQUIRED_SUBTREES[1:]:
            (view / name).symlink_to(root / name, target_is_directory=True)
    except Exception:
        temporary.cleanup()
        raise
    return temporary


class OfficialAceStepBackend:
    """Adapter for the documented official inference API at the pinned revision."""
    def __init__(self, checkpoint: Path) -> None:
        ace_runtime_provenance()
        require_cuda()
        root = _validated_composite_root(checkpoint)
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
        configured = os.environ.get("MUSIC_PROVIDER_ACE_STEP_CONFIG_PATH", "").strip()
        if configured and configured != BASE_CONFIG_NAME:
            raise RunnerError(
                f"MUSIC_PROVIDER_ACE_STEP_CONFIG_PATH must equal {BASE_CONFIG_NAME}"
            )
        config_path = configured or BASE_CONFIG_NAME
        try:
            from acestep.handler import AceStepHandler
            from acestep.inference import GenerationConfig, GenerationParams, generate_music
            from acestep.llm_inference import LLMHandler
        except ImportError as exc:
            raise RunnerError("official ace-step package is not installed") from exc
        try:
            self._runtime_view = _create_runtime_view(root)
        except OSError as exc:
            raise RunnerError("unable to construct isolated ACE-Step runtime view") from exc
        runtime_root = Path(self._runtime_view.name)
        os.environ["ACESTEP_CHECKPOINTS_DIR"] = str(runtime_root)
        try:
            self.dit_handler = AceStepHandler()
            # This handler remains uninitialized: thinking=False must not load an LLM.
            self.llm_handler = LLMHandler()
            status, initialized = self.dit_handler.initialize_service(
                project_root=str(runtime_root),
                config_path=config_path,
                device="cuda",
                use_mlx_dit=False,
            )
            if not initialized:
                raise RunnerError(f"ACE-Step rejected mounted checkpoint layout: {status}")
        except Exception as exc:
            self._runtime_view.cleanup()
            raise RunnerError(f"unable to load mounted ACE-Step checkpoint: {type(exc).__name__}") from exc
        self.GenerationConfig = GenerationConfig
        self.GenerationParams = GenerationParams
        self.generate_music = generate_music

    def generate(self, *, prompt: str, seed: int, duration_seconds: float,
                 candidates: int, output_dir: Path) -> list[dict[str, Any]]:
        try:
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
            finally:
                self._runtime_view.cleanup()
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
            "model": MODEL_SOURCE, "modelSnapshot": MODEL_SNAPSHOT,
             "sharedModel": SHARED_MODEL_SOURCE,
             "sharedModelSnapshot": SHARED_MODEL_SNAPSHOT,
            "device": "cuda", **runtime_provenance(), **ace_runtime_provenance()}


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
            result = run_job({"requestId": f"smoke-{os.urandom(8).hex()}", "prompt": SMOKE_PROMPT,
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