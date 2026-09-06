"""Provisioning-only smoke; accepts only genuine upstream outputs."""
from __future__ import annotations
import hashlib, json, os
from pathlib import Path
from app import ASSET_ROOT, SPEC
from inference import run_pipeline, valid_midi, sha256

def main(fixture: Path) -> None:
    result = run_pipeline(fixture.read_bytes(), {"mode": "detected", "dynamics": 0.5}, None)
    if not valid_midi(result["midi"]) or not result["wav"]:
        raise RuntimeError("real MIDI-SAG smoke produced empty/invalid MIDI or WAV")
    (ASSET_ROOT / SPEC["smokeProof"]).write_text(json.dumps({"provider": "MIDI_SAG", "realInference": True,
      "assetManifestSha256": sha256(ASSET_ROOT / SPEC["assetManifest"]),
      "midi": {"validNonempty": True, "sha256": hashlib.sha256(result["midi"]).hexdigest(), "bytes": len(result["midi"])},
      "museControlLite": {"nonemptyWav": True, "sha256": hashlib.sha256(result["wav"]).hexdigest(), "bytes": len(result["wav"])}}))
if __name__ == "__main__": main(Path(os.environ["MIDI_SAG_SMOKE_AUDIO"]))