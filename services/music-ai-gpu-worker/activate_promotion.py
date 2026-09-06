"""Fail closed before atomically updating a canonical generic promotion."""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import tempfile
import hashlib
from pathlib import Path

from modal_config import DEPLOYMENTS, canonical_promotion_record
from release_modal import validate_evidence


def evidence_sha256(evidence: dict) -> str:
    """Hash the exact canonical evidence retained by CI, never a summary."""
    return hashlib.sha256(canonical_promotion_record(evidence).encode()).hexdigest()


def verify_signature(record: dict, signature: str, public_key: str) -> None:
    try:
        raw = base64.b64decode(signature, validate=True)
    except ValueError as exc:
        raise ValueError("promotion signature is not base64") from exc
    if len(raw) != 64:
        raise ValueError("promotion signature is not Ed25519")
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "record").write_text(canonical_promotion_record(record))
        (root / "signature").write_bytes(raw)
        (root / "public.pem").write_text(public_key)
        result = subprocess.run([
            "openssl", "pkeyutl", "-verify", "-pubin",
            "-inkey", str(root / "public.pem"), "-rawin",
            "-in", str(root / "record"), "-sigfile", str(root / "signature"),
        ], capture_output=True, check=False)
    if result.returncode:
        raise ValueError("promotion signature does not match public key")


def validate(
    bundle: object,
    public_key: str,
    evidence: dict,
    refresh: object,
    health: object | None = None,
) -> dict:
    provider = str(evidence.get("provider", ""))
    if provider not in DEPLOYMENTS:
        raise ValueError("unknown promotion provider")
    validate_evidence(evidence, provider)
    if (not isinstance(refresh, dict) or refresh.get("schemaVersion") != 1
            or refresh.get("provider") != provider
            or refresh.get("modalAppId") != evidence["modalAppId"]
            or refresh.get("modalDeploymentId") != evidence["modalDeploymentId"]
            or not isinstance(refresh.get("stoppedContainerIds"), list)
            or refresh.get("staleContainerIds") != []):
        raise ValueError("container refresh proof does not match release evidence")
    if not isinstance(bundle, dict) or set(bundle) != {"record", "signature"}:
        raise ValueError("promotion bundle must contain exactly record and signature")
    record, signature = bundle["record"], bundle["signature"]
    if not isinstance(record, dict) or not isinstance(signature, str):
        raise ValueError("promotion bundle fields are invalid")
    fields = (
        "provider", "modalAppId", "modalDeploymentId", "modalFunctionId",
        "modalImageId", "endpointOrigin", "checkpointSha256", "sourceRevision",
        "sourceImageDigest",
    )
    if any(record.get(field) != evidence.get(field) for field in fields):
        raise ValueError("promotion record does not match captured release evidence")
    retained_evidence_hash = evidence_sha256(evidence)
    if record.get("releaseEvidenceSha256") != retained_evidence_hash:
        raise ValueError("promotion record does not bind exact retained release evidence")
    captured_health = evidence["liveHealth"]
    if health is not None and health != captured_health:
        raise ValueError("retained live health does not match release evidence")
    health = captured_health
    if (not isinstance(health, dict) or health.get("status") != "ready"
            or health.get("healthy") is not True or health.get("smokeTested") is not True):
        raise ValueError("captured live health is not ready")
    health_fields = {
        "provider": record["provider"], "modalAppId": record["modalAppId"],
        "modalDeploymentId": record["modalDeploymentId"],
        "modalFunctionId": record["modalFunctionId"],
        "modalImageId": record["modalImageId"], "modelVersion": record["modelVersion"],
        "checkpointSha256": record["checkpointSha256"],
        "revision": record["checkpointRevision"],
        "sourceRevision": record["sourceRevision"],
        "sourceImageDigest": record["sourceImageDigest"],
    }
    if any(health.get(key) != value for key, value in health_fields.items()):
        raise ValueError("live health does not match signed promotion")
    runtime = health.get("runtime", {})
    framework = health.get("framework", {})
    expected_runtime = record.get("runtime", {})
    runtime_fields = {
        "python": runtime.get("pythonVersion"),
        "cudaImage": framework.get("cuda_image"), "cuda": framework.get("cuda"),
        "pytorch": framework.get("pytorch"), "torchvision": framework.get("torchvision"),
        "torchaudio": framework.get("torchaudio"),
        "torchIndexUrl": framework.get("torch_index_url"),
        "transformers": framework.get("transformers"),
        "accelerate": framework.get("accelerate"),
    }
    if runtime_fields != expected_runtime:
        raise ValueError("live health runtime pins do not match signed promotion")
    verify_signature(record, signature, public_key)
    return record


def read_canonical(path: Path) -> dict:
    if not path.exists():
        return {"schemaVersion": 1, "publicKey": "", "bundles": {}}
    match = re.fullmatch(
        r"/\* Generated by the fail-closed generic Modal release workflow\. \*/\n"
        r"export const committedGpuPromotionsJson = (.+);\n",
        path.read_text(),
    )
    if not match:
        raise ValueError("existing canonical promotion file is malformed")
    encoded = json.loads(match.group(1))
    value = json.loads(encoded)
    if (not isinstance(value, dict) or value.get("schemaVersion") != 1
            or not isinstance(value.get("bundles"), dict)):
        raise ValueError("existing canonical promotions are malformed")
    return value


def write_canonical(canonical: dict, output: Path) -> None:
    """Atomically write a validated canonical promotion collection."""
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    generated = (
        "/* Generated by the fail-closed generic Modal release workflow. */\n"
        f"export const committedGpuPromotionsJson = {json.dumps(payload)};\n"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=output.parent, prefix=f".{output.name}.", delete=False
    ) as handle:
        handle.write(generated)
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, output)


def activate(
    bundle: dict,
    public_key: str,
    evidence: dict,
    refresh: dict,
    health: dict,
    output: Path,
) -> None:
    record = validate(bundle, public_key, evidence, refresh, health)
    canonical = read_canonical(output)
    old_key = str(canonical.get("publicKey", "")).strip()
    if old_key and old_key != public_key.strip():
        raise ValueError("public key rotation would invalidate prior provider promotions")
    canonical["publicKey"] = public_key.strip() + "\n"
    canonical["bundles"][record["provider"]] = bundle
    write_canonical(canonical, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("bundle", "public-key", "evidence", "refresh", "health", "output"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    activate(
        json.loads(Path(args.bundle).read_text()),
        Path(args.public_key).read_text(),
        json.loads(Path(args.evidence).read_text()),
        json.loads(Path(args.refresh).read_text()),
        json.loads(Path(args.health).read_text()),
        Path(args.output),
    )


if __name__ == "__main__":
    main()