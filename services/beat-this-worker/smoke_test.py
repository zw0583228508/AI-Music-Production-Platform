"""Real-audio execution proof; no download APIs are imported or called."""
import json, os
from pathlib import Path
import soundfile as sf
import torch, torchaudio
import app

fixture = app.ASSET_ROOT / Path(os.environ.get("BEAT_THIS_SMOKE_FIXTURE", "/app/_smoke/real-audio.wav"))
if not fixture.is_file(): raise RuntimeError("real-audio smoke fixture is missing")
info = sf.info(fixture)
if info.duration <= 0: raise RuntimeError("real-audio fixture is invalid")
source_evidence = json.loads((fixture.parent / "source-evidence.json").read_text())
source_sha256 = source_evidence.get("sourceSha256", "")
if len(source_sha256) != 64: raise RuntimeError("real-audio source evidence is invalid")
result = app.analyze_path(fixture)
if len(result["beats"]) < 2: raise RuntimeError("Beat This produced no real beat sequence")
if len(result["downbeats"]) < 1: raise RuntimeError("Beat This produced no real downbeat sequence")
app.READINESS.parent.mkdir(parents=True, exist_ok=True)
app.READINESS.write_text(json.dumps({
    "provider": "BEAT_THIS", "featureExecutionSucceeded": True,
    "checkpoint": {"name": "final0", "sha256": app.MANIFEST["checkpointSha256"]},
    "fixture": {"sourceSha256": source_sha256, "sha256": app.sha256(fixture),
                "sampleRate": info.samplerate, "channels": info.channels,
                "frames": info.frames, "durationSeconds": info.duration,
                "format": info.format, "subtype": info.subtype},
    "torch": torch.__version__,
    "torchaudio": torchaudio.__version__,
    "result": {
        "beatCount": len(result["beats"]),
        "downbeatCount": len(result["downbeats"]),
        "firstBeats": result["beats"][:8],
        "firstDownbeats": result["downbeats"][:8],
        "confidence": result["confidence"],
    },
}, sort_keys=True, separators=(",", ":")))