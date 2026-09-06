"""Adapter for a reviewed AnyAccomp checkout; never synthesizes a substitute."""
from __future__ import annotations
import os
import shlex
import subprocess
from pathlib import Path

class InferenceError(RuntimeError):
    pass

def run(vocal: Path, output: Path, prompt: str, assets: Path) -> None:
    """Run only a reviewed source-conditioned command, without a shell.

    The provisioning review records this command in the immutable asset inventory.
    Refusing an absent command is intentional: returning the input, silence, or a
    generic text generation would falsely claim V2A inference.
    """
    command = os.getenv("ANYACCOMP_INFERENCE_COMMAND")
    if not command:
        raise InferenceError("AnyAccomp reviewed source-conditioned inference command is not configured")
    values = {"vocal": str(vocal), "output": str(output), "prompt": prompt, "assets": str(assets)}
    try:
        argv = [part.format(**values) for part in shlex.split(command)]
    except (KeyError, ValueError) as exc:
        raise InferenceError("AnyAccomp inference command has invalid placeholders") from exc
    if "{vocal}" not in command or "{output}" not in command:
        raise InferenceError("AnyAccomp inference command must consume vocal and output paths")
    source_dir = assets / "source"
    if not source_dir.is_dir():
        raise InferenceError("reviewed AnyAccomp source checkout is unavailable")
    result = subprocess.run(argv, cwd=source_dir, capture_output=True, text=True, timeout=900)
    if result.returncode or not output.is_file() or output.stat().st_size == 0:
        raise InferenceError("AnyAccomp source-conditioned inference failed")