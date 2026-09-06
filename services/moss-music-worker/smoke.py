"""Creates a smoke proof only after each immutable model performs real inference."""
from __future__ import annotations
import hashlib, json, os
from pathlib import Path
from app import infer
from preflight import run_preflight
ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("MOSS_MUSIC_ASSET_ROOT", SPEC["asset_root"]))
SMOKE = Path(os.getenv("MOSS_MUSIC_SMOKE_ROOT", "/var/lib/moss-music/smoke"))
def sha(path: Path) -> str: return hashlib.sha256(path.read_bytes()).hexdigest()
def main() -> None:
    run_preflight()
    fixture = Path("/opt/moss-music/test/tonghua.mp3")
    if not fixture.is_file(): raise RuntimeError("official MOSS-Music smoke audio is unavailable")
    results = {}
    for provider in SPEC["models"]:
        text = infer(provider, fixture.read_bytes(), "Provide a concise musical caption.", 64, 0.0, 1.0, 50)
        if not text.strip(): raise RuntimeError(f"{provider} returned empty real inference")
        results[provider] = {"realInference": True, "responseSha256": hashlib.sha256(text.encode()).hexdigest()}
    SMOKE.mkdir(mode=0o750, parents=True, exist_ok=True)
    (SMOKE / SPEC["smoke_proof"]).write_text(json.dumps({"realInference": True, "models": results,
       "assetManifestSha256": sha(ASSETS / SPEC["asset_manifest"])}, indent=2, sort_keys=True))
if __name__ == "__main__": main()