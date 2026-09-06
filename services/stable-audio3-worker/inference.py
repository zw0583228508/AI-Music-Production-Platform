"""Reviewed Stable Audio 3 command adapter; it never substitutes generated audio."""
from __future__ import annotations
import os, shlex, subprocess
from pathlib import Path

class InferenceError(RuntimeError): pass

def run(model: str, prompt: str, duration: float, init_audio: Path | None, init_noise_level: float,
        inpaint_start: float | None, inpaint_end: float | None, lora_path: str | None,
        lora_strength: float, output: Path, assets: Path) -> None:
    command = os.getenv("STABLE_AUDIO3_INFERENCE_COMMAND")
    if not command: raise InferenceError("reviewed Stable Audio 3 inference command is not configured")
    if "{model}" not in command or "{output}" not in command:
        raise InferenceError("Stable Audio 3 command must consume immutable model and output paths")
    values = {"model": str(assets / "models" / model), "prompt": prompt, "duration": str(duration),
      "initAudio": str(init_audio) if init_audio else "", "initNoiseLevel": str(init_noise_level),
      "inpaintStart": "" if inpaint_start is None else str(inpaint_start),
      "inpaintEnd": "" if inpaint_end is None else str(inpaint_end), "loraPath": lora_path or "",
      "loraStrength": str(lora_strength), "output": str(output), "assets": str(assets)}
    try: argv = [part.format(**values) for part in shlex.split(command)]
    except (KeyError, ValueError) as exc: raise InferenceError("Stable Audio 3 command placeholders are invalid") from exc
    result = subprocess.run(argv, cwd=assets / "source", capture_output=True, text=True, timeout=1800)
    if result.returncode or not output.is_file() or output.stat().st_size == 0:
        raise InferenceError("Stable Audio 3 inference failed")