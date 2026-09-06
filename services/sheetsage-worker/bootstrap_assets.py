"""Provisioning-only SheetSage asset bootstrap; never import from the API."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSET_ROOT = Path(os.environ.get("SHEETSAGE_ASSET_ROOT", SPEC["asset_root"]))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    if os.environ.get(SPEC["license"]["acceptance_environment"]) != SPEC["license"]["required_value"]:
        raise SystemExit("SheetSage model license has not been explicitly accepted")
    ASSET_ROOT.mkdir(parents=True, exist_ok=True)
    os.environ["SHEETSAGE_CACHE_DIR"] = str(ASSET_ROOT)
    os.environ["XDG_CACHE_HOME"] = str(ASSET_ROOT)
    from importlib.metadata import version
    if version("sheetsage-infer") != SPEC["package"]["version"]:
        raise SystemExit("installed SheetSage package identity does not match manifest")
    from sheetsage import assets as sheetsage_assets
    from madmom_infer.models import downbeats_blstm
    tags = (
        "SHEETSAGE_V02_HANDCRAFTED_MOMENTS",
        "SHEETSAGE_V02_HANDCRAFTED_HARMONY_CFG",
        "SHEETSAGE_V02_HANDCRAFTED_HARMONY_STEP",
        "SHEETSAGE_V02_HANDCRAFTED_HARMONY_MODEL",
        "SHEETSAGE_V02_HANDCRAFTED_MELODY_CFG",
        "SHEETSAGE_V02_HANDCRAFTED_MELODY_STEP",
        "SHEETSAGE_V02_HANDCRAFTED_MELODY_MODEL",
    )
    files = []
    for tag in tags:
        path = Path(sheetsage_assets.retrieve_asset(tag, delete_wrong=True))
        source = sheetsage_assets._ASSETS[tag]
        files.append((path, tag, source["url"], source["checksum"],
                      "openmirlab/sheetsage-infer@ee7c2aeeb8084840a4f938ae6913f566afdaebdc",
                      "CC-BY-NC-SA-3.0"))
    for path in downbeats_blstm(cache_root=ASSET_ROOT / "madmom_infer" / "models"):
        files.append((Path(path), "MADMOM_DOWNBEATS_BLSTM", 
                      "https://raw.githubusercontent.com/CPJKU/madmom_models/master/" + Path(path).relative_to(ASSET_ROOT / "madmom_infer" / "models").as_posix(),
                      sha256(Path(path)), "content-addressed by package-pinned SHA-256",
                      "CC-BY-NC-SA-4.0"))
    assets = [{
        "path": path.relative_to(ASSET_ROOT).as_posix(), "tag": tag,
        "bytes": path.stat().st_size, "sha256": sha256(path),
        "upstreamChecksum": checksum, "source": source, "revision": revision,
        "license": license_name,
    } for path, tag, source, checksum, revision, license_name in files]
    if not assets:
        raise SystemExit("preloader did not materialize any SheetSage model assets")
    (ASSET_ROOT / SPEC["asset_manifest"]).write_text(json.dumps({
        "package": SPEC["package"], "assets": assets, "licenseAccepted": True
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()