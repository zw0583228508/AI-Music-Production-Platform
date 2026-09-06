"""Provisioning-only proof that AnyAccomp generated accompaniment from a vocal."""
from __future__ import annotations
import hashlib
import io
import json
import os
from pathlib import Path
import numpy as np
import soundfile as sf
from app import ASSETS, SPEC, sha
from inference import run

def main(fixture: Path) -> dict:
    if not fixture.is_file():
        raise RuntimeError("uploaded isolated-vocal smoke fixture is missing")
    with __import__("tempfile").TemporaryDirectory() as temporary:
        output = Path(temporary) / "accompaniment.wav"
        run(fixture, output, "acoustic accompaniment, no lead vocal", ASSETS)
        source, _ = sf.read(str(fixture), always_2d=True)
        rendered, rate = sf.read(str(output), always_2d=True)
        rms = float(np.sqrt(np.mean(np.square(rendered)))) if len(rendered) else 0.0
        count = min(len(source), len(rendered))
        correlation = 1.0
        if count > 32:
            left, right = source[:count].mean(axis=1), rendered[:count].mean(axis=1)
            if float(np.std(left)) > 1e-8 and float(np.std(right)) > 1e-8:
                correlation = float(np.corrcoef(left, right)[0, 1])
        proof = {
            "provider": "ANYACCOMP", "realSourceConditionedInference": True,
            "assetManifestSha256": sha(ASSETS / SPEC["asset_manifest"]),
            "sourceSha256": sha(fixture), "outputSha256": sha(output), "sampleRate": rate,
            "nonSilent": rms > 1e-5, "rms": rms,
            "notSourceCopy": sha(fixture) != sha(output) and abs(correlation) < 0.995,
            "correlation": correlation,
        }
    if not (proof["nonSilent"] and proof["notSourceCopy"]):
        raise RuntimeError("AnyAccomp smoke rejected silent or copied-vocal output")
    (ASSETS / SPEC["smoke_proof"]).write_text(json.dumps(proof, indent=2, sort_keys=True))
    return proof

if __name__ == "__main__":
    main(Path(os.environ["ANYACCOMP_SMOKE_VOCAL"]))