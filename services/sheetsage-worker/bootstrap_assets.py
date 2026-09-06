"""Provisioning-only SheetSage asset bootstrap; never import from the API."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
from urllib.request import Request, urlopen

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSET_ROOT = Path(os.environ.get("SHEETSAGE_ASSET_ROOT", SPEC["asset_root"]))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _require_license() -> None:
    if os.environ.get(SPEC["license"]["acceptance_environment"]) != SPEC["license"]["required_value"]:
        raise RuntimeError("SheetSage model license has not been explicitly accepted")


def _asset_inventory(root: Path, source: str, archive_sha256: str) -> list[dict]:
    expected = SPEC["required_asset_sha256"]
    if len(expected) != SPEC["recovery"]["required_asset_count"]:
        raise RuntimeError("recovery manifest asset count is invalid")
    assets = []
    for relative_path, expected_sha256 in expected.items():
        path = root / relative_path
        if not path.is_file() or sha256(path) != expected_sha256:
            raise RuntimeError(f"recovery asset SHA-256 mismatch: {relative_path}")
        assets.append({
            "path": relative_path,
            "tag": "RECOVERED_VERIFIED_ASSET",
            "bytes": path.stat().st_size,
            "sha256": expected_sha256,
            "upstreamChecksum": expected_sha256,
            "source": source,
            "revision": f"owner archive sha256:{archive_sha256}",
            "license": (
                SPEC["license"]["downbeat_weights"]
                if relative_path.startswith("madmom_infer/")
                else SPEC["license"]["weights"]
            ),
        })
    return assets


def _safe_extract(archive: Path, destination: Path) -> None:
    with tarfile.open(archive, mode="r:*") as bundle:
        members = [member for member in bundle.getmembers() if member.isfile()]
        names = {member.name.lstrip("./") for member in members}
        expected = set(SPEC["required_asset_sha256"])
        if names != expected:
            raise RuntimeError("recovery archive contents do not exactly match the model manifest")
        for member in members:
            relative = Path(member.name)
            if relative.is_absolute() or ".." in relative.parts or member.issym() or member.islnk():
                raise RuntimeError("recovery archive contains an unsafe path")
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source = bundle.extractfile(member)
            if source is None:
                raise RuntimeError("recovery archive member is unreadable")
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def _recovery_configuration() -> tuple[str, str]:
    recovery = SPEC["recovery"]
    source = os.environ.get(recovery["source_environment"], "")
    expected_archive_sha256 = os.environ.get(recovery["sha256_environment"], "").lower()
    if not source:
        raise RuntimeError("owner-controlled SheetSage recovery source is not configured")
    if len(expected_archive_sha256) != 64 or any(
        character not in "0123456789abcdef" for character in expected_archive_sha256
    ):
        raise RuntimeError("SheetSage recovery archive SHA-256 is not configured")
    return source, expected_archive_sha256


def _download_and_verify_recovery_archive(temporary_root: Path) -> tuple[str, list[dict], Path]:
    source, expected_archive_sha256 = _recovery_configuration()
    archive = temporary_root / "recovery.tar"
    staging = temporary_root / "verified"
    staging.mkdir()
    request = Request(source, headers={"User-Agent": "SheetSage-owner-recovery/1"})
    try:
        with urlopen(request, timeout=300) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
    except BaseException as error:
        # Do not retain the underlying URL-bearing exception in logs or alerts.
        if isinstance(error, Exception):
            raise RuntimeError("owner-controlled SheetSage recovery source is unavailable") from None
        try:
            sanitized = type(error)("SheetSage recovery drill was interrupted")
        except Exception:
            raise
        raise sanitized from None
    if sha256(archive) != expected_archive_sha256:
        raise RuntimeError("SheetSage recovery archive SHA-256 mismatch")
    _safe_extract(archive, staging)
    assets = _asset_inventory(staging, "owner-controlled-private-recovery", expected_archive_sha256)
    return expected_archive_sha256, assets, staging


def drill_recovery_source() -> dict:
    """Verify the private recovery archive entirely in disposable storage."""
    _require_license()
    with tempfile.TemporaryDirectory(prefix="sheetsage-recovery-drill-") as temporary:
        archive_sha256, assets, _ = _download_and_verify_recovery_archive(Path(temporary))
        return {
            "verified": True,
            "assets": len(assets),
            "archiveSha256": archive_sha256,
        }


def restore_from_recovery_source() -> None:
    """Restore the complete licensed model set from an owner-controlled archive."""
    _require_license()
    ASSET_ROOT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".sheetsage-restore-", dir=ASSET_ROOT.parent) as temporary:
        expected_archive_sha256, assets, staging = _download_and_verify_recovery_archive(Path(temporary))
        (staging / SPEC["asset_manifest"]).write_text(json.dumps({
            "package": SPEC["package"],
            "assets": assets,
            "licenseAccepted": True,
            "recoveryArchiveSha256": expected_archive_sha256,
        }, indent=2, sort_keys=True))

        ASSET_ROOT.mkdir(parents=True, exist_ok=True)
        for relative_path in (*SPEC["required_asset_sha256"], SPEC["asset_manifest"]):
            source_path = staging / relative_path
            destination = ASSET_ROOT / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source_path, destination)


def main() -> None:
    _require_license()
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
    handcrafted_source = SPEC["handcrafted_asset_source"]
    for tag in tags:
        path = Path(sheetsage_assets.retrieve_asset(tag, delete_wrong=True))
        source = sheetsage_assets._ASSETS[tag]
        relative_path = source["path"].as_posix()
        expected_sha256 = SPEC["required_asset_sha256"][relative_path]
        if sha256(path) != expected_sha256:
            raise SystemExit(f"SheetSage handcrafted asset SHA-256 mismatch: {tag}")
        files.append((path, relative_path, tag, handcrafted_source["url"], source["checksum"],
                      handcrafted_source["declared_by"],
                      "CC-BY-NC-SA-3.0"))
    for path in downbeats_blstm(cache_root=ASSET_ROOT / "madmom_infer" / "models"):
        relative_path = f"madmom_infer/models/downbeats/2016/{Path(path).name}"
        files.append((Path(path), relative_path, "MADMOM_DOWNBEATS_BLSTM",
                      "https://raw.githubusercontent.com/CPJKU/madmom_models/master/" +
                      Path(relative_path).relative_to("madmom_infer/models").as_posix(),
                      sha256(Path(path)), "content-addressed by package-pinned SHA-256",
                      "CC-BY-NC-SA-4.0"))
    assets = [{
        "path": relative_path, "tag": tag,
        "bytes": path.stat().st_size, "sha256": sha256(path),
        "upstreamChecksum": checksum, "source": source, "revision": revision,
        "license": license_name,
    } for path, relative_path, tag, source, checksum, revision, license_name in files]
    if not assets:
        raise SystemExit("preloader did not materialize any SheetSage model assets")
    (ASSET_ROOT / SPEC["asset_manifest"]).write_text(json.dumps({
        "package": SPEC["package"], "assets": assets, "licenseAccepted": True
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()