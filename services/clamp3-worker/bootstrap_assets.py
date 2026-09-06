"""Provision immutable CLaMP 3 assets. This is the only network-enabled path."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from huggingface_hub import snapshot_download

SNAPSHOTS = (
    ("sander-wood/clamp3", "355625cc1c6f73726bbcd0eb9276ac7152d56426"),
    ("m-a-p/MERT-v1-95M", "12af15fef9d0ac838c3f475bfbbf26d2060dd4f5"),
    ("FacebookAI/xlm-roberta-base", "e73636d4f797dec63c3081bb6ed5c7b0bb3f2089"),
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def provision(root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    cache = root / "hf"
    resolved = []
    for repository, revision in SNAPSHOTS:
        snapshot = Path(
            snapshot_download(
                repo_id=repository,
                revision=revision,
                cache_dir=cache,
                local_files_only=False,
                token=os.environ.get("HF_TOKEN"),
            )
        )
        if snapshot.name != revision:
            raise RuntimeError(f"{repository} resolved to {snapshot.name}, expected {revision}")
        # Pinned offline snapshots are loaded by unmodified upstream code using
        # repository IDs without a revision. Point the cache's local main ref
        # at the reviewed immutable commit; no network or mutable ref is used
        # by inference.
        repo_cache = cache / f"models--{repository.replace('/', '--')}"
        refs = repo_cache / "refs"
        refs.mkdir(parents=True, exist_ok=True)
        (refs / "main").write_text(revision, encoding="utf-8")
        resolved.append({"repository": repository, "revision": revision, "path": str(snapshot)})

    files = []
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        if path.name == "asset_inventory.json":
            continue
        files.append(
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": _sha256(path),
            }
        )
    inventory = {
        "schemaVersion": 1,
        "snapshots": resolved,
        "fileCount": len(files),
        "totalBytes": sum(item["bytes"] for item in files),
        "files": files,
    }
    (root / "asset_inventory.json").write_text(
        json.dumps(inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return inventory


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-root", default=os.environ.get("CLAMP3_ASSET_ROOT", "/models/clamp3"))
    args = parser.parse_args()
    result = provision(Path(args.asset_root))
    print(json.dumps({"fileCount": result["fileCount"], "totalBytes": result["totalBytes"]}))