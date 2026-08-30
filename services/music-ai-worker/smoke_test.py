"""Real runtime readiness check; intentionally downloads no Demucs checkpoint."""
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())

with tempfile.TemporaryDirectory() as tmp:
    audio = Path(tmp) / "tone.wav"
    sf.write(audio, np.sin(np.arange(22050, dtype=np.float32) * 440 * 2 * np.pi / 22050), 22050)
    from basic_pitch.inference import ICASSP_2022_MODEL_PATH, Model, predict
    assert hashlib.sha256(Path(f"{ICASSP_2022_MODEL_PATH}.onnx").read_bytes()).hexdigest() == MANIFEST["basic_pitch"]["onnx_sha256"]
    _, _, notes = predict(audio, ICASSP_2022_MODEL_PATH)
    assert isinstance(notes, list)
    # Explicit .onnx selects Basic Pitch's ONNXRuntime backend rather than its
    # default TensorFlow SavedModel backend used by predict() above.
    assert Model(f"{ICASSP_2022_MODEL_PATH}.onnx").predict(
        np.zeros((1, 43844, 1), dtype=np.float32)
    )
    from pedalboard import Gain, Pedalboard
    assert Pedalboard([Gain(gain_db=-3)])(np.zeros((1, 32), dtype=np.float32), 22050).shape == (1, 32)
    import torch
    cache = Path(torch.hub.get_dir()) / "checkpoints"
    checkpoint = cache / MANIFEST["demucs"]["checkpoint_file"]
    assert checkpoint.is_file()
    assert hashlib.sha256(checkpoint.read_bytes()).hexdigest() == MANIFEST["demucs"]["checkpoint_sha256"]
    demucs_input = Path(tmp) / "demucs-smoke.wav"
    stereo = np.stack([
        np.sin(np.arange(44100, dtype=np.float32) * 220 * 2 * np.pi / 44100),
        np.sin(np.arange(44100, dtype=np.float32) * 330 * 2 * np.pi / 44100),
    ], axis=1) * 0.2
    sf.write(demucs_input, stereo, 44100)
    output = Path(tmp) / "demucs-output"
    subprocess.run(
        [
            sys.executable, "-m", "demucs", "-n", "htdemucs", "-d", "cpu",
            "--two-stems", "vocals", "--segment", "1", "-o", str(output),
            str(demucs_input),
        ],
        check=True,
        capture_output=True,
        timeout=180,
    )
    stem_root = output / "htdemucs" / demucs_input.stem
    assert (stem_root / "vocals.wav").stat().st_size > 44
    assert (stem_root / "no_vocals.wav").stat().st_size > 44

ready = ROOT / ".readiness"
ready.mkdir(exist_ok=True)
(ready / f"{MANIFEST['readiness_key']}.json").write_text(json.dumps({
    "basic_pitch": True,
    "onnx": True,
    "pedalboard": True,
    "demucs": True,
}))
print("music-ai-worker smoke test passed")