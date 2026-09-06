"""Build and sign the complete Beat This Modal promotion bundle."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())
KEY_DERIVATION_DOMAIN = b"BEAT_THIS Ed25519 promotion v1\0"
ED25519_PKCS8_PREFIX = bytes.fromhex("302e020100300506032b657004220420")

def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def origin(value: str) -> str:
    parsed = urlsplit(value.strip())
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
            parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("endpoint must be an HTTPS origin")
    return f"https://{parsed.hostname.lower()}" + (
        f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    )

def record(args: argparse.Namespace) -> dict:
    identifiers = (args.modal_app_id, args.modal_deployment_id, args.modal_function_id)
    if any(not value.strip() for value in identifiers):
        raise ValueError("Modal IDs must not be empty")
    if not re.fullmatch(r"im-[A-Za-z0-9]+", args.modal_image_id):
        raise ValueError("invalid Modal image ID")
    if not re.fullmatch(r"[a-f0-9]{40}", args.source_revision):
        raise ValueError("source revision must be a full immutable Git SHA")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.source_image_digest):
        raise ValueError("invalid source-image digest")
    runtime = MANIFEST["runtime"]
    return {
        "schemaVersion": 1, "provider": "BEAT_THIS",
        "modalAppId": args.modal_app_id, "modalDeploymentId": args.modal_deployment_id,
        "modalFunctionId": args.modal_function_id, "modalImageId": args.modal_image_id,
        "endpointOrigin": origin(args.endpoint_origin),
        "modelVersion": MANIFEST["version"],
        "checkpointSha256": MANIFEST["checkpointSha256"],
        "checkpointRevision": MANIFEST["sourceCommit"],
        "sourceRevision": args.source_revision,
        "sourceImageDigest": args.source_image_digest,
        "runtime": {
            "python": runtime["python"], "cudaImage": runtime["cudaImage"],
            "cuda": runtime["cuda"], "pytorch": runtime["pytorch"],
            "torchvision": runtime["torchvision"], "torchaudio": runtime["torchaudio"],
            "torchIndexUrl": runtime["torchIndexUrl"],
            "transformers": runtime["transformers"], "accelerate": runtime["accelerate"],
        },
    }

def verify_live_health(payload: object, expected: dict) -> None:
    if not isinstance(payload, dict):
        raise ValueError("authenticated health payload must be an object")
    exact = {
        "provider": expected["provider"],
        "status": "ready",
        "ready": True,
        "modalAppId": expected["modalAppId"],
        "modalDeploymentId": expected["modalDeploymentId"],
        "modalFunctionId": expected["modalFunctionId"],
        "modalImageId": expected["modalImageId"],
        "modelVersion": expected["modelVersion"],
        "checkpointSha256": expected["checkpointSha256"],
        "revision": expected["checkpointRevision"],
        "sourceRevision": expected["sourceRevision"],
        "sourceImageDigest": expected["sourceImageDigest"],
    }
    if any(payload.get(key) != value for key, value in exact.items()):
        raise ValueError("authenticated live health does not match promotion identity")
    framework = payload.get("framework")
    runtime = payload.get("runtime")
    runtime_pairs = {
        "python": runtime.get("pythonVersion") if isinstance(runtime, dict) else None,
        "cudaImage": framework.get("cuda_image") if isinstance(framework, dict) else None,
        "cuda": framework.get("cuda") if isinstance(framework, dict) else None,
        "pytorch": framework.get("pytorch") if isinstance(framework, dict) else None,
        "torchvision": framework.get("torchvision") if isinstance(framework, dict) else None,
        "torchaudio": framework.get("torchaudio") if isinstance(framework, dict) else None,
        "torchIndexUrl": framework.get("torch_index_url") if isinstance(framework, dict) else None,
        "transformers": framework.get("transformers") if isinstance(framework, dict) else None,
        "accelerate": framework.get("accelerate") if isinstance(framework, dict) else None,
    }
    if runtime_pairs != expected["runtime"]:
        raise ValueError("authenticated live health runtime does not match promotion identity")

def private_key_bytes(material: str) -> tuple[bytes, str | None]:
    """Normalize the configured signing material without persisting its source."""
    encoded = material.strip()
    if encoded.startswith("-----BEGIN"):
        return encoded.encode(), None
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise ValueError("promotion signing key is not PEM or base64") from exc
    if len(raw) < 16:
        raise ValueError("promotion signing material is too short")
    seed = raw if len(raw) == 32 else hashlib.sha256(
        KEY_DERIVATION_DOMAIN + raw
    ).digest()
    return ED25519_PKCS8_PREFIX + seed, "DER"

def sign(payload: dict, key_path: Path, key_format: str | None = None) -> str:
    command = ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(key_path)]
    if key_format:
        command.extend(["-keyform", key_format])
    with tempfile.NamedTemporaryFile() as source:
        source.write(canonical(payload).encode()); source.flush()
        result = subprocess.run(
            [*command, "-in", source.name],
            capture_output=True, check=False,
        )
    if result.returncode or len(result.stdout) != 64:
        raise RuntimeError("Ed25519 promotion signing failed")
    return base64.b64encode(result.stdout).decode()

def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("modal-app-id", "modal-deployment-id", "modal-function-id",
                 "modal-image-id", "endpoint-origin", "source-revision",
                 "source-image-digest", "health-file", "output"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--private-key-file")
    args = parser.parse_args()
    key_path = Path(args.private_key_file) if args.private_key_file else None
    key_format = None
    temporary = None
    if key_path is None:
        material = os.getenv("MUSIC_GPU_PROMOTION_SIGNING_KEY", "")
        if not material:
            raise ValueError("promotion signing key is unavailable")
        normalized, key_format = private_key_bytes(material)
        temporary = tempfile.NamedTemporaryFile(mode="wb", delete=False)
        temporary.write(normalized); temporary.close()
        key_path = Path(temporary.name)
    try:
        payload = record(args)
        verify_live_health(
            json.loads(Path(args.health_file).read_text()),
            payload,
        )
        bundle = {
            "record": payload,
            "signature": sign(payload, key_path, key_format),
        }
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(canonical(bundle) + "\n")
    finally:
        if temporary:
            key_path.unlink(missing_ok=True)

if __name__ == "__main__":
    main()