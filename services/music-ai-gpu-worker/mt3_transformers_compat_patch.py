"""Hash-guarded mt3-infer compatibility patch for Transformers 4.48.3."""
from __future__ import annotations

import hashlib
import sysconfig
from pathlib import Path


RELATIVE_TARGET = Path("mt3_infer/models/mr_mt3/t5.py")
ORIGINAL_SHA256 = "2e453e6750207d86831d5ae9dd604b0968c6e59290ae4b15bbd902f8b7abb4aa"
PATCHED_SHA256 = "f0b0344fd90e50d861d47691b5d140eea97d3b73674682b7188677a9c719d9ea"
ORIGINAL_FRAGMENT = b"                    past_key_values=past_key_value,\n"
PATCHED_FRAGMENT = b"                    past_key_value=past_key_value,\n"


def file_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def patch_content(content: bytes) -> bytes:
    if file_sha256(content) != ORIGINAL_SHA256:
        raise RuntimeError("mt3-infer compatibility patch source hash mismatch")
    if content.count(ORIGINAL_FRAGMENT) != 1:
        raise RuntimeError("mt3-infer compatibility patch fragment mismatch")
    patched = content.replace(ORIGINAL_FRAGMENT, PATCHED_FRAGMENT, 1)
    if file_sha256(patched) != PATCHED_SHA256:
        raise RuntimeError("mt3-infer compatibility patch result hash mismatch")
    if ORIGINAL_FRAGMENT in patched or patched.count(PATCHED_FRAGMENT) != 1:
        raise RuntimeError("mt3-infer compatibility patch verification failed")
    return patched


def main() -> None:
    target = Path(sysconfig.get_paths()["purelib"]) / RELATIVE_TARGET
    if not target.is_file():
        raise RuntimeError("reviewed mt3-infer compatibility patch target is missing")
    target.write_bytes(patch_content(target.read_bytes()))


if __name__ == "__main__":
    main()