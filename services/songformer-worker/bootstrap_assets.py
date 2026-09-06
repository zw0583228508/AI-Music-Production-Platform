"""Explicit provisioning only; importing or serving this module never downloads."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

from huggingface_hub import snapshot_download

ROOT = Path(os.environ.get("SONGFORMER_ASSET_ROOT", "/var/lib/songformer/assets"))
HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "model_manifest.json").read_text())

def digest(path: Path) -> str:
    hasher = hashlib.md5()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""): hasher.update(block)
    return hasher.hexdigest()

def main() -> None:
    source = MANIFEST["source"]
    checkout = ROOT / "source"
    ROOT.mkdir(parents=True, exist_ok=True)
    if not checkout.exists():
        subprocess.run(["git", "clone", source["repository"], str(checkout)], check=True)
    subprocess.run(["git", "-C", str(checkout), "checkout", "--detach", source["commit"]], check=True)
    subprocess.run(["git", "-C", str(checkout), "submodule", "update", "--init", "--recursive"], check=True)
    # The requested revision is immutable and the cache is the mounted private
    # volume. No endpoint calls this function or huggingface_hub.
    model_dir = ROOT / "models"
    snapshot_download(repo_id=MANIFEST["huggingFace"]["repository"], revision=MANIFEST["huggingFace"]["revision"],
                      local_dir=model_dir, local_dir_use_symlinks=False)
    records = []
    for item in MANIFEST["assets"]:
        path = model_dir / item["path"]
        if not path.is_file() or digest(path) != item["md5"]:
            raise RuntimeError(f"required SongFormer asset hash mismatch: {item['path']}")
        records.append({**item, "bytes": path.stat().st_size})
    (ROOT / "asset-attestation.json").write_text(json.dumps(
        {"provider": "SONGFORMER", "sourceCommit": source["commit"],
         "modelRevision": MANIFEST["huggingFace"]["revision"], "assets": records},
        sort_keys=True, separators=(",", ":")))

if __name__ == "__main__":
    main()