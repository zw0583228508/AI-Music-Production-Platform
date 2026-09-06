"""Network-enabled provisioning only; serving containers remain offline."""
from __future__ import annotations
import hashlib, json, os, shutil
from pathlib import Path
ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("MOSS_MUSIC_ASSET_ROOT", SPEC["asset_root"]))

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()

def inventory(path: Path) -> list[dict[str, object]]:
    return [
        {
            "path": candidate.relative_to(path).as_posix(),
            "bytes": candidate.stat().st_size,
            "sha256": digest(candidate),
        }
        for candidate in sorted(path.rglob("*"))
        if candidate.is_file()
    ]

def inventory_digest(files: list[dict[str, object]]) -> str:
    canonical = json.dumps(files, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(canonical).hexdigest()

def main() -> None:
    from huggingface_hub import snapshot_download
    ASSETS.mkdir(parents=True, exist_ok=True)
    staging_root = ASSETS / ".staging"
    staging_root.mkdir(exist_ok=True)
    models = {}
    for provider, details in SPEC["models"].items():
        staging = staging_root / f"{provider}-{os.getpid()}"
        shutil.rmtree(staging, ignore_errors=True)
        try:
            snapshot_download(
                repo_id=details["repository"],
                revision=details["revision"],
                local_dir=str(staging),
                local_dir_use_symlinks=False,
            )
            files = inventory(staging)
            if not files:
                raise RuntimeError(f"{provider} immutable snapshot is empty")
            generation = f"{details['revision']}-{inventory_digest(files)[:16]}"
            destination = ASSETS / "snapshots" / provider / generation
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                if inventory(destination) != files:
                    raise RuntimeError(f"{provider} immutable snapshot generation is inconsistent")
                shutil.rmtree(staging)
            else:
                os.replace(staging, destination)
            models[provider] = {
                **details,
                "path": destination.relative_to(ASSETS).as_posix(),
                "inventorySha256": inventory_digest(files),
                "files": files,
            }
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    temporary = ASSETS / ".model-assets.json.tmp"
    temporary.write_text(json.dumps({
        "schemaVersion": 2,
        "complete": True,
        "providerFamily": SPEC["provider_family"],
        "source": SPEC["source"],
        "runtime": SPEC["runtime"],
        "models": models,
    }, indent=2, sort_keys=True))
    os.replace(temporary, ASSETS / SPEC["asset_manifest"])
if __name__ == "__main__": main()