"""Verify the exact upstream-compatible YourMT3 runtime without patching it."""
from __future__ import annotations

import hashlib
import importlib.metadata
import sysconfig
from pathlib import Path


RELATIVE_TARGET = Path("mt3_infer/models/yourmt3/model/t5mod.py")
ORIGINAL_SHA256 = "b2cc683b55f5d3284c0788d59f8f0a7c39b03535731aeb7a62c81c86c351f480"
# Kept for the existing deployment evidence schema: no behavioral patch means
# the verified output hash must equal the reviewed upstream input hash.
PATCHED_SHA256 = ORIGINAL_SHA256
EXPECTED_TRANSFORMERS_VERSION = "4.45.1"


def file_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def patch_content(content: bytes) -> bytes:
    if file_sha256(content) != ORIGINAL_SHA256:
        raise RuntimeError("YourMT3 compatibility guard source hash mismatch")
    return content


def main() -> None:
    if importlib.metadata.version("transformers") != EXPECTED_TRANSFORMERS_VERSION:
        raise RuntimeError("YourMT3 requires the reviewed Transformers 4.45.1 runtime")
    target = Path(sysconfig.get_paths()["purelib"]) / RELATIVE_TARGET
    if not target.is_file():
        raise RuntimeError("reviewed YourMT3 compatibility guard target is missing")
    patch_content(target.read_bytes())


if __name__ == "__main__":
    main()