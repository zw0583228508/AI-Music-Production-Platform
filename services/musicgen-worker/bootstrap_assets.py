"""Provision MusicGen weights once, resolve immutable revisions, and hash them.

This module is deliberately used only by the provisioning Modal function. API
containers are offline and only accept the resulting reviewed volume inventory.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text(encoding="utf-8"))
ASSET_ROOT = Path(os.getenv("MUSICGEN_ASSET_ROOT", SPEC["asset_root"]))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _files(root: Path) -> list[dict[str, object]]:
    return [{"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size, "sha256": sha256(path)}
            for path in sorted(root.rglob("*")) if path.is_file()]


def main() -> None:
    if os.getenv(SPEC["license"]["acceptance_environment"]) != SPEC["license"]["required_value"]:
        raise RuntimeError("MusicGen CC-BY-NC-4.0 acceptance secret has not explicitly accepted model weights")
    from huggingface_hub import HfApi, snapshot_download

    ASSET_ROOT.mkdir(parents=True, exist_ok=True)
    api = HfApi()
    models: dict[str, dict[str, object]] = {}
    for mode, details in SPEC["models"].items():
        if not isinstance(details.get("requested_revision"), str):
            raise RuntimeError(
                f"{mode} has no reviewed immutable checkpoint pin; "
                "refusing to resolve or download a floating Hugging Face revision"
            )
        # This is the one Hub metadata query for this model.  The response SHA is
        # retained and is the only revision subsequently passed to downloads.
        info = api.model_info(details["repository"], revision=details["requested_revision"])
        revision = str(info.sha)
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise RuntimeError(f"{mode} Hub revision did not resolve to an immutable 40-character SHA")
        destination = ASSET_ROOT / mode
        snapshot_download(
            repo_id=details["repository"], revision=revision, local_dir=str(destination),
            local_dir_use_symlinks=False,
        )
        entries = _files(destination)
        if not entries:
            raise RuntimeError(f"{mode} MusicGen snapshot is empty")
        models[mode] = {
            "repository": details["repository"], "requestedRevision": details["requested_revision"],
            "resolvedRevision": revision, "path": mode, "files": entries,
        }
    payload = {
        "provider": SPEC["provider"], "source": SPEC["source"], "runtime": SPEC["runtime"],
        "license": SPEC["license"]["name"], "models": models,
    }
    temporary = ASSET_ROOT / ".model-assets.json.tmp"
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temporary, ASSET_ROOT / SPEC["asset_manifest"])


if __name__ == "__main__":
    main()