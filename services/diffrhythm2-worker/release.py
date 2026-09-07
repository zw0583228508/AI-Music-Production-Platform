"""Observe, attest, and promote one exact DiffRhythm2 research deployment."""
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
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

import modal

from modal_config import APP_NAME, PROMOTION_SECRET_NAME

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[1]
EVIDENCE = ROOT / "release-evidence"
GENERATED = WORKSPACE / "artifacts/api-server/src/lib/gpuPromotions.generated.ts"
KEY_DERIVATION_DOMAIN = b"MUSIC_GPU Modal promotion v1\0"
ED25519_PKCS8_PREFIX = bytes.fromhex("302e020100300506032b657004220420")


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as handle:
        handle.write(canonical(value) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, path)


def modal_json(*args: str) -> object:
    result = subprocess.run(
        ["uv", "run", "modal", *args],
        cwd=WORKSPACE,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Modal metadata command failed: {' '.join(args[:2])}")
    return json.loads(result.stdout)


def origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("DiffRhythm2 endpoint is not a credential-free HTTPS origin")
    return f"https://{parsed.hostname.lower()}" + (
        f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    )


def observe() -> dict:
    apps = modal_json("app", "list", "--json")
    matches = [
        item
        for item in apps
        if isinstance(item, dict)
        and item.get("description") == APP_NAME
        and item.get("state") == "deployed"
    ]
    if len(matches) != 1:
        raise ValueError("expected exactly one deployed DiffRhythm2 app")
    app_id = str(matches[0]["app_id"])
    history = modal_json("app", "history", app_id, "--json")
    if not isinstance(history, list) or not history:
        raise ValueError("DiffRhythm2 deployment history is empty")
    endpoint = modal.Function.from_name(APP_NAME, "endpoint")
    endpoint.hydrate()
    metadata = {
        "provider": "DIFFRHYTHM_2",
        "modalAppId": app_id,
        "modalDeploymentId": str(history[0]["version"]),
        "modalFunctionId": endpoint.object_id,
        "endpointOrigin": origin(endpoint.get_web_url()),
    }
    for field, pattern in {
        "modalAppId": r"ap-[A-Za-z0-9]+",
        "modalDeploymentId": r"v[1-9][0-9]*",
        "modalFunctionId": r"fu-[A-Za-z0-9]+",
    }.items():
        if re.fullmatch(pattern, metadata[field]) is None:
            raise ValueError(f"invalid observed {field}")
    return metadata


def install_identity(metadata: dict) -> None:
    identity = {
        "MUSIC_GPU_MODAL_APP_ID": metadata["modalAppId"],
        "MUSIC_GPU_MODAL_DEPLOYMENT_ID": metadata["modalDeploymentId"],
        "MUSIC_GPU_MODAL_FUNCTION_ID": metadata["modalFunctionId"],
    }
    atomic_json(EVIDENCE / "worker-identity.json", identity)
    subprocess.run(
        [
            "uv",
            "run",
            "modal",
            "secret",
            "create",
            PROMOTION_SECRET_NAME,
            "--from-json",
            str(EVIDENCE / "worker-identity.json"),
            "--force",
        ],
        cwd=WORKSPACE,
        check=True,
    )
    containers = modal_json(
        "container", "list", "--app-id", metadata["modalAppId"], "--json"
    )
    previous = [
        item["container_id"]
        for item in containers
        if isinstance(item, dict)
        and re.fullmatch(r"ta-[A-Za-z0-9]+", str(item.get("container_id", "")))
    ]
    for container in previous:
        subprocess.run(
            [
                "uv",
                "run",
                "modal",
                "container",
                "stop",
                container,
                "--graceful",
                "--yes",
            ],
            cwd=WORKSPACE,
            check=True,
        )
    stale = previous
    for _ in range(30):
        current = modal_json(
            "container", "list", "--app-id", metadata["modalAppId"], "--json"
        )
        stale = [
            item.get("container_id")
            for item in current
            if isinstance(item, dict) and item.get("container_id") in previous
        ]
        if not stale:
            break
        time.sleep(2)
    proof = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "modalDeploymentId": metadata["modalDeploymentId"],
        "stoppedContainerIds": previous,
        "staleContainerIds": stale,
    }
    atomic_json(EVIDENCE / "identity-refresh.json", proof)
    if stale:
        raise RuntimeError("old DiffRhythm2 containers remained after identity rotation")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_health(metadata: dict) -> dict:
    token = os.getenv("MUSIC_AI_WORKER_TOKEN", "")
    if not token:
        raise ValueError("music worker token is unavailable")
    url = f"{metadata['endpointOrigin']}/health"
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.build_opener(NoRedirect).open(request, timeout=1800) as response:
        if response.status != 200 or response.geturl() != url:
            raise RuntimeError("DiffRhythm2 health did not return directly")
        health = json.loads(response.read(2 * 1024 * 1024))
    required = (
        health.get("provider") == "DIFFRHYTHM_2",
        health.get("ready") is True,
        health.get("healthy") is True,
        health.get("licenseStatus") == "RESEARCH_ONLY",
        health.get("commercialUsePermitted") is False,
        health.get("modalAppId") == metadata["modalAppId"],
        health.get("modalDeploymentId") == metadata["modalDeploymentId"],
        health.get("modalFunctionId") == metadata["modalFunctionId"],
        re.fullmatch(r"im-[A-Za-z0-9]+", str(health.get("modalImageId", ""))) is not None,
    )
    if not all(required):
        raise ValueError("DiffRhythm2 live health is incomplete or identity drifted")
    return health


def capture(metadata: dict) -> dict:
    health = fetch_health(metadata)
    atomic_json(EVIDENCE / "live-health.json", health)
    retained_names = (
        "model-assets.json",
        "known-good-short-smoke-proof.json",
        "known-good-short-output.mp3",
        "known-good-short-diagnostic.json",
        "full-fixture-smoke-proof.json",
        "full-fixture-output.mp3",
        "full-fixture-diagnostic.json",
    )
    retained = {}
    for name in retained_names:
        path = EVIDENCE / name
        retained[name] = {"sha256": sha256(path), "bytes": path.stat().st_size}
    release = {
        "schemaVersion": 1,
        **metadata,
        "modalImageId": health["modalImageId"],
        "modelVersion": health["modelVersion"],
        "checkpointRevision": health["revision"],
        "checkpointSha256": health["checkpointSha256"],
        "sourceRevision": health["sourceRevision"],
        "sourceImageDigest": health["sourceImageDigest"],
        "licenseStatus": "RESEARCH_ONLY",
        "commercialUsePermitted": False,
        "retainedEvidence": retained,
        "liveHealth": health,
    }
    atomic_json(EVIDENCE / "release-evidence.json", release)
    return release


def private_key() -> tuple[Path, bool]:
    material = os.getenv("MUSIC_GPU_PROMOTION_SIGNING_KEY", "").strip()
    if not material:
        raise ValueError("promotion signing key is unavailable")
    try:
        raw = base64.b64decode(material, validate=True)
    except ValueError as exc:
        raise ValueError("promotion signing key is not base64") from exc
    seed = raw if len(raw) == 32 else hashlib.sha256(
        KEY_DERIVATION_DOMAIN + raw
    ).digest()
    result = subprocess.run(
        ["openssl", "pkey", "-inform", "DER", "-outform", "PEM"],
        input=ED25519_PKCS8_PREFIX + seed,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError("Ed25519 key normalization failed")
    handle = tempfile.NamedTemporaryFile(mode="wb", delete=False)
    handle.write(result.stdout)
    handle.close()
    os.chmod(handle.name, 0o600)
    return Path(handle.name), True


def sign(record: dict, key: Path) -> str:
    with tempfile.NamedTemporaryFile(mode="wb", delete=False) as handle:
        handle.write(canonical(record).encode())
        message = Path(handle.name)
    try:
        result = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-sign",
                "-rawin",
                "-inkey",
                str(key),
                "-in",
                str(message),
            ],
            capture_output=True,
            check=False,
        )
    finally:
        message.unlink(missing_ok=True)
    if result.returncode or len(result.stdout) != 64:
        raise RuntimeError("DiffRhythm2 Ed25519 signing failed")
    return base64.b64encode(result.stdout).decode()


def promote(release: dict) -> tuple[dict, str]:
    health = release["liveHealth"]
    record = {
        "schemaVersion": 1,
        "provider": "DIFFRHYTHM_2",
        "modalAppId": release["modalAppId"],
        "modalDeploymentId": release["modalDeploymentId"],
        "modalFunctionId": release["modalFunctionId"],
        "modalImageId": release["modalImageId"],
        "endpointOrigin": release["endpointOrigin"],
        "modelVersion": release["modelVersion"],
        "checkpointSha256": release["checkpointSha256"],
        "checkpointRevision": release["checkpointRevision"],
        "sourceRevision": release["sourceRevision"],
        "sourceImageDigest": release["sourceImageDigest"],
        "releaseEvidenceSha256": hashlib.sha256(
            canonical(release).encode()
        ).hexdigest(),
        "runtime": {
            "python": health["runtime"]["pythonVersion"],
            "cudaImage": health["framework"]["cuda_image"],
            "cuda": health["framework"]["cuda"],
            "pytorch": health["framework"]["pytorch"],
            "torchvision": health["framework"]["torchvision"],
            "torchaudio": health["framework"]["torchaudio"],
            "torchIndexUrl": health["framework"]["torch_index_url"],
            "transformers": health["framework"]["transformers"],
            "accelerate": health["framework"]["accelerate"],
        },
    }
    key, temporary = private_key()
    try:
        bundle = {"record": record, "signature": sign(record, key)}
        public = subprocess.run(
            ["openssl", "pkey", "-in", str(key), "-pubout"],
            capture_output=True,
            check=True,
        ).stdout.decode()
    finally:
        if temporary:
            key.unlink(missing_ok=True)
    atomic_json(EVIDENCE / "promotion-bundle.json", bundle)
    (EVIDENCE / "promotion-public-key.pem").write_text(public)
    return bundle, public


def activate(bundle: dict, public: str) -> None:
    match = re.fullmatch(
        r"/\* Generated by the fail-closed generic Modal release workflow\. \*/\n"
        r"export const committedGpuPromotionsJson = (.+);\n",
        GENERATED.read_text(),
    )
    if not match:
        raise ValueError("canonical promotions file is malformed")
    collection = json.loads(json.loads(match.group(1)))
    if collection.get("publicKey", "").strip() != public.strip():
        raise ValueError("DiffRhythm2 signing key differs from canonical promotion key")
    collection["bundles"]["DIFFRHYTHM_2"] = bundle
    GENERATED.write_text(
        "/* Generated by the fail-closed generic Modal release workflow. */\n"
        f"export const committedGpuPromotionsJson = {json.dumps(canonical(collection))};\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=("observe", "install-identity", "capture", "promote", "activate"),
    )
    args = parser.parse_args()
    metadata_path = EVIDENCE / "observed-deployment.json"
    if args.command == "observe":
        atomic_json(metadata_path, observe())
    elif args.command == "install-identity":
        install_identity(json.loads(metadata_path.read_text()))
    elif args.command == "capture":
        capture(json.loads(metadata_path.read_text()))
    elif args.command == "promote":
        promote(json.loads((EVIDENCE / "release-evidence.json").read_text()))
    else:
        activate(
            json.loads((EVIDENCE / "promotion-bundle.json").read_text()),
            (EVIDENCE / "promotion-public-key.pem").read_text(),
        )


if __name__ == "__main__":
    main()