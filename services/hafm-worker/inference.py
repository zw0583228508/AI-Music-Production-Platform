"""Strict adapter to HAFM's published accompaniment inference command."""
from __future__ import annotations
import subprocess,tempfile
from pathlib import Path
def infer(vocal:bytes,output:Path,assets:Path):
 with tempfile.TemporaryDirectory() as t:
  source=Path(t)/"vocal.wav";source.write_bytes(vocal)
  subprocess.run(["python","infer_simple.py","--vocal_path",str(source),"--output_path",str(output),"--config","configs/ar.yaml","--model_path",str(assets/"snapshot")],cwd="/opt/hafm",check=True,timeout=1800)
 if not output.is_file() or output.stat().st_size==0:raise RuntimeError("HAFM upstream inference produced no instrumental WAV")