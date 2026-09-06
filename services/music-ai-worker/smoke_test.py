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
import app as worker_app
from capability_boundary import smoke_midi_round_trip, smoke_pedalboard_builtins

with tempfile.TemporaryDirectory() as tmp:
    tmp_path = Path(tmp)
    midi_evidence = smoke_midi_round_trip(tmp_path / "midi")
    assert midi_evidence["noteOnEvents"] >= 1
    pedalboard_evidence = smoke_pedalboard_builtins()
    assert pedalboard_evidence["frames"] == 128
    audio = Path(tmp) / "tone.wav"
    sf.write(audio, np.sin(np.arange(22050, dtype=np.float32) * 440 * 2 * np.pi / 22050), 22050)
    from basic_pitch.inference import Model, predict
    basic_pitch_details = MANIFEST["basic_pitch"]
    basic_pitch_root = Path(__import__(basic_pitch_details["module"]).__file__).resolve().parent
    checkpoint = basic_pitch_root / basic_pitch_details["checkpoint"]
    assert worker_app._sha256_tree(checkpoint) == basic_pitch_details["checkpoint_tree_sha256"]
    assert worker_app._installed_package_tree_sha256(
        basic_pitch_details["module"]
    ) == basic_pitch_details["package_tree_sha256"]
    assert worker_app._runtime_packages_are_pinned(basic_pitch_details)
    _, _, notes = predict(audio, checkpoint)
    assert isinstance(notes, list)
    # Explicit .onnx selects Basic Pitch's ONNXRuntime backend rather than its
    # default TensorFlow SavedModel backend used by predict() above.
    onnx_checkpoint = basic_pitch_root / basic_pitch_details["onnx_checkpoint"]
    assert hashlib.sha256(onnx_checkpoint.read_bytes()).hexdigest() == basic_pitch_details["onnx_sha256"]
    assert Model(onnx_checkpoint).predict(
        np.zeros((1, 43844, 1), dtype=np.float32)
    )
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

renderer_evidence = {}
for renderer_provider, marker_name in (("VST3", "vst3"), ("SFIZZ_VSCO2_CE", "sfizz")):
    try:
        renderer_evidence[marker_name] = worker_app.run_renderer_smoke(renderer_provider)
    except Exception as exc:
        # Native assets are intentionally optional for the CPU baseline. A
        # configured-but-invalid asset is recorded as unhealthy instead of
        # enabling a renderer or blocking the deterministic local renderer.
        renderer_evidence[marker_name] = {
            "status": "unavailable",
            "optionalAdapter": True,
            "trackModelRendered": False,
            "audible": False,
            "canonicalSensitivity": False,
            "nativeHostAttested": False,
            "reason": str(exc),
            "requirements": worker_app.NATIVE_ADAPTER_REQUIREMENTS[renderer_provider],
        }

ready = ROOT / ".readiness"
ready.mkdir(exist_ok=True)
(ready / f"{MANIFEST['readiness_key']}.json").write_text(json.dumps({
    "basic_pitch": True,
    "basic_pitch_backend": MANIFEST["basic_pitch"]["inference_backend"],
    "basic_pitch_checkpoint_sha256": MANIFEST["basic_pitch"]["checkpoint_tree_sha256"],
    "onnx": True,
    "midi": midi_evidence,
    "pedalboard": True,
    "pedalboardEvidence": pedalboard_evidence,
    "demucs": True,
    **renderer_evidence,
}))
print("music-ai-worker smoke test passed")