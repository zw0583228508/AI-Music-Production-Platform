"""Provision the exact reviewed AnyAccomp source and three checkpoint assets."""
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


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def files(root: Path) -> list[dict[str, object]]:
    entries = []
    for item in sorted(root.rglob("*")):
        relative = item.relative_to(root)
        if not item.is_file() or ".git" in relative.parts or ".cache" in relative.parts:
            continue
        entries.append(
            {
                "path": relative.as_posix(),
                "bytes": item.stat().st_size,
                "sha256": digest(item),
            }
        )
    return entries


def immutable_sha(value: object, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise RuntimeError(f"{label} must be an approved immutable commit SHA")
    return value


def verify_expected_files(root: Path, expected: list[dict]) -> list[dict]:
    inventory = files(root)
    actual = {entry["path"]: entry for entry in inventory}
    expected_by_path = {entry["path"]: entry for entry in expected}
    if set(actual) != set(expected_by_path):
        raise RuntimeError("AnyAccomp checkpoint snapshot has unexpected or missing paths")
    for path, retained in expected_by_path.items():
        observed = actual[path]
        if (
            observed["bytes"] != retained["bytes"]
            or observed["sha256"] != retained["sha256"]
        ):
            raise RuntimeError(f"AnyAccomp checkpoint identity mismatch: {path}")
    return inventory


def main() -> dict:
    source_sha = immutable_sha(SPEC["source"]["revision"], "source revision")
    weight_sha = immutable_sha(SPEC["weights"]["revision"], "weight revision")
    from huggingface_hub import snapshot_download

    ASSETS.mkdir(parents=True, exist_ok=True)
    source_target = ASSETS / "source"
    weight_target = ASSETS / "weights"
    inventory_path = ASSETS / SPEC["asset_manifest"]
    if source_target.exists() or weight_target.exists() or inventory_path.exists():
        raise RuntimeError(
            "AnyAccomp model volume is not empty; refuse to replace reviewed assets"
        )

    subprocess.run(
        [
            "git",
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            SPEC["source"]["repository"],
            str(source_target),
        ],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(source_target), "checkout", "--detach", source_sha],
        check=True,
    )
    actual_source = subprocess.check_output(
        ["git", "-C", str(source_target), "rev-parse", "HEAD"], text=True
    ).strip()
    actual_tree = subprocess.check_output(
        ["git", "-C", str(source_target), "rev-parse", "HEAD^{tree}"], text=True
    ).strip()
    if actual_source != source_sha or actual_tree != SPEC["source"]["git_tree"]:
        raise RuntimeError("AnyAccomp source checkout identity mismatch")
    for expected in SPEC["source"]["critical_files"]:
        path = source_target / expected["path"]
        if (
            not path.is_file()
            or path.stat().st_size != expected["bytes"]
            or digest(path) != expected["sha256"]
        ):
            raise RuntimeError(
                f"AnyAccomp source critical-file mismatch: {expected['path']}"
            )
    source_inventory = files(source_target)
    if canonical_sha256(source_inventory) != SPEC["source"]["file_inventory_sha256"]:
        raise RuntimeError("AnyAccomp source file inventory mismatch")

    expected_weights = SPEC["weights"]["files"]
    snapshot_download(
        repo_id=SPEC["weights"]["repository"],
        revision=weight_sha,
        local_dir=str(weight_target),
        allow_patterns=[entry["path"] for entry in expected_weights],
    )
    weight_inventory = verify_expected_files(weight_target, expected_weights)

    pretrained = source_target / "pretrained"
    if pretrained.exists() or pretrained.is_symlink():
        raise RuntimeError("AnyAccomp source unexpectedly contains pretrained assets")
    pretrained.symlink_to(Path("../weights/pretrained"))
    if not pretrained.resolve().is_dir():
        raise RuntimeError("AnyAccomp immutable checkpoint link is invalid")

    from fixture import create_fixture_with_authorization

    fixture = create_fixture_with_authorization(ASSETS)
    license_evidence_path = ROOT / SPEC["license_evidence"]
    result = {
        "schemaVersion": 2,
        "provider": SPEC["provider"],
        "modelVersion": SPEC["model_version"],
        "source": {
            **SPEC["source"],
            "checkedOutRevision": actual_source,
            "observedGitTree": actual_tree,
            "files": source_inventory,
            "treeSha256": canonical_sha256(source_inventory),
        },
        "weights": {
            "repository": SPEC["weights"]["repository"],
            "revision": weight_sha,
            "license": SPEC["weights"]["license"],
            "files": weight_inventory,
            "treeSha256": canonical_sha256(weight_inventory),
        },
        "fixture": fixture,
        "licenseEvidenceSha256": digest(license_evidence_path),
        "licenseStatus": "COMMERCIAL",
    }
    inventory_path.write_text(json.dumps(result, indent=2, sort_keys=True))
    return result


if __name__ == "__main__":
    main()