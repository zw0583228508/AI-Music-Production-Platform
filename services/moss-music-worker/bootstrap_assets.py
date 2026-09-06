"""Network-enabled provisioning only; serving containers remain offline."""
from __future__ import annotations
import hashlib, json, os
from pathlib import Path
ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("MOSS_MUSIC_ASSET_ROOT", SPEC["asset_root"]))

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()

def main() -> None:
    from huggingface_hub import snapshot_download
    ASSETS.mkdir(parents=True, exist_ok=True)
    models = {}
    for provider, details in SPEC["models"].items():
        destination = ASSETS / provider
        snapshot_download(repo_id=details["repository"], revision=details["revision"],
                          local_dir=str(destination), local_dir_use_symlinks=False)
        files = [{"path": p.relative_to(destination).as_posix(), "bytes": p.stat().st_size,
                  "sha256": digest(p)} for p in sorted(destination.rglob("*")) if p.is_file()]
        if not files: raise RuntimeError(f"{provider} immutable snapshot is empty")
        models[provider] = {**details, "path": provider, "files": files}
    temporary = ASSETS / ".model-assets.json.tmp"
    temporary.write_text(json.dumps({"providerFamily": SPEC["provider_family"], "source": SPEC["source"],
      "runtime": SPEC["runtime"], "models": models}, indent=2, sort_keys=True))
    os.replace(temporary, ASSETS / SPEC["asset_manifest"])
if __name__ == "__main__": main()