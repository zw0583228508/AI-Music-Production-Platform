"""Capture, sign, and activate one exact AnyAccomp Modal release."""
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
import wave
from pathlib import Path
from urllib.parse import urlsplit

import modal

from modal_config import APP_NAME, PROMOTION_SECRET_NAME

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[1]
EVIDENCE = ROOT / "release-evidence"
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())
LICENSE_REVIEW = json.loads((EVIDENCE / "license-review.json").read_text())
GENERATED = WORKSPACE / "artifacts/api-server/src/lib/gpuPromotions.generated.ts"
KEY_DERIVATION_DOMAIN = b"MUSIC_GPU Modal promotion v1\0"
ED25519_PKCS8_PREFIX = bytes.fromhex("302e020100300506032b657004220420")


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


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


def command_json(*args: str) -> object:
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
        raise ValueError("AnyAccomp endpoint is not a credential-free HTTPS origin")
    return f"https://{parsed.hostname.lower()}" + (
        f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    )


def validate_metadata(value: object) -> dict:
    if not isinstance(value, dict) or value.get("provider") != "ANYACCOMP":
        raise ValueError("AnyAccomp Modal metadata provider mismatch")
    for field, pattern in {
        "modalAppId": r"ap-[A-Za-z0-9]+",
        "modalDeploymentId": r"v[1-9][0-9]*",
        "modalFunctionId": r"fu-[A-Za-z0-9]+",
    }.items():
        if not re.fullmatch(pattern, str(value.get(field, ""))):
            raise ValueError(f"AnyAccomp Modal metadata has invalid {field}")
    origin(str(value.get("endpointOrigin", "")))
    return value


def observe() -> dict:
    apps = command_json("app", "list", "--json")
    matches = [
        item for item in apps
        if isinstance(item, dict)
        and item.get("description") == APP_NAME
        and item.get("state") == "deployed"
    ] if isinstance(apps, list) else []
    if len(matches) != 1:
        raise ValueError("expected exactly one deployed AnyAccomp Modal app")
    app_id = str(matches[0].get("app_id", ""))
    history = command_json("app", "history", app_id, "--json")
    if not isinstance(history, list) or not history:
        raise ValueError("AnyAccomp Modal deployment history is empty")
    deployment_id = str(history[0].get("version", ""))
    endpoint = modal.Cls.from_name(APP_NAME, "AnyAccompWorker")().endpoint
    endpoint.hydrate()
    return validate_metadata({
        "provider": "ANYACCOMP",
        "modalAppId": app_id,
        "modalDeploymentId": deployment_id,
        "modalFunctionId": endpoint.object_id,
        "endpointOrigin": origin(endpoint.get_web_url()),
    })


def identity(metadata: dict) -> dict:
    validate_metadata(metadata)
    return {
        "MUSIC_GPU_MODAL_APP_ID": metadata["modalAppId"],
        "MUSIC_GPU_MODAL_DEPLOYMENT_ID": metadata["modalDeploymentId"],
        "MUSIC_GPU_MODAL_FUNCTION_ID": metadata["modalFunctionId"],
        "MUSIC_GPU_PROMOTION_ENDPOINT_ORIGIN": metadata["endpointOrigin"],
        "ANYACCOMP_PUBLIC_ORIGIN": metadata["endpointOrigin"],
    }


def install_identity(metadata: dict) -> dict:
    prepared = identity(metadata)
    identity_path = EVIDENCE / "worker-identity.json"
    atomic_json(identity_path, prepared)
    subprocess.run(
        [
            "uv", "run", "modal", "secret", "create", PROMOTION_SECRET_NAME,
            "--from-json", str(identity_path), "--force",
        ],
        cwd=WORKSPACE,
        check=True,
    )
    containers = command_json("container", "list", "--app-id", metadata["modalAppId"], "--json")
    previous = [
        item["container_id"] for item in containers
        if isinstance(item, dict)
        and item.get("app_id") == metadata["modalAppId"]
        and re.fullmatch(r"ta-[A-Za-z0-9]+", str(item.get("container_id", "")))
    ] if isinstance(containers, list) else []
    for container_id in previous:
        subprocess.run(
            [
                "uv", "run", "modal", "container", "stop", container_id,
                "--graceful", "--yes",
            ],
            cwd=WORKSPACE,
            check=True,
        )
    stale = previous
    for attempt in range(30):
        remaining = command_json(
            "container", "list", "--app-id", metadata["modalAppId"], "--json"
        )
        stale = [
            item.get("container_id") for item in remaining
            if isinstance(item, dict) and item.get("container_id") in previous
        ] if isinstance(remaining, list) else previous
        if not stale:
            break
        if attempt < 29:
            time.sleep(2)
    proof = {
        "schemaVersion": 1,
        "provider": "ANYACCOMP",
        "modalAppId": metadata["modalAppId"],
        "modalDeploymentId": metadata["modalDeploymentId"],
        "stoppedContainerIds": previous,
        "staleContainerIds": stale,
    }
    atomic_json(EVIDENCE / "identity-refresh.json", proof)
    if stale:
        raise RuntimeError("old AnyAccomp containers remained after identity rotation")
    return proof


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
            raise RuntimeError("AnyAccomp health did not return directly from Modal")
        return json.loads(response.read(2 * 1024 * 1024))


def verify_generation(metadata: dict, source_url_file: Path) -> dict:
    validate_metadata(metadata)
    if source_url_file.stat().st_mode & 0o077:
        raise ValueError("private source URL file must not be group/world accessible")
    source_url = source_url_file.read_text().strip()
    source = urlsplit(source_url)
    if (
        source.scheme != "https"
        or source.hostname != "storage.googleapis.com"
        or not source.query
        or source.username
        or source.password
    ):
        raise ValueError("private source URL is not an authorized signed GCS URL")
    token = os.getenv("MUSIC_AI_WORKER_TOKEN", "")
    if not token:
        raise ValueError("music worker token is unavailable")
    health = fetch_health(metadata)
    if health.get("ready") is not True:
        raise ValueError("AnyAccomp live health is not ready for generation verification")
    body = canonical({
        "provider": "ANYACCOMP",
        "prompt": "",
        "vocalSource": {"url": source_url},
    }).encode()
    request = urllib.request.Request(
        f"{metadata['endpointOrigin']}/generate",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.build_opener(NoRedirect).open(request, timeout=1800) as response:
        if response.status != 200 or response.geturl() != request.full_url:
            raise RuntimeError("AnyAccomp generation did not return directly from Modal")
        result = json.loads(response.read(2 * 1024 * 1024))
    candidates = result.get("candidates")
    artifact = candidates[0].get("artifact") if isinstance(candidates, list) and candidates else None
    if not isinstance(artifact, dict):
        raise ValueError("AnyAccomp generation omitted its audio artifact")
    artifact_url = str(artifact.get("url", ""))
    parsed_artifact = urlsplit(artifact_url)
    if (
        origin(artifact_url.split("?", 1)[0]) != metadata["endpointOrigin"]
        or not parsed_artifact.query
        or "expires=" not in parsed_artifact.query
        or "capability=" not in parsed_artifact.query
    ):
        raise ValueError("AnyAccomp generation returned an untrusted artifact URL")
    with urllib.request.build_opener(NoRedirect).open(artifact_url, timeout=1800) as response:
        if response.status != 200 or response.geturl() != artifact_url:
            raise RuntimeError("AnyAccomp capability artifact was not directly retrievable")
        audio = response.read(128 * 1024 * 1024 + 1)
    if len(audio) > 128 * 1024 * 1024:
        raise ValueError("AnyAccomp artifact exceeds release verification limit")
    observed_sha = hashlib.sha256(audio).hexdigest()
    if observed_sha != artifact.get("sha256") or len(audio) != artifact.get("bytes"):
        raise ValueError("AnyAccomp artifact bytes differ from response metadata")
    with tempfile.NamedTemporaryFile(suffix=".wav") as handle:
        handle.write(audio)
        handle.flush()
        with wave.open(handle.name, "rb") as rendered:
            sample_rate = rendered.getframerate()
            channels = rendered.getnchannels()
            duration = rendered.getnframes() / sample_rate
    expected_result = {
        "provider": "ANYACCOMP",
        "modelVersion": health.get("modelVersion"),
        "checkpointSha256": health.get("checkpointSha256"),
        "revision": health.get("revision"),
        "modalImageId": health.get("modalImageId"),
        "sourceImageDigest": health.get("sourceImageDigest"),
        "cudaVersion": health.get("runtime", {}).get("cudaVersion"),
        "pytorchVersion": health.get("runtime", {}).get("pytorchVersion"),
        "gpu": health.get("runtime", {}).get("gpu"),
        "smokeTested": True,
    }
    if any(result.get(field) != expected for field, expected in expected_result.items()):
        raise ValueError("AnyAccomp generation provenance differs from live health")
    proof = {
        "schemaVersion": 1,
        "provider": "ANYACCOMP",
        "modalDeploymentId": metadata["modalDeploymentId"],
        "modalImageId": result["modalImageId"],
        "sourceImageDigest": result["sourceImageDigest"],
        "sourceFixtureSha256": json.loads(
            (EVIDENCE / "smoke-proof.json").read_text()
        )["input"]["sha256"],
        "outputSha256": observed_sha,
        "bytes": len(audio),
        "durationSeconds": duration,
        "sampleRate": sample_rate,
        "channels": channels,
        "artifactHashVerified": True,
        "capabilityRetrieved": True,
        "sourceOrigin": "https://storage.googleapis.com",
        "artifactOrigin": metadata["endpointOrigin"],
    }
    atomic_json(EVIDENCE / "live-generation-proof.json", proof)
    return proof


def source_build_digest() -> str:
    inventory = json.loads((EVIDENCE / "source-build-inventory.json").read_text())
    entries = []
    for retained in inventory["files"]:
        path = ROOT / retained["path"]
        observed = {"path": retained["path"], "bytes": path.stat().st_size, "sha256": digest(path)}
        if observed != retained:
            raise ValueError(f"AnyAccomp source-build input drifted: {retained['path']}")
        entries.append(observed)
    observed = hashlib.sha256(canonical(entries).encode()).hexdigest()
    if observed != inventory["sourceBuildSha256"]:
        raise ValueError("AnyAccomp source-build inventory digest mismatch")
    return f"sha256:{observed}"


def validate_release(value: object) -> dict:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("AnyAccomp release evidence is invalid")
    metadata = validate_metadata(value)
    health = value.get("liveHealth")
    smoke = value.get("smokeEvidence")
    if not isinstance(health, dict) or not isinstance(smoke, dict):
        raise ValueError("AnyAccomp release lacks health or smoke evidence")
    reviewed_license = {
        "sourceLicense": LICENSE_REVIEW["source"]["license"],
        "modelLicense": LICENSE_REVIEW["model"]["license"],
        "sourceCommercialUsePermitted": LICENSE_REVIEW["source"]["commercialUsePermitted"],
        "modelCommercialUsePermitted": LICENSE_REVIEW["model"]["commercialUsePermitted"],
        "commercialDeploymentAuthorized": LICENSE_REVIEW["decision"]["commercialDeploymentAuthorized"],
        "environmentValuesAreAuthorizationEvidence": LICENSE_REVIEW["decision"]["environmentValuesAreAuthorizationEvidence"],
        "requiredAttribution": LICENSE_REVIEW["decision"]["requiredAttribution"],
        "reviewSha256": digest(EVIDENCE / "license-review.json"),
    }
    if value.get("licenseStatus") != "COMMERCIAL" or value.get("licenseEvidence") != reviewed_license:
        raise ValueError("AnyAccomp release lacks the exact reviewed commercial license decision")
    exact = {
        "provider": "ANYACCOMP",
        "modelVersion": MANIFEST["model_version"],
        "checkpointSha256": MANIFEST["weights"]["checkpoint_set_sha256"],
        "revision": f"{MANIFEST['weights']['repository']}@{MANIFEST['weights']['revision']}",
        "sourceRevision": MANIFEST["source"]["revision"],
        "sourceImageDigest": source_build_digest(),
        "modalAppId": metadata["modalAppId"],
        "modalDeploymentId": metadata["modalDeploymentId"],
        "modalFunctionId": metadata["modalFunctionId"],
        "modalImageId": value.get("modalImageId"),
    }
    if any(health.get(key) != expected for key, expected in exact.items()):
        raise ValueError("AnyAccomp health identity does not match release evidence")
    if (
        health.get("status") != "ready"
        or health.get("ready") is not True
        or health.get("healthy") is not True
        or health.get("runtimeReady") is not True
        or health.get("checkpointReady") is not True
        or health.get("smokeTested") is not True
        or health.get("identityReady") is not True
        or health.get("artifactOriginReady") is not True
        or health.get("publicArtifactOrigin") != metadata["endpointOrigin"]
        or health.get("smokeEvidence") != smoke
    ):
        raise ValueError("AnyAccomp captured health is not fully ready")
    framework = health.get("framework", {})
    runtime = health.get("runtime", {})
    expected_runtime = {
        "python": runtime.get("pythonVersion"),
        "cudaImage": framework.get("cuda_image"),
        "cuda": framework.get("cuda"),
        "pytorch": framework.get("pytorch"),
        "torchvision": framework.get("torchvision"),
        "torchaudio": framework.get("torchaudio"),
        "torchIndexUrl": framework.get("torch_index_url"),
        "transformers": framework.get("transformers"),
        "accelerate": framework.get("accelerate"),
    }
    manifest_runtime = {
        "python": MANIFEST["runtime"]["python"],
        "cudaImage": MANIFEST["runtime"]["cuda_image"],
        "cuda": MANIFEST["runtime"]["cuda"],
        "pytorch": MANIFEST["runtime"]["pytorch"],
        "torchvision": MANIFEST["runtime"]["torchvision"],
        "torchaudio": MANIFEST["runtime"]["torchaudio"],
        "torchIndexUrl": MANIFEST["runtime"]["torch_index_url"],
        "transformers": MANIFEST["runtime"]["transformers"],
        "accelerate": MANIFEST["runtime"]["accelerate"],
    }
    if expected_runtime != manifest_runtime:
        raise ValueError("AnyAccomp live runtime differs from reviewed pins")
    retained = {
        "assetInventorySha256": digest(EVIDENCE / "asset-inventory.json"),
        "smokeProofSha256": digest(EVIDENCE / "smoke-proof.json"),
        "smokeOutputSha256": digest(EVIDENCE / "smoke-output.wav"),
        "licenseEvidenceSha256": digest(EVIDENCE / "license-review.json"),
        "sourceBuildInventorySha256": digest(EVIDENCE / "source-build-inventory.json"),
        "liveGenerationProofSha256": digest(EVIDENCE / "live-generation-proof.json"),
    }
    if value.get("retainedEvidence") != retained:
        raise ValueError("AnyAccomp retained evidence hash set drifted")
    if json.loads((EVIDENCE / "smoke-proof.json").read_text()) != smoke:
        raise ValueError("AnyAccomp retained smoke proof differs from live health")
    if digest(EVIDENCE / "smoke-output.wav") != smoke["output"]["sha256"]:
        raise ValueError("AnyAccomp retained smoke audio hash mismatch")
    generation = json.loads((EVIDENCE / "live-generation-proof.json").read_text())
    expected_generation = {
        "schemaVersion": 1,
        "provider": "ANYACCOMP",
        "modalDeploymentId": value["modalDeploymentId"],
        "modalImageId": value["modalImageId"],
        "sourceImageDigest": value["sourceImageDigest"],
        "sourceFixtureSha256": smoke["input"]["sha256"],
        "outputSha256": smoke["output"]["sha256"],
        "artifactHashVerified": True,
        "capabilityRetrieved": True,
        "sourceOrigin": "https://storage.googleapis.com",
        "artifactOrigin": value["endpointOrigin"],
    }
    if any(
        generation.get(field) != expected
        for field, expected in expected_generation.items()
    ):
        raise ValueError("AnyAccomp retained live generation proof is stale or invalid")
    if value["liveHealth"].get("sourceOriginsReady") is not True:
        raise ValueError("AnyAccomp live health did not attest source-origin readiness")
    if (
        value["liveHealth"].get("artifactOriginReady") is not True
        or value["liveHealth"].get("publicArtifactOrigin") != value["endpointOrigin"]
    ):
        raise ValueError("AnyAccomp live health did not attest its promoted artifact origin")
    return value


def capture(metadata: dict) -> dict:
    validate_metadata(metadata)
    health = None
    for attempt in range(30):
        try:
            candidate = fetch_health(metadata)
            if candidate.get("status") == "ready" and candidate.get("healthy") is True:
                health = candidate
                break
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        if attempt < 29:
            time.sleep(10)
    if health is None:
        raise RuntimeError("AnyAccomp authenticated health never became ready")
    final = observe()
    if final != metadata:
        raise ValueError("AnyAccomp Modal deployment identity changed during capture")
    value = {
        "schemaVersion": 1,
        **metadata,
        "modalImageId": health.get("modalImageId"),
        "checkpointSha256": health.get("checkpointSha256"),
        "checkpointRevision": health.get("revision"),
        "sourceRevision": health.get("sourceRevision"),
        "sourceImageDigest": health.get("sourceImageDigest"),
        "licenseStatus": "COMMERCIAL",
        "licenseEvidence": {
            "sourceLicense": LICENSE_REVIEW["source"]["license"],
            "modelLicense": LICENSE_REVIEW["model"]["license"],
            "sourceCommercialUsePermitted": LICENSE_REVIEW["source"]["commercialUsePermitted"],
            "modelCommercialUsePermitted": LICENSE_REVIEW["model"]["commercialUsePermitted"],
            "commercialDeploymentAuthorized": LICENSE_REVIEW["decision"]["commercialDeploymentAuthorized"],
            "environmentValuesAreAuthorizationEvidence": LICENSE_REVIEW["decision"]["environmentValuesAreAuthorizationEvidence"],
            "requiredAttribution": LICENSE_REVIEW["decision"]["requiredAttribution"],
            "reviewSha256": digest(EVIDENCE / "license-review.json"),
        },
        "retainedEvidence": {
            "assetInventorySha256": digest(EVIDENCE / "asset-inventory.json"),
            "smokeProofSha256": digest(EVIDENCE / "smoke-proof.json"),
            "smokeOutputSha256": digest(EVIDENCE / "smoke-output.wav"),
            "licenseEvidenceSha256": digest(EVIDENCE / "license-review.json"),
            "sourceBuildInventorySha256": digest(EVIDENCE / "source-build-inventory.json"),
            "liveGenerationProofSha256": digest(EVIDENCE / "live-generation-proof.json"),
        },
        "smokeEvidence": health.get("smokeEvidence"),
        "liveHealth": health,
    }
    return validate_release(value)


def private_key() -> tuple[Path, bool]:
    configured = os.getenv("MUSIC_GPU_PROMOTION_PRIVATE_KEY_FILE", "").strip()
    if configured:
        return Path(configured), False
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
    converted = subprocess.run(
        ["openssl", "pkey", "-inform", "DER", "-outform", "PEM"],
        input=ED25519_PKCS8_PREFIX + seed,
        capture_output=True,
        check=False,
    )
    if converted.returncode or not converted.stdout.startswith(b"-----BEGIN PRIVATE KEY-----"):
        raise RuntimeError("Ed25519 promotion key normalization failed")
    handle = tempfile.NamedTemporaryFile(mode="wb", delete=False)
    handle.write(converted.stdout)
    handle.close()
    os.chmod(handle.name, 0o600)
    return Path(handle.name), True


def sign(record: dict, key: Path) -> str:
    handle = tempfile.NamedTemporaryFile(mode="wb", delete=False)
    try:
        handle.write(canonical(record).encode())
        handle.close()
        os.chmod(handle.name, 0o600)
        result = subprocess.run(
            [
                "openssl", "pkeyutl", "-sign", "-rawin",
                "-inkey", str(key), "-in", handle.name,
            ],
            capture_output=True,
            check=False,
        )
    finally:
        Path(handle.name).unlink(missing_ok=True)
    if result.returncode or len(result.stdout) != 64:
        raise RuntimeError("AnyAccomp Ed25519 signing failed")
    return base64.b64encode(result.stdout).decode()


def public_key(key: Path) -> str:
    result = subprocess.run(
        ["openssl", "pkey", "-in", str(key), "-pubout"],
        capture_output=True,
        check=False,
    )
    if result.returncode or not result.stdout.startswith(b"-----BEGIN PUBLIC KEY-----"):
        raise RuntimeError("AnyAccomp public-key derivation failed")
    return result.stdout.decode()


def promote(release: dict) -> tuple[dict, str]:
    validate_release(release)
    health = release["liveHealth"]
    record = {
        "schemaVersion": 1,
        "provider": "ANYACCOMP",
        "modalAppId": release["modalAppId"],
        "modalDeploymentId": release["modalDeploymentId"],
        "modalFunctionId": release["modalFunctionId"],
        "modalImageId": release["modalImageId"],
        "endpointOrigin": release["endpointOrigin"],
        "modelVersion": MANIFEST["model_version"],
        "checkpointSha256": release["checkpointSha256"],
        "checkpointRevision": release["checkpointRevision"],
        "sourceRevision": release["sourceRevision"],
        "sourceImageDigest": release["sourceImageDigest"],
        "releaseEvidenceSha256": hashlib.sha256(canonical(release).encode()).hexdigest(),
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
        pem = public_key(key)
    finally:
        if temporary:
            key.unlink(missing_ok=True)
    return bundle, pem


def activate(bundle: dict, pem: str, release: dict) -> None:
    validate_release(release)
    if bundle.get("record", {}).get("releaseEvidenceSha256") != hashlib.sha256(
        canonical(release).encode()
    ).hexdigest():
        raise ValueError("AnyAccomp promotion does not bind retained release evidence")
    match = re.fullmatch(
        r"/\* Generated by the fail-closed generic Modal release workflow\. \*/\n"
        r"export const committedGpuPromotionsJson = (.+);\n",
        GENERATED.read_text(),
    )
    if not match:
        raise ValueError("canonical GPU promotions file is malformed")
    collection = json.loads(json.loads(match.group(1)))
    if collection.get("publicKey", "").strip() != pem.strip():
        raise ValueError("AnyAccomp signing key differs from canonical promotion key")
    collection["bundles"]["ANYACCOMP"] = bundle
    payload = canonical(collection)
    GENERATED.write_text(
        "/* Generated by the fail-closed generic Modal release workflow. */\n"
        f"export const committedGpuPromotionsJson = {json.dumps(payload)};\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("observe")
    install = commands.add_parser("install-identity")
    install.add_argument("--metadata", type=Path, required=True)
    capture_command = commands.add_parser("capture")
    capture_command.add_argument("--metadata", type=Path, required=True)
    generation = commands.add_parser("verify-generation")
    generation.add_argument("--metadata", type=Path, required=True)
    generation.add_argument("--source-url-file", type=Path, required=True)
    commands.add_parser("promote")
    commands.add_parser("activate")
    args = parser.parse_args()
    if args.command == "observe":
        atomic_json(EVIDENCE / "observed-deployment.json", observe())
    elif args.command == "install-identity":
        install_identity(json.loads(args.metadata.read_text()))
    elif args.command == "capture":
        atomic_json(
            EVIDENCE / "release-evidence.json",
            capture(json.loads(args.metadata.read_text())),
        )
    elif args.command == "verify-generation":
        verify_generation(
            json.loads(args.metadata.read_text()),
            args.source_url_file,
        )
    elif args.command == "promote":
        release = json.loads((EVIDENCE / "release-evidence.json").read_text())
        bundle, pem = promote(release)
        atomic_json(EVIDENCE / "promotion-bundle.json", bundle)
        (EVIDENCE / "promotion-public-key.pem").write_text(pem)
    else:
        release = json.loads((EVIDENCE / "release-evidence.json").read_text())
        bundle = json.loads((EVIDENCE / "promotion-bundle.json").read_text())
        pem = (EVIDENCE / "promotion-public-key.pem").read_text()
        activate(bundle, pem, release)


if __name__ == "__main__":
    main()