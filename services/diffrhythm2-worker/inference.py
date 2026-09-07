"""Offline adapter for the pinned upstream DiffRhythm 2 implementation."""
from __future__ import annotations
import json, os, subprocess, tempfile
from pathlib import Path

UPSTREAM = Path("/opt/diffrhythm2")

def infer(*, lyrics: str, rhythm_wav: bytes, output: Path, style_prompt: str, duration: float,
          steps: int, guidance: float, diagnostic: Path | None = None) -> None:
    """Run actual upstream lyric + reference-audio conditioning with network disabled."""
    if not lyrics.strip() or not rhythm_wav:
        raise ValueError("lyrics and rhythm reference audio are both required")
    with tempfile.TemporaryDirectory() as tmp:
        root, audio = Path(tmp), Path(tmp) / "rhythm.wav"
        audio.write_bytes(rhythm_wav)
        request = root / "request.json"
        request.write_text(json.dumps({
            "lyrics": lyrics, "rhythmPath": str(audio), "style": style_prompt,
            "duration": duration, "steps": steps, "guidance": guidance,
        }))
        generated = root / "generated.mp3"
        observed = root / "diagnostic.json"
        command = ["/opt/diffrhythm2-venv/bin/python", "/app/upstream_runner.py",
                   "--request", str(request), "--assets",
                   os.getenv("DIFFRHYTHM2_ASSET_ROOT", "/var/lib/diffrhythm2/models"),
                   "--output", str(generated), "--diagnostic", str(observed)]
        env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
               "HF_HOME": os.getenv("HF_HOME", "/var/lib/diffrhythm2/models")}
        run = subprocess.run(command, cwd=UPSTREAM, env=env, capture_output=True, text=True, timeout=1800)
        if run.returncode or not generated.is_file():
            detail = " ".join((run.stdout + "\n" + run.stderr).split())[-12000:]
            raise RuntimeError(f"pinned DiffRhythm 2 inference failed: {detail}")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(generated.read_bytes())
        if diagnostic is not None:
            diagnostic.parent.mkdir(parents=True, exist_ok=True)
            diagnostic.write_bytes(observed.read_bytes())
