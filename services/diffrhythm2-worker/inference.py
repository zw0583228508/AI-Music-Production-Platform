"""Offline adapter for the pinned upstream DiffRhythm 2 implementation."""
from __future__ import annotations
import json, os, subprocess, tempfile
from pathlib import Path

UPSTREAM = Path("/opt/diffrhythm2")

def infer(*, lyrics: str, rhythm_wav: bytes, output: Path, style_prompt: str, duration: float,
          steps: int, guidance: float) -> None:
    """Run actual upstream lyric + reference-audio conditioning with network disabled."""
    if not lyrics.strip() or not rhythm_wav:
        raise ValueError("lyrics and rhythm reference audio are both required")
    with tempfile.TemporaryDirectory() as tmp:
        root, audio = Path(tmp), Path(tmp) / "rhythm.wav"
        audio.write_bytes(rhythm_wav)
        lyric_file = root / "lyrics.txt"; lyric_file.write_text(lyrics)
        request = root / "request.jsonl"
        request.write_text(json.dumps({"song_name": "generated", "lyrics": str(lyric_file),
            "style_prompt": str(audio), "max_secs": duration, "style": style_prompt}) + "\n")
        command = ["/opt/diffrhythm2-venv/bin/python", "inference.py", "--repo-id", "ASLP-lab/DiffRhythm2",
                   "--output-dir", str(root / "result"), "--input-jsonl", str(request),
                   "--cfg-strength", str(guidance), "--max-secs", str(duration), "--steps", str(steps),
                   "--fake-stereo", "False"]
        env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
               "HF_HOME": os.getenv("HF_HOME", "/var/lib/diffrhythm2/models")}
        run = subprocess.run(command, cwd=UPSTREAM, env=env, capture_output=True, text=True, timeout=1800)
        candidate = root / "result" / "generated.mp3"
        if run.returncode or not candidate.is_file():
            raise RuntimeError("pinned DiffRhythm 2 inference did not produce an artifact")
        output.write_bytes(candidate.read_bytes())