#!/usr/bin/env python3
"""Provision pinned, public sfizz/VSCO2 CE sources outside Git.

This intentionally does not activate an asset. The resulting host and library
must still be approved, staged, smoke-rendered, and atomically activated by the
worker's native asset lifecycle.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

SFIZZ_REPOSITORY = "https://github.com/sfztools/sfizz.git"
SFIZZ_TAG = "1.2.3"
SFIZZ_COMMIT = "4e70dc0bef53b41f2853ed46e26f5911114c92d0"
VSCO_REPOSITORY = "https://github.com/sgossner/VSCO-2-CE.git"
VSCO_COMMIT = "6dd651d55dde97fd4028699be9d4481f26917891"


def run(*command: str) -> None:
    subprocess.run(command, check=True)


def tree_evidence(path: Path) -> dict:
    if path.is_file():
        return {
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "fileCount": 1,
            "bytes": path.stat().st_size,
        }
    files = sorted(value for value in path.rglob("*") if value.is_file() and ".git" not in value.parts)
    digest = hashlib.sha256()
    size = 0
    for value in files:
        digest.update(str(value.relative_to(path)).encode())
        digest.update(b"\0")
        with value.open("rb") as handle:
            while block := handle.read(1024 * 1024):
                size += len(block)
                digest.update(block)
    return {"sha256": digest.hexdigest(), "fileCount": len(files), "bytes": size}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/var/lib/music-ai/assets/sfz"))
    args = parser.parse_args()
    root = args.root.resolve()
    source = root / ".sources" / "sfizz-1.2.3"
    library = root / "vsco2-ce"
    build = root / ".build" / "sfizz-1.2.3"
    for path in (source, library, build):
        if path.exists():
            shutil.rmtree(path)
        path.parent.mkdir(parents=True, exist_ok=True)
    run("git", "clone", "--filter=blob:none", SFIZZ_REPOSITORY, str(source))
    run("git", "-C", str(source), "checkout", "--detach", SFIZZ_COMMIT)
    run("git", "-C", str(source), "submodule", "update", "--init", "--recursive")
    run("git", "clone", "--branch", "SFZ", "--single-branch", VSCO_REPOSITORY, str(library))
    run("git", "-C", str(library), "checkout", "--detach", VSCO_COMMIT)
    run("cmake", "-S", str(source), "-B", str(build), "-DSFIZZ_JACK=OFF", "-DSFIZZ_LV2=OFF",
        "-DSFIZZ_VST=OFF", "-DSFIZZ_RENDER=ON")
    run("cmake", "--build", str(build), "--target", "sfizz_render", "--parallel")
    binary = next(build.rglob("sfizz_render"))
    evidence = {
        "sfizz": {"version": SFIZZ_TAG, "commit": SFIZZ_COMMIT, **tree_evidence(binary)},
        "vsco2Ce": {"version": "SFZ branch", "commit": VSCO_COMMIT, "license": "CC0-1.0",
                    **tree_evidence(library)},
    }
    (root / "provision-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()