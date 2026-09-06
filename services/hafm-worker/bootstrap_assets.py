"""Provision once or verify the exact existing immutable HAFM model snapshot."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSET_ROOT = Path(os.getenv("HAFM_ASSET_ROOT", SPEC["asset_root"]))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def expected_identity() -> dict[str, object]:
    return {
        "provider": "HAFM",
        "source": {
            "repository": SPEC["source"]["repository"],
            "revision": SPEC["source"]["revision"],
        },
        "model": {
            "repository": SPEC["model"]["repository"],
            "revision": SPEC["model"]["revision"],
        },
        "path": "snapshot",
    }


def verify_manifest(manifest: dict[str, object]) -> None:
    identity = expected_identity()
    for key, expected in identity.items():
        if manifest.get(key) != expected:
            raise RuntimeError(
                f"HAFM asset manifest {key} differs from reviewed identity"
            )
    if manifest.get("treeSha256") != SPEC["model"]["treeSha256"]:
        raise RuntimeError("HAFM model tree differs from reviewed identity")
    indexed = {
        entry["path"]: entry
        for entry in manifest.get("files", [])
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    snapshot = ASSET_ROOT / "snapshot"
    for relative, expected_hash in SPEC["model"]["requiredAssets"].items():
        path = snapshot / relative
        entry = indexed.get(relative)
        if (
            not path.is_file()
            or not entry
            or entry.get("sha256") != expected_hash
            or sha256(path) != expected_hash
        ):
            raise RuntimeError(
                f"HAFM required model asset mismatch: {relative}"
            )


def build_manifest(snapshot: Path) -> dict[str, object]:
    files = [
        {
            "path": path.relative_to(snapshot).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        }
        for path in sorted(snapshot.rglob("*"))
        if path.is_file()
    ]
    if not files:
        raise RuntimeError("HAFM snapshot is empty")
    tree = hashlib.sha256(
        "\n".join(
            f'{entry["path"]}\0{entry["sha256"]}'
            for entry in files
        ).encode()
    ).hexdigest()
    return {
        **expected_identity(),
        "files": files,
        "treeSha256": tree,
    }


def write_manifest(manifest: dict[str, object], destination: Path) -> None:
    serialized = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        mode="w",
        dir=ASSET_ROOT,
        prefix=f"{destination.name}.",
        suffix=".tmp",
        delete=False,
    ) as temporary:
        temporary.write(serialized)
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, destination)


def main() -> None:
    manifest_path = ASSET_ROOT / SPEC["asset_manifest"]
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        verify_manifest(manifest)
        print(json.dumps({
            "status": "verified-existing",
            "networkUsed": False,
            "manifestSha256": sha256(manifest_path),
            "treeSha256": manifest["treeSha256"],
        }, sort_keys=True))
        return
    snapshot = ASSET_ROOT / "snapshot"
    if snapshot.exists() and any(snapshot.iterdir()):
        raise RuntimeError(
            "HAFM snapshot exists without its reviewed manifest; refusing "
            "to overwrite or download into ambiguous state"
        )
    from huggingface_hub import snapshot_download

    snapshot.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        SPEC["model"]["repository"],
        revision=SPEC["model"]["revision"],
        local_dir=snapshot,
        local_dir_use_symlinks=False,
    )
    manifest = build_manifest(snapshot)
    verify_manifest(manifest)
    write_manifest(manifest, manifest_path)
    print(json.dumps({
        "status": "provisioned",
        "networkUsed": True,
        "manifestSha256": sha256(manifest_path),
        "treeSha256": manifest["treeSha256"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()