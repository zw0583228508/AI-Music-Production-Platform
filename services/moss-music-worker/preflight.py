"""Bounded media-runtime validation run before any costly model inference."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import wave

def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def _write_tone(path: Path) -> None:
    sample_rate = 16_000
    frames = [
        struct.pack("<h", round(math.sin(2 * math.pi * 440 * i / sample_rate) * 12_000))
        for i in range(sample_rate // 4)
    ]
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"".join(frames))

def run_preflight() -> dict[str, object]:
    """Decode WAV and MP3, resample, and prove tensor creation with native codecs."""
    try:
        import importlib.metadata as metadata
        import torch
        import torchcodec  # noqa: F401 -- import validates its native library.
        import torchaudio
        with tempfile.TemporaryDirectory(prefix="moss-media-preflight-") as directory:
            root = Path(directory)
            wav_path = root / "tone.wav"
            mp3_path = root / "tone.mp3"
            _write_tone(wav_path)
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(wav_path), "-codec:a", "libmp3lame", "-q:a", "4", str(mp3_path),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            formats: dict[str, object] = {}
            tensors = []
            for media_format, path in (("wav", wav_path), ("mp3", mp3_path)):
                decoded, sample_rate = torchaudio.load(path)
                if (
                    sample_rate != 16_000
                    or decoded.ndim != 2
                    or decoded.shape[0] != 1
                    or decoded.shape[1] < 3_900
                    or decoded.dtype != torch.float32
                    or decoded.device.type != "cpu"
                    or not torch.isfinite(decoded).all()
                    or float(decoded.abs().max()) <= 0.01
                ):
                    raise RuntimeError(f"decoded {media_format} tensor failed shape/content checks")
                resampled = torchaudio.functional.resample(decoded, sample_rate, 8_000)
                tensor = torch.as_tensor(resampled, dtype=torch.float32, device="cpu").contiguous()
                if (
                    tensor.ndim != 2
                    or tensor.shape[0] != 1
                    or not 1_900 <= tensor.shape[1] <= 2_100
                    or not tensor.is_contiguous()
                    or tensor.dtype != torch.float32
                    or tensor.device.type != "cpu"
                ):
                    raise RuntimeError(f"resampled {media_format} tensor failed identity checks")
                tensors.append(tensor)
                formats[media_format] = {
                    "sha256": _digest(path),
                    "bytes": path.stat().st_size,
                    "decodedSampleRate": sample_rate,
                    "decodedShape": list(decoded.shape),
                    "resampledSampleRate": 8_000,
                    "resampledShape": list(tensor.shape),
                    "dtype": str(tensor.dtype),
                    "device": tensor.device.type,
                }
            common_samples = min(tensor.shape[1] for tensor in tensors)
            batch = torch.stack([tensor[:, :common_samples] for tensor in tensors])
            if batch.ndim != 3 or batch.shape[0] != 2:
                raise RuntimeError("WAV/MP3 tensors could not be combined into a batch")
        ffmpeg_line = subprocess.run(
            ["ffmpeg", "-version"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()[0]
        return {
            "passed": True,
            "packages": {
                "torch": torch.__version__,
                "torchaudio": torchaudio.__version__,
                "torchcodec": metadata.version("torchcodec"),
                "transformers": metadata.version("transformers"),
                "accelerate": metadata.version("accelerate"),
                "huggingfaceHub": metadata.version("huggingface-hub"),
                "gradio": metadata.version("gradio"),
                "pydantic": metadata.version("pydantic"),
                "fastapi": metadata.version("fastapi"),
            },
            "ffmpeg": ffmpeg_line,
            "formats": formats,
            "tensorBatch": {
                "shape": list(batch.shape),
                "dtype": str(batch.dtype),
                "device": batch.device.type,
            },
        }
    except Exception as exc:
        # Do not leak dynamic loader paths or arbitrary package diagnostics.
        raise RuntimeError(
            "MOSS media preflight failed: native WAV/MP3 decode, resampling, or tensor creation failed"
        ) from exc

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    arguments = parser.parse_args()
    result = run_preflight()
    serialized = json.dumps(result, indent=2, sort_keys=True)
    if arguments.output:
        destination = Path(arguments.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + f".{os.getpid()}.tmp")
        temporary.write_text(serialized)
        os.replace(temporary, destination)
    print(serialized)