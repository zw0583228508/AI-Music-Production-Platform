"""ACE-Step 1.5 Base runner using a mounted official checkpoint only."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import wave
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .common import (RunnerError, artifact_descriptor, attest_checkpoint, cached_result,
                     download_source, durable_job_dir, emit, require_cuda,
                     runtime_provenance, save_result)

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
MAX_SOURCE_BYTES = 500 * 1024 * 1024
OPERATIONS = {"COMPLETE", "LEGO", "REPAINT", "COVER", "EXTRACT"}
FOCUSED_OPERATIONS = {"LEGO", "EXTRACT"}
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
                 candidates: int, output_dir: Path,
                  output_format: str = "flac",
                 operation: dict[str, Any] | None = None,
                 source_path: Path | None = None) -> list[dict[str, Any]]:
        try:
            try:
                operation = operation or {"operation": None, "task_type": "text2music"}
                params_kwargs: dict[str, Any] = {
                    "task_type": operation["task_type"],
                    "caption": prompt,
                    "duration": duration_seconds,
                    "thinking": False,
                }
                if operation["operation"]:
                    if source_path is None:
                        raise RunnerError(f"{operation['operation']} source audio is unavailable")
                    params_kwargs["src_audio"] = str(source_path)
                if operation["operation"] in FOCUSED_OPERATIONS:
                    params_kwargs["caption"] = (
                        f"Isolated {operation['instrument']} instrumental part only. "
                        "Do not add unrelated instrument stems."
                    )
                    params_kwargs["global_caption"] = prompt
                if operation["operation"] == "REPAINT":
                    params_kwargs.update({
                        "repainting_start": operation["repainting_start"],
                        "repainting_end": operation["repainting_end"],
                        "chunk_mask_mode": "explicit",
                        "repaint_wav_crossfade_sec": operation["crossfade_seconds"],
                    })
                params = self.GenerationParams(**params_kwargs)
                config = self.GenerationConfig(
                    batch_size=candidates, audio_format=output_format,
                    use_random_seed=False,
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


def _operation_parameters(request: dict[str, Any]) -> dict[str, Any]:
    raw_operation = request.get("operation")
    if raw_operation is None:
        return {"operation": None, "task_type": "text2music"}
    operation = str(raw_operation).strip().upper()
    if operation not in OPERATIONS:
        raise RunnerError(f"unsupported ACE-Step operation: {raw_operation}")
    source_audio = request.get("sourceAudio")
    if not isinstance(source_audio, dict):
        raise RunnerError(f"{operation} requires sourceAudio")
    artifact_id = str(source_audio.get("artifactId") or "").strip()
    source_url = str(source_audio.get("url") or "").strip()
    parsed = urlsplit(source_url)
    if (
        not artifact_id
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise RunnerError(f"{operation} sourceAudio is invalid")
    instrument = str(request.get("instrument") or "").strip().lower()
    if operation in FOCUSED_OPERATIONS and not instrument:
        raise RunnerError(f"{operation} requires a focused instrument")
    region = request.get("region")
    if operation == "REPAINT":
        if not isinstance(region, dict):
            raise RunnerError("REPAINT requires a region")
        unit = str(region.get("unit") or "")
        start = region.get("start")
        end = region.get("end")
        crossfade = region.get("crossfadeSeconds", 0.25)
        if (
            unit not in {"bar", "beat", "time"}
            or not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
            or not isinstance(crossfade, (int, float))
            or start < (1 if unit == "bar" else 0)
            or end <= start
            or crossfade < 0
            or crossfade > 10
        ):
            raise RunnerError("REPAINT region is invalid")
    elif region is not None:
        raise RunnerError("region is only valid for REPAINT")
    return {
        "operation": operation,
        "task_type": operation.lower(),
        "source_url": source_url,
        "source_artifact_id": artifact_id,
        "instrument": instrument or None,
        "region": region,
    }


def _region_seconds(
    request: dict[str, Any], region: dict[str, Any]
) -> tuple[float, float]:
    start = float(region["start"])
    end = float(region["end"])
    unit = str(region["unit"])
    if unit == "time":
        return start, end
    song = request.get("songModel")
    if not isinstance(song, dict):
        raise RunnerError(f"{unit} REPAINT requires SongModel tempo evidence")
    tempo_events: list[tuple[float, float]] = []
    tempo_map = song.get("tempoMap")
    if isinstance(tempo_map, list):
        for entry in tempo_map:
            if not isinstance(entry, dict):
                continue
            if not isinstance(entry.get("time"), (int, float)):
                continue
            if not isinstance(entry.get("bpm"), (int, float)):
                continue
            event_time = float(entry["time"])
            event_bpm = float(entry["bpm"])
            if event_time >= 0 and 30 <= event_bpm <= 300:
                tempo_events.append((event_time, event_bpm))
    tempo_events.sort()
    if not tempo_events or tempo_events[0][0] != 0:
        raise RunnerError(f"{unit} REPAINT requires a verified tempo")

    def beat_to_seconds(target: float) -> float:
        elapsed_beats = 0.0
        for index, (event_time, event_bpm) in enumerate(tempo_events):
            next_time = (
                tempo_events[index + 1][0]
                if index + 1 < len(tempo_events)
                else None
            )
            if next_time is None:
                return event_time + (target - elapsed_beats) * 60.0 / event_bpm
            segment_beats = (next_time - event_time) * event_bpm / 60.0
            if target <= elapsed_beats + segment_beats:
                return event_time + (target - elapsed_beats) * 60.0 / event_bpm
            elapsed_beats += segment_beats
        raise RunnerError("tempo map could not resolve the requested beat")

    if unit == "beat":
        return beat_to_seconds(start), beat_to_seconds(end)

    meter_events: list[tuple[float, int]] = []
    meter_map = song.get("meterMap")
    if isinstance(meter_map, list):
        for entry in meter_map:
            if not isinstance(entry, dict):
                continue
            bar = entry.get("bar")
            numerator = str(entry.get("meter") or "").partition("/")[0]
            if (
                isinstance(bar, (int, float))
                and float(bar) >= 1
                and numerator.isdigit()
                and 1 <= int(numerator) <= 16
            ):
                meter_events.append((float(bar), int(numerator)))
    meter_events.sort()
    if not meter_events or meter_events[0][0] != 1:
        raise RunnerError("bar REPAINT requires verified meter evidence from bar 1")

    def bar_to_beats(target: float) -> float:
        elapsed_beats = 0.0
        for index, (event_bar, beats_per_bar) in enumerate(meter_events):
            next_bar = (
                meter_events[index + 1][0]
                if index + 1 < len(meter_events)
                else None
            )
            if next_bar is None or target <= next_bar:
                return elapsed_beats + (target - event_bar) * beats_per_bar
            elapsed_beats += (next_bar - event_bar) * beats_per_bar
        raise RunnerError("meter map could not resolve the requested bar")

    return beat_to_seconds(bar_to_beats(start)), beat_to_seconds(bar_to_beats(end))


def _wav_duration_seconds(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as source:
            frame_rate = source.getframerate()
            if frame_rate <= 0:
                raise RunnerError("source WAV has an invalid sample rate")
            return source.getnframes() / frame_rate
    except (EOFError, OSError, wave.Error) as exc:
        raise RunnerError("REPAINT source must be a valid canonical WAV") from exc


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
            backend_cls=OfficialAceStepBackend, *,
            output_format: str = "flac") -> dict[str, Any]:
    prompt, seed, duration, count = _parameters(request)
    operation = _operation_parameters(request)
    digest = attest_checkpoint(checkpoint, PROVIDER)
    work = durable_job_dir(request, PROVIDER)
    prior = cached_result(work)
    if prior is not None:
        return prior
    require_cuda()
    source_path = None
    if operation["operation"]:
        source_path = work / "source-audio"
        download_source(operation["source_url"], source_path)
    if operation["operation"] == "REPAINT":
        repainting_start, repainting_end = _region_seconds(
            request, operation["region"]
        )
        source_duration = _wav_duration_seconds(source_path)
        if repainting_start >= source_duration or repainting_end > source_duration:
            raise RunnerError("REPAINT region exceeds the source audio duration")
        operation = {
            **operation,
            "repainting_start": repainting_start,
            "repainting_end": repainting_end,
            "crossfade_seconds": float(operation["region"]["crossfadeSeconds"]),
        }
    generate_kwargs: dict[str, Any] = {
        "prompt": prompt,
        "seed": seed,
        "duration_seconds": duration,
        "candidates": count,
        "output_dir": work,
        "output_format": output_format,
    }
    if operation["operation"]:
        generate_kwargs.update({
            "operation": operation,
            "source_path": source_path,
        })
    audios = backend_cls(checkpoint).generate(**generate_kwargs)
    if len(audios) != count:
        raise RunnerError("ACE-Step returned a different number of candidates")
    candidates = []
    song = request.get("songModel") if isinstance(request.get("songModel"), dict) else {}
    source_sections = song.get("sections") if isinstance(song.get("sections"), list) else []
    arrangement = request.get("arrangement") if isinstance(request.get("arrangement"), dict) else {}
    tracks = request.get("tracks") if isinstance(request.get("tracks"), list) else []
    enabled_tracks = [
        str(track.get("id"))
        for track in tracks
        if isinstance(track, dict) and isinstance(track.get("id"), str)
    ]
    if operation["operation"] in FOCUSED_OPERATIONS:
        focused = str(operation["instrument"]).lower()
        enabled_tracks = [
            str(track.get("id"))
            for track in tracks
            if (
                isinstance(track, dict)
                and isinstance(track.get("id"), str)
                and focused in " ".join([
                    str(track.get("name") or ""),
                    str(track.get("role") or ""),
                    str(track.get("instrument") or ""),
                ]).lower()
            )
        ]
    plan_sections = []
    for index, section in enumerate(source_sections):
        if not isinstance(section, dict):
            continue
        plan_sections.append({
            "name": str(section.get("name") or f"Section {index + 1}"),
            "energy": float(section.get("energy", arrangement.get("energy", 0.5))),
            "density": float(arrangement.get("density", 0.5)),
            "tracks": enabled_tracks,
        })
    if not plan_sections:
        plan_sections = [{
            "name": "Full Song",
            "energy": float(arrangement.get("energy", 0.5)),
            "density": float(arrangement.get("density", 0.5)),
            "tracks": enabled_tracks,
        }]
    for number, audio in enumerate(audios):
        if not isinstance(audio, dict) or not isinstance(audio.get("path"), str):
            raise RunnerError("ACE-Step returned an invalid audio entry")
        artifact_path = Path(audio["path"])
        if not artifact_path.is_absolute():
            artifact_path = work / artifact_path
        if work.resolve() not in artifact_path.resolve().parents:
            raise RunnerError("ACE-Step output escaped the durable job directory")
        artifact = artifact_descriptor(artifact_path, PROVIDER, work.name)
        candidates.append({"id": f"candidate-{number + 1}",
                           "label": f"{operation['operation'] or 'Candidate'} {chr(65 + number)}",
                           "score": 0.5, "confidence": 0.5,
                           "summary": (
                               f"ACE-Step {operation['operation'] or 'text2music'} "
                               "audio; independent quality analysis is pending."
                           ),
                           "plan": {"sections": plan_sections},
                           "seed": seed + number,
                           "parameters": {
                               "operation": operation["operation"],
                               "sourceArtifactId": operation.get("source_artifact_id"),
                               "instrument": operation.get("instrument"),
                               "region": operation.get("region"),
                           },
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
                              "seed": 0, "durationSeconds": 2, "candidateCount": 1},
                             checkpoint, output_format="wav")
            artifact = result["candidates"][0]["artifact"]
            emit({"smokeTested": True, **result["provenance"],
                  "output": {
                      "samples": len(result["candidates"]),
                      "artifact": {
                          key: artifact[key]
                          for key in (
                              "name", "format", "sampleRate", "channels",
                              "durationSeconds", "bytes", "sha256",
                              "peakAmplitude", "rmsAmplitude", "url",
                              "capability", "expiresAt",
                          )
                      },
                  }})
        else:
            emit(run_job(json.load(sys.stdin), checkpoint))
        return 0
    except (RunnerError, json.JSONDecodeError) as exc:
        print(f"runner error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())