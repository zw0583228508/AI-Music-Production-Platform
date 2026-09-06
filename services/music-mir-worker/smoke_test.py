"""Smoke only against a supplied, decoded real audio fixture; never downloads models."""
import os
import tempfile
import json
import base64
from pathlib import Path

import soundfile as sf

import app

fixture = Path(os.environ["MIR_SMOKE_AUDIO_PATH"])
if not fixture.is_file():
    raise AssertionError("MIR_SMOKE_AUDIO_PATH must name a real checked/provisioned audio fixture")
audio, rate = sf.read(fixture, always_2d=True, dtype="float32")
if audio.size == 0 or rate < 8000:
    raise AssertionError("smoke fixture did not decode as audio")
with tempfile.TemporaryDirectory() as directory:
    source = Path(directory) / "fixture.wav"
    sf.write(source, audio, rate)
    reread, reread_rate = sf.read(source, always_2d=True)
    assert reread_rate == rate and reread.size == audio.size
    encoded = base64.b64encode(source.read_bytes()).decode("ascii")
    for provider in app.PROVIDERS:
        response = app.analyze(app.AnalysisRequest(provider=provider, audioBase64=encoded))
        assert response["status"] == "ok"
        ready = app.READINESS_ROOT
        ready.mkdir(parents=True, exist_ok=True)
        package = app.MANIFEST["providers"][provider].get("package")
        (ready / f"{provider.lower()}.json").write_text(json.dumps({
            "provider": provider,
            "packageVersion": None if not package else app.version(package),
            "featureExecutionSucceeded": True,
            "fixture": fixture.name,
        }), encoding="utf-8")
print("decoded real-audio MIR smoke fixture successfully")