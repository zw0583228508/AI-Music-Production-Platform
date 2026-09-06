"""Bounded media-runtime validation run before any costly model inference."""
from __future__ import annotations
import os
import tempfile
import wave

def run_preflight() -> None:
    """Import TorchCodec and decode an actual PCM WAV through Torchaudio."""
    try:
        import torchcodec  # noqa: F401 -- import validates its native library.
        import torchaudio
        with tempfile.NamedTemporaryFile(suffix=".wav") as handle:
            with wave.open(handle, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(8000)
                wav.writeframes(b"\0\0" * 80)
            handle.flush()
            decoded, sample_rate = torchaudio.load(handle.name)
        if sample_rate != 8000 or decoded.numel() != 80:
            raise RuntimeError("decoded WAV did not match the expected PCM shape")
    except Exception as exc:
        # Do not leak dynamic loader paths or arbitrary package diagnostics.
        raise RuntimeError(
            "MOSS media preflight failed: TorchCodec could not decode a tiny WAV with FFmpeg 7"
        ) from exc

if __name__ == "__main__":
    run_preflight()