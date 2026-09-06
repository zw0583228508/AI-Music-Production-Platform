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
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())
INSTALLATION_STATUS = json.loads((ROOT / "installation-status.json").read_text())
KEY_DERIVATION_DOMAIN = b"BEAT_THIS Ed25519 promotion v1\0"
ED25519_PKCS8_PREFIX = bytes.fromhex("302e020100300506032b657004220420")
RUNTIME_KEYS = (
    "python", "cudaImage", "cuda", "pytorch", "torchvision", "torchaudio",
    "torchIndexUrl", "transformers", "accelerate",
)

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
    identifier_patterns = (
        (args.modal_app_id, r"ap-[A-Za-z0-9]+", "app"),
        (args.modal_deployment_id, r"v[1-9][0-9]*", "deployment"),
        (args.modal_function_id, r"fu-[A-Za-z0-9]+", "function"),
    )
    for value, pattern, label in identifier_patterns:
        if not re.fullmatch(pattern, value.strip()):
            raise ValueError(f"invalid Modal {label} ID")
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
        "runtime": {key: runtime[key] for key in RUNTIME_KEYS},
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

def verify_live_health_with_retries(
    fetch_health,
    expected: dict,
    attempts: int = 6,
    delay_seconds: float = 5,
) -> None:
    """Retry only the worker's explicit, authenticated cold-start state."""
    if attempts < 1:
        raise ValueError("health verification attempts must be positive")
    for attempt in range(attempts):
        payload = fetch_health()
        if (isinstance(payload, dict) and payload.get("provider") == "BEAT_THIS"
                and payload.get("status") == "starting"
                and payload.get("ready") is False
                and payload.get("retryable") is True):
            if attempt + 1 == attempts:
                raise TimeoutError("authenticated health remained in startup state")
            time.sleep(delay_seconds)
            continue
        verify_live_health(payload, expected)
        return

class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def trusted_endpoint_origin(endpoint_origin: str) -> str:
    expected = INSTALLATION_STATUS["providers"]["BEAT_THIS"]["evidence"][
        "liveHealthEndpointOrigin"
    ]
    candidate = origin(endpoint_origin)
    if candidate != origin(expected):
        raise ValueError("endpoint does not match the trusted Beat This deployment origin")
    return candidate

def fetch_authenticated_health(endpoint_origin: str, token: str) -> object:
    endpoint = trusted_endpoint_origin(endpoint_origin)
    if not token:
        raise ValueError("Beat This worker token is unavailable")
    request = Request(
        endpoint + "/health?provider=BEAT_THIS",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with build_opener(NoRedirects).open(request, timeout=30) as response:
            return json.loads(response.read())
    except HTTPError as exc:
        raise RuntimeError("authenticated health request failed") from exc

def verify_health_file_with_retries(
    health_file: Path,
    endpoint_origin: str,
    expected: dict,
    token: str,
    attempts: int = 6,
    delay_seconds: float = 5,
) -> None:
    endpoint = trusted_endpoint_origin(endpoint_origin)
    first = json.loads(health_file.read_text())
    used_first = False

    def fetch_health():
        nonlocal used_first
        if not used_first:
            used_first = True
            return first
        return fetch_authenticated_health(endpoint, token)

    verify_live_health_with_retries(
        fetch_health, expected, attempts=attempts, delay_seconds=delay_seconds
    )

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

def public_key(key_path: Path, key_format: str | None = None) -> str:
    command = ["openssl", "pkey", "-in", str(key_path), "-pubout"]
    if key_format:
        command.extend(["-inform", key_format])
    result = subprocess.run(command, capture_output=True, check=False)
    if result.returncode or not result.stdout.startswith(b"-----BEGIN PUBLIC KEY-----"):
        raise RuntimeError("Ed25519 promotion public-key derivation failed")
    return result.stdout.decode()

def atomic_write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as temporary:
        temporary.write(value)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, path)

def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("modal-app-id", "modal-deployment-id", "modal-function-id",
                 "modal-image-id", "endpoint-origin", "source-revision",
                 "source-image-digest", "health-file", "output"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--private-key-file")
    parser.add_argument("--public-key-output", required=True)
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
        token = (
            os.getenv("BEAT_THIS_WORKER_TOKEN")
            or os.getenv("MUSIC_AI_WORKER_TOKEN")
            or ""
        ).strip()
        verify_health_file_with_retries(
            Path(args.health_file), args.endpoint_origin, payload, token,
        )
        bundle = {
            "record": payload,
            "signature": sign(payload, key_path, key_format),
        }
        atomic_write(Path(args.output), canonical(bundle) + "\n")
        atomic_write(
            Path(args.public_key_output),
            public_key(key_path, key_format),
        )
    finally:
        if temporary:
            key_path.unlink(missing_ok=True)

if __name__ == "__main__":
    main()
