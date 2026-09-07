"""Provisioning-only immutable DiffRhythm 2 asset acquisition."""
from __future__ import annotations
import hashlib, json, os, re
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("DIFFRHYTHM2_ASSET_ROOT", SPEC["asset_root"]))

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""): digest.update(block)
    return digest.hexdigest()

def main() -> dict:
    """This command is never called by serving containers; it may use the network."""
    api, models = HfApi(), []
    ASSETS.mkdir(mode=0o750, parents=True, exist_ok=True)
    for requested in SPEC["models"]:
        info = api.model_info(requested["repository"], revision=requested["requested_revision"])
        revision = str(info.sha)
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise RuntimeError("Hub did not return an immutable model revision")
        name = requested["repository"].replace("/", "--")
        destination = ASSETS / name
        snapshot_download(repo_id=requested["repository"], revision=revision, local_dir=destination,
                          local_dir_use_symlinks=False,
                          allow_patterns=requested.get("allow_patterns"))
        files = [{"path": p.relative_to(destination).as_posix(), "bytes": p.stat().st_size,
                  "sha256": sha256(p)} for p in sorted(destination.rglob("*")) if p.is_file()]
        if not files: raise RuntimeError(f"{requested['repository']} produced an empty asset tree")
        models.append({"repository": requested["repository"], "requestedRevision": requested["requested_revision"],
                       "resolvedRevision": revision, "path": name, "files": files,
                       "license": requested["license"],
                       "commercialUsePermitted": requested["commercial_use_permitted"],
                       "treeSha256": hashlib.sha256("".join(x["sha256"] for x in files).encode()).hexdigest()})
    record = {"provider": SPEC["provider"], "source": SPEC["source"], "license": SPEC["license"], "models": models}
    (ASSETS / SPEC["asset_manifest"]).write_text(json.dumps(record, indent=2, sort_keys=True))
    return record

if __name__ == "__main__": main()