"""Strict adapter to HAFM's published instrumental-output inference path."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

SOURCE_ROOT = Path("/opt/hafm")


def infer(vocal: bytes, output: Path, assets: Path) -> None:
    required = [
        SOURCE_ROOT / "infer.py",
        SOURCE_ROOT / "configs/ar.yaml",
        SOURCE_ROOT / "models/ar_singsong.py",
        SOURCE_ROOT / "data/retokenize.py",
        SOURCE_ROOT / "utils/audio_utils.py",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError(
            "HAFM upstream runtime contract is incomplete: "
            + ", ".join(missing)
        )
    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory)
        source = temporary / "vocal.wav"
        mixed_output = temporary / "mixed.wav"
        source.write_bytes(vocal)
        subprocess.run(
            [
                "/opt/hafm-venv/bin/python",
                "infer.py",
                "--vocal_path",
                str(source),
                "--output_path",
                str(mixed_output),
                "--config",
                "configs/ar.yaml",
            ],
            cwd=SOURCE_ROOT,
            env={
                **__import__("os").environ,
                "HAFM_MODEL_ROOT": str(assets / "snapshot"),
            },
            check=True,
            timeout=1800,
        )
        instrumental = temporary / "mixed_instrumental.wav"
        if not instrumental.is_file() or instrumental.stat().st_size == 0:
            raise RuntimeError(
                "HAFM upstream inference produced no instrumental WAV"
            )
        output.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        shutil.move(instrumental, output)