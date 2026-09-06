"""Creates a smoke proof only after each immutable model performs real inference."""
from __future__ import annotations
import hashlib, json, os
from pathlib import Path
import app as worker

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("MOSS_MUSIC_ASSET_ROOT", SPEC["asset_root"]))
SMOKE = Path(os.getenv("MOSS_MUSIC_SMOKE_ROOT", "/var/lib/moss-music/smoke"))

def sha(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()

def main() -> None:
    assets, _, _ = worker.asset_state()
    compatibility, _, compatibility_sha = worker.compatibility_state()
    compatibility_path = SMOKE / SPEC["compatibility_evidence"]
    if not assets or not compatibility or not compatibility_path.is_file():
        raise RuntimeError("MOSS assets or runtime compatibility evidence are not verified")
    expected_input = SPEC["smoke_input"]
    fixture = Path("/opt/moss-music") / expected_input["path"]
    if (
        not fixture.is_file()
        or fixture.stat().st_size != expected_input["bytes"]
        or sha(fixture) != expected_input["sha256"]
    ):
        raise RuntimeError("official MOSS-Music real-song fixture identity is invalid")
    prompt = (
        "Analyze this song's structure, instrumentation, harmony, rhythm, and production. "
        "Provide concise, evidence-grounded musical reasoning."
    )
    results = {}
    for provider, model in SPEC["models"].items():
        text = worker.infer(provider, fixture.read_bytes(), prompt, 256, 0.0, 1.0, 50).strip()
        encoded = text.encode()
        if len(encoded) < 20:
            raise RuntimeError(f"{provider} returned no retained semantic reasoning")
        results[provider] = {
            "providerId": provider,
            "repository": model["repository"],
            "revision": model["revision"],
            "role": model["role"],
            "realInference": True,
            "outputChannel": "MUSICAL_SEMANTIC_REASONING",
            "prompt": prompt,
            "semanticReasoning": text,
            "responseSha256": hashlib.sha256(encoded).hexdigest(),
            "responseBytes": len(encoded),
        }
    proof = {
        "schemaVersion": 2,
        "providerFamily": SPEC["provider_family"],
        "source": SPEC["source"],
        "imageEvidence": os.getenv("MOSS_MUSIC_IMAGE_EVIDENCE"),
        "assetManifestSha256": sha(ASSETS / SPEC["asset_manifest"]),
        "compatibilityEvidenceSha256": compatibility_sha,
        "input": {**expected_input, "realSong": True},
        "models": results,
    }
    SMOKE.mkdir(mode=0o750, parents=True, exist_ok=True)
    destination = SMOKE / SPEC["smoke_proof"]
    temporary = destination.with_name(destination.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(proof, indent=2, sort_keys=True))
    os.replace(temporary, destination)
if __name__ == "__main__": main()