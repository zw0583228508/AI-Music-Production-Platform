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
CANDIDATE_APP_NAME = "beat-this-candidate"
CANDIDATE_ENDPOINT_LABEL = "beat-this-candidate"
STARTUP_HEALTH_CONTRACT = {
    "provider": "BEAT_THIS",
    "status": "starting",
    "ready": False,
    "healthy": False,
    "retryable": True,
    "retryAfterSeconds": 5,
    "reason": "runtime initialization is still in progress",
}
HEALTH_PAYLOAD_KEYS = {
    "provider", "status", "ready", "healthy", "retryable",
    "retryAfterSeconds", "modelVersion", "checksum", "checkpointSha256",
    "revision", "sourceRevision", "sourceImageDigest", "modalAppId",
    "modalDeploymentId", "modalFunctionId", "modalImageId", "runtime",
    "framework", "packageName", "packageVersion", "packageReady",
    "assetReady", "featureExecutionReady", "runtimeReady",
    "checkpointReady", "smokeTested", "gpuReady", "identityReady", "reason",
}

def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def release_evidence_sha256(evidence: object) -> str:
    return hashlib.sha256((canonical(evidence) + "\n").encode()).hexdigest()

def origin(value: str) -> str:
    parsed = urlsplit(value.strip())
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
            parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("endpoint must be an HTTPS origin")
    return f"https://{parsed.hostname.lower()}" + (
        f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    )


def validate_release_branch(value: object) -> str:
    if not isinstance(value, str) or not value or value.startswith("-"):
        raise ValueError("release branch is invalid")
    result = subprocess.run(
        ["git", "check-ref-format", "--branch", value],
        cwd=ROOT.parents[1],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise ValueError("release branch is invalid")
    return value


def validate_release_evidence(evidence: object) -> None:
    if not isinstance(evidence, dict) or evidence.get("provider") != "BEAT_THIS":
        raise ValueError("release evidence is not for Beat This")
    patterns = {
        "modalAppId": r"ap-[A-Za-z0-9]+",
        "modalDeploymentId": r"v[1-9][0-9]*",
        "modalFunctionId": r"fu-[A-Za-z0-9]+",
        "modalImageId": r"im-[A-Za-z0-9]+",
        "sourceRevision": r"[a-f0-9]{40}",
        "sourceImageDigest": r"sha256:[a-f0-9]{64}",
    }
    for field, pattern in patterns.items():
        if not re.fullmatch(pattern, str(evidence.get(field, ""))):
            raise ValueError(f"release evidence has invalid {field}")
    origin(str(evidence.get("endpointOrigin", "")))
    if "releaseBranch" in evidence:
        validate_release_branch(evidence["releaseBranch"])
    proof = evidence.get("smokeEvidence")
    if not isinstance(proof, dict) or proof.get("provider") != "BEAT_THIS":
        raise ValueError("real smoke evidence is missing")
    if proof.get("featureExecutionSucceeded") is not True:
        raise ValueError("real smoke execution did not succeed")
    result = proof.get("result")
    fixture = proof.get("fixture")
    checkpoint = proof.get("checkpoint")
    if (
        not isinstance(result, dict)
        or not isinstance(fixture, dict)
        or not isinstance(checkpoint, dict)
        or not isinstance(result.get("beatCount"), int)
        or result["beatCount"] < 2
        or not isinstance(result.get("downbeatCount"), int)
        or result["downbeatCount"] < 1
        or not re.fullmatch(r"[a-f0-9]{64}", str(fixture.get("sha256", "")))
        or not re.fullmatch(r"[a-f0-9]{64}", str(fixture.get("sourceSha256", "")))
        or not re.fullmatch(r"[a-f0-9]{64}", str(checkpoint.get("sha256", "")))
    ):
        raise ValueError("real beat/downbeat smoke evidence is incomplete")


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
    if not re.fullmatch(r"[a-f0-9]{64}", args.release_evidence_sha256):
        raise ValueError("invalid release-evidence digest")
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
        "releaseEvidenceSha256": args.release_evidence_sha256,
        "runtime": {key: runtime[key] for key in RUNTIME_KEYS},
    }

def _verify_live_identity(payload: object, expected: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("authenticated health payload must be an object")
    exact = {
        "provider": expected["provider"],
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
    return payload

def verify_live_health(payload: object, expected: dict) -> None:
    if not isinstance(payload, dict) or set(payload) != HEALTH_PAYLOAD_KEYS:
        raise ValueError("authenticated live health schema does not match")
    checked = _verify_live_identity(payload, expected)
    if (
        checked.get("status") != "ready"
        or checked.get("ready") is not True
        or checked.get("healthy") is not True
        or checked.get("retryable") is not False
        or checked.get("retryAfterSeconds") is not None
    ):
        raise ValueError("authenticated live health is not ready")

def is_retryable_startup(payload: object) -> bool:
    return (
        isinstance(payload, dict)
        and set(payload) == HEALTH_PAYLOAD_KEYS
        and all(
            payload.get(key) == value
            for key, value in STARTUP_HEALTH_CONTRACT.items()
        )
    )

def verify_retryable_startup(payload: object, expected: dict) -> None:
    if not is_retryable_startup(payload):
        raise ValueError("authenticated health is not the exact startup contract")
    checked = _verify_live_identity(payload, expected)
    exact = {
        "checksum": expected["checkpointSha256"],
        "packageName": "beat-this",
        "packageVersion": expected["modelVersion"],
        "packageReady": False,
        "assetReady": False,
        "featureExecutionReady": False,
        "runtimeReady": False,
        "checkpointReady": False,
        "smokeTested": False,
        "gpuReady": False,
        "identityReady": True,
    }
    if any(checked.get(key) != value for key, value in exact.items()):
        raise ValueError("authenticated startup health identity does not match")

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
        if is_retryable_startup(payload):
            verify_retryable_startup(payload, expected)
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

def trusted_candidate_origin(endpoint_origin: str) -> str:
    expected = candidate_origin_from_production(
        INSTALLATION_STATUS["providers"]["BEAT_THIS"]["evidence"][
            "liveHealthEndpointOrigin"
        ]
    )
    candidate = origin(endpoint_origin)
    if candidate != expected:
        raise ValueError("endpoint does not match the trusted Beat This candidate origin")
    return candidate

def candidate_origin_from_production(endpoint_origin: str) -> str:
    production = urlsplit(trusted_endpoint_origin(endpoint_origin))
    production_suffix = "--beat-this.modal.run"
    if not production.hostname or not production.hostname.endswith(production_suffix):
        raise ValueError("trusted Beat This origin is not a Modal endpoint")
    workspace = production.hostname[:-len(production_suffix)]
    return f"https://{workspace}--{CANDIDATE_ENDPOINT_LABEL}.modal.run"

def fetch_authenticated_health(
    endpoint_origin: str, token: str, *, candidate: bool = False
) -> object:
    endpoint = (
        trusted_candidate_origin(endpoint_origin)
        if candidate else trusted_endpoint_origin(endpoint_origin)
    )
    if not token:
        raise ValueError("Beat This worker token is unavailable")
    request = Request(
        endpoint + "/health?provider=BEAT_THIS",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with build_opener(NoRedirects).open(request, timeout=30) as response:
            return json.loads(response.read())
    except (HTTPError, OSError, ValueError):
        raise RuntimeError("authenticated health request failed") from None

def wait_for_candidate_route(
    endpoint_origin: str,
    *,
    attempts: int = 6,
    delay_seconds: float = 5,
) -> int:
    """Reach the candidate's auth boundary without sending a credential."""
    endpoint = trusted_candidate_origin(endpoint_origin)
    if attempts < 1:
        raise ValueError("route verification attempts must be positive")
    request = Request(
        endpoint + "/health?provider=BEAT_THIS",
        headers={"Accept": "application/json"},
    )
    for attempt in range(attempts):
        try:
            with build_opener(NoRedirects).open(request, timeout=30):
                raise ValueError("candidate health route accepted an unauthenticated request")
        except HTTPError as exc:
            if exc.code == 401:
                return attempt + 1
            if exc.code not in (404, 500, 502, 503, 504):
                raise RuntimeError("candidate route returned an unexpected status") from None
        except OSError:
            pass
        if attempt + 1 < attempts:
            time.sleep(delay_seconds)
    raise TimeoutError("candidate route did not reach its authentication boundary")

def refresh_candidate_and_verify(
    endpoint_origin: str,
    token: str,
    expected: dict,
    *,
    attempts: int = 6,
    delay_seconds: float = 5,
    run=None,
) -> dict:
    """Recreate the fixed candidate and retain only bounded health states."""
    endpoint = trusted_candidate_origin(endpoint_origin)
    if attempts < 1:
        raise ValueError("health verification attempts must be positive")
    runner = run or subprocess.run
    result = runner(
        [
            "uv", "run", "modal", "app", "rollover", CANDIDATE_APP_NAME,
            "--strategy", "recreate",
        ],
        cwd=ROOT.parents[1],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError("Beat This candidate refresh failed")

    route_attempts = wait_for_candidate_route(
        endpoint, attempts=attempts, delay_seconds=delay_seconds
    )
    observed: list[str] = []

    def fetch_health():
        payload = fetch_authenticated_health(endpoint, token, candidate=True)
        if is_retryable_startup(payload):
            observed.append("starting")
        else:
            verify_live_health(payload, expected)
            observed.append("ready")
        return payload

    verify_live_health_with_retries(
        fetch_health, expected, attempts=attempts, delay_seconds=delay_seconds
    )
    return {
        "provider": "BEAT_THIS",
        "candidate": CANDIDATE_APP_NAME,
        "refreshStrategy": "recreate",
        "routeAttempts": route_attempts,
        "firstStatus": observed[0],
        "finalStatus": observed[-1],
        "attempts": len(observed),
    }

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
                 "source-image-digest", "release-evidence", "health-file", "output"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--private-key-file")
    parser.add_argument("--public-key-output", required=True)
    args = parser.parse_args()
    evidence = json.loads(Path(args.release_evidence).read_text())
    args.release_evidence_sha256 = release_evidence_sha256(evidence)
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
