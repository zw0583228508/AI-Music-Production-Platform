"""Network-enabled provisioning only after retained license authorization."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from license_gate import require_authorization

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
LICENSE = json.loads((ROOT / "license_manifest.json").read_text())
ASSETS = Path(os.getenv("LADA_BAND_ASSET_ROOT", SPEC["asset_root"]))


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1048576), b""):
            value.update(block)
    return value.hexdigest()


def main() -> None:
    # Authorization evidence is checked before environment values, importing
    # huggingface_hub, creating directories, or making a network request.
    require_authorization("LaDA-Band asset provisioning")
    if os.getenv(LICENSE["acceptance_environment"]) != LICENSE["required_value"]:
        raise RuntimeError("LaDA-Band operational acceptance flag is required")
    token = os.getenv(LICENSE["access_token_environment"])
    if not token:
        raise RuntimeError("LaDA-Band gated Hugging Face token is required")

    from huggingface_hub import snapshot_download

    destination = ASSETS / "snapshot"
    destination.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        SPEC["model"]["repository"],
        revision=SPEC["model"]["revision"],
        token=token,
        local_dir=destination,
        local_dir_use_symlinks=False,
    )
    for tree in SPEC["model"]["required_trees"]:
        if not (destination / tree).is_dir():
            raise RuntimeError(f"required LaDA-Band asset tree is missing: {tree}")
    files = [
        {
            "path": path.relative_to(destination).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": digest(path),
        }
        for path in sorted(destination.rglob("*"))
        if path.is_file()
    ]
    if not files:
        raise RuntimeError("LaDA-Band snapshot is empty")
    tree_sha = hashlib.sha256(
        "\n".join(f'{item["path"]}\0{item["sha256"]}' for item in files).encode()
    ).hexdigest()
    (ASSETS / SPEC["asset_manifest"]).write_text(
        json.dumps(
            {
                "provider": "LADA_BAND",
                "source": SPEC["source"],
                "model": SPEC["model"],
                "path": "snapshot",
                "files": files,
                "treeSha256": tree_sha,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()