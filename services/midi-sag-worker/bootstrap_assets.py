"""Provision-only asset inventory for the pinned MIDI-SAG source checkout.

The reviewed upstream production_adapter is the only allowed downloader.  Serving
containers run offline and reject an inventory missing byte hashes or revisions.
"""
from __future__ import annotations
import json
import os
import subprocess
from pathlib import Path
from inference import ROOT, SPEC, UPSTREAM, sha256

ASSET_ROOT = Path(os.getenv("MIDI_SAG_ASSET_ROOT", SPEC["assetRoot"]))

def main() -> None:
    # The reviewed source contract is terminally blocked: do not create an
    # inventory, invoke a downloader, or otherwise reach a network operation.
    try:
        terminal = json.loads((ROOT / "installation-status.json").read_text())["providers"]["MIDI_SAG"]["terminal"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("reviewed MIDI-SAG terminal status is unavailable; refusing provisioning") from exc
    if terminal.get("ready") is not True or str(terminal.get("status", "")).startswith("BLOCKED_"):
        raise RuntimeError(f"MIDI-SAG provisioning is blocked: {terminal.get('message', 'terminal review failed')}")
    if subprocess.check_output(["git", "-C", str(UPSTREAM), "rev-parse", "HEAD"], text=True).strip() != SPEC["code"]["revision"]:
        raise RuntimeError("MIDI-SAG source revision does not match immutable manifest")
    adapter = UPSTREAM / "production_adapter.py"
    if not adapter.is_file():
        raise RuntimeError("reviewed pinned production_adapter.py is required; install.sh is never executed")
    ASSET_ROOT.mkdir(parents=True, exist_ok=True)
    subprocess.run(["/opt/midi-sag-venv/bin/python", str(adapter), "--bootstrap-assets",
                    "--asset-root", str(ASSET_ROOT)], check=True, timeout=86_400)
    assets = []
    for requirement in SPEC["assets"]:
        directory = ASSET_ROOT / requirement["id"]
        files = [{"path": item.relative_to(directory).as_posix(), "bytes": item.stat().st_size,
                  "sha256": sha256(item)} for item in sorted(directory.rglob("*")) if item.is_file()] if directory.is_dir() else []
        if not files:
            raise RuntimeError(f"required asset {requirement['id']} was not provisioned")
        assets.append({**requirement, "path": requirement["id"], "files": files})
    (ASSET_ROOT / SPEC["assetManifest"]).write_text(json.dumps(
        {"provider": SPEC["provider"], "modelVersion": SPEC["modelVersion"], "code": SPEC["code"], "assets": assets},
        sort_keys=True, indent=2))

if __name__ == "__main__":
    main()