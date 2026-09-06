"""The real upstream LaDA-Band adapter; never synthesize an accompaniment."""
from __future__ import annotations
import subprocess,tempfile
from pathlib import Path
from license_gate import require_authorization
def infer(vocal_wav: bytes, output: Path, asset_root: Path, prompt: str|None, style: str|None) -> None:
    require_authorization("LaDA-Band inference")
    with tempfile.TemporaryDirectory() as tmp:
        vocal=Path(tmp)/"vocal.wav"; vocal.write_bytes(vocal_wav)
        command=["python","infer.py","--vocal_path",str(vocal),"--output_path",str(output),"--checkpoint_root",str(asset_root/"snapshot"/"checkpoints"),"--pretrained_root",str(asset_root/"snapshot"/"pretrained")]
        if prompt: command.extend(["--prompt",prompt])
        if style: command.extend(["--style",style])
        subprocess.run(command,cwd="/opt/lada-band",check=True,timeout=1800)
    if not output.is_file() or output.stat().st_size==0: raise RuntimeError("LaDA-Band upstream inference produced no WAV")