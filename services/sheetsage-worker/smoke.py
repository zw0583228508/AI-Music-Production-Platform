"""Run against a real licensed audio fixture and persist an attested smoke proof."""
from __future__ import annotations
import base64, hashlib, json, os
from pathlib import Path
from app import ASSET_MANIFEST, ASSET_ROOT, SPEC, asset_state, validate_evidence
from inference import run

fixture = Path(os.environ.get("SHEETSAGE_SMOKE_AUDIO", ""))
if not fixture.is_file():
    raise SystemExit("SHEETSAGE_SMOKE_AUDIO must identify a real licensed audio fixture")
ready, message, _ = asset_state()
if not ready:
    raise SystemExit(message)
result = validate_evidence(run(base64.b64encode(fixture.read_bytes()).decode(), ASSET_ROOT, 300))
encoded = json.dumps(result, sort_keys=True).encode()
(ASSET_ROOT / "smoke-proof.json").write_text(json.dumps({
    "realInference": True, "package": SPEC["package"],
    "assetManifestSha256": hashlib.sha256(ASSET_MANIFEST.read_bytes()).hexdigest(),
    "outputSha256": hashlib.sha256(encoded).hexdigest(),
    "evidence": {"melodyEvents": len(result["melody"]), "chordEvents": len(result["chords"]), "timingEvents": len(result["timing"])}
}, indent=2))
print("SheetSage real-inference smoke proof persisted")