#!/usr/bin/env python3
"""Sign the retained MusicGen release evidence without exposing key material."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT / "release-evidence"
DOMAIN = b"MUSICGEN release evidence v1\0"
PKCS8_PREFIX = bytes.fromhex("302e020100300506032b657004220420")


def canonical(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(name: str) -> str:
    return hashlib.sha256((EVIDENCE / name).read_bytes()).hexdigest()


def main() -> None:
    material = os.getenv("MUSIC_GPU_PROMOTION_SIGNING_KEY", "").strip()
    if not material:
        raise RuntimeError("MusicGen evidence signing key is unavailable")
    raw = base64.b64decode(material, validate=True)
    seed = raw if len(raw) == 32 else hashlib.sha256(DOMAIN + raw).digest()
    with tempfile.TemporaryDirectory() as directory:
        private_path = Path(directory) / "private.pem"
        converted = subprocess.run(
            ["openssl", "pkey", "-inform", "DER", "-outform", "PEM"],
            input=PKCS8_PREFIX + seed, capture_output=True, check=False,
        )
        if converted.returncode:
            raise RuntimeError("MusicGen Ed25519 key normalization failed")
        private_path.write_bytes(converted.stdout)
        os.chmod(private_path, 0o600)
        public = subprocess.run(
            ["openssl", "pkey", "-in", str(private_path), "-pubout"],
            capture_output=True, check=True,
        ).stdout.decode()
        attestation = json.loads((ROOT / "release-attestation.json").read_text())
        record = {
            "schemaVersion": 1,
            "provider": "MUSICGEN",
            "sourceRevision": attestation["source"]["revision"],
            "textModelRevision": attestation["models"]["text"]["revision"],
            "melodyModelRevision": attestation["models"]["melody"]["revision"],
            "endpointOrigin": attestation["deployment"]["endpointOrigin"],
            "evidence": {
                name: digest(name)
                for name in (
                    "model_manifest.json", "smoke-proof.json", "text-smoke.wav",
                    "melody-smoke.wav", "melody-source.wav", "live-health.json",
                    "api-catalog.json",
                )
            },
        }
        message_path = Path(directory) / "record.json"
        message_path.write_bytes(canonical(record))
        signed = subprocess.run(
            ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private_path),
             "-in", str(message_path)],
            capture_output=True, check=True,
        ).stdout
        if len(signed) != 64:
            raise RuntimeError("MusicGen Ed25519 signature is invalid")
    (EVIDENCE / "release-public-key.pem").write_text(public)
    (EVIDENCE / "release-bundle.json").write_text(json.dumps({
        "record": record,
        "signature": base64.b64encode(signed).decode(),
    }, indent=2, sort_keys=True) + "\n")
    print("Signed retained MusicGen release evidence.")


if __name__ == "__main__":
    main()