"""Adapter for the reviewed AnyAccomp checkout; never synthesizes a substitute."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())


class InferenceError(RuntimeError):
    pass


def run(vocal: Path, output: Path, prompt: str, assets: Path) -> None:
    del prompt  # The released AnyAccomp model is source-conditioned, not text-conditioned.
    source_dir = assets / "source"
    if not source_dir.is_dir():
        raise InferenceError("reviewed AnyAccomp source checkout is unavailable")
    command = [
        sys.executable,
        str(ROOT / "runner.py"),
        "--assets",
        str(assets),
        "--vocal",
        str(vocal),
        "--output",
        str(output),
        "--steps",
        str(SPEC["runtime"]["reverse_diffusion_steps"]),
        "--cfg",
        str(SPEC["runtime"]["cfg_scale"]),
        "--seed",
        str(SPEC["runtime"]["seed"]),
    ]
    try:
        result = subprocess.run(
            command,
            cwd=source_dir,
            capture_output=True,
            text=True,
            timeout=1500,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise InferenceError("AnyAccomp source-conditioned inference failed") from exc
    if result.returncode or not output.is_file() or output.stat().st_size <= 44:
        raise InferenceError("AnyAccomp source-conditioned inference failed")