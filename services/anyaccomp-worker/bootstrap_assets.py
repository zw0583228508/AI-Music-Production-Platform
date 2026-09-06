"""Provisioning-only AnyAccomp downloader. It is never imported by the API."""
from __future__ import annotations
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("ANYACCOMP_ASSET_ROOT", SPEC["asset_root"]))

def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()

def files(root: Path) -> list[dict[str, object]]:
    return [{"path": item.relative_to(root).as_posix(), "bytes": item.stat().st_size,
             "sha256": digest(item)} for item in sorted(root.rglob("*")) if item.is_file()]

def immutable_sha(value: object, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise RuntimeError(f"{label} must be an approved immutable 40-character commit SHA")
    return value

def main() -> None:
    # Deliberately blocked until a reviewer records the two exact upstream SHAs.
    source_sha = immutable_sha(SPEC["source"]["revision"], "AnyAccomp source revision")
    weight_sha = immutable_sha(SPEC["weights"]["revision"], "AnyAccomp weight revision")
    from huggingface_hub import snapshot_download
    ASSETS.mkdir(parents=True, exist_ok=True)
    source_target = ASSETS / "source"
    if source_target.exists():
        raise RuntimeError("AnyAccomp source volume is not empty; refuse to replace reviewed source")
    subprocess.run(["git", "clone", "--no-checkout", SPEC["source"]["repository"], str(source_target)],
                   check=True)
    subprocess.run(["git", "-C", str(source_target), "checkout", "--detach", source_sha], check=True)
    actual_source = subprocess.check_output(["git", "-C", str(source_target), "rev-parse", "HEAD"],
                                            text=True).strip()
    if actual_source != source_sha:
        raise RuntimeError("AnyAccomp checked-out source does not match approved revision")
    target = ASSETS / "weights"
    snapshot_download(repo_id=SPEC["weights"]["repository"], revision=weight_sha,
                      local_dir=str(target), local_dir_use_symlinks=False)
    inventory = files(target)
    names = " ".join(entry["path"].lower() for entry in inventory)
    missing = [part for part in SPEC["weights"]["required_components"] if part.lower() not in names]
    if not inventory or missing:
        raise RuntimeError(f"AnyAccomp required checkpoint components are missing: {', '.join(missing)}")
    (ASSETS / SPEC["asset_manifest"]).write_text(json.dumps({
        "provider": SPEC["provider"], "modelVersion": SPEC["model_version"],
        "source": {**SPEC["source"], "revision": source_sha, "checkedOutRevision": actual_source},
        "weights": {"repository": SPEC["weights"]["repository"], "revision": weight_sha,
                    "files": inventory},
    }, indent=2, sort_keys=True))

if __name__ == "__main__":
    main()