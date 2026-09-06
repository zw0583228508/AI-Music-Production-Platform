"""Observe, refresh, and attest any configured Modal music provider."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import modal

from modal_config import (
    DEPLOYMENTS,
    MANIFEST,
    canonical_promotion_record,
    promotion_secret_name,
    provider_app_name,
)
from runners.common import validate_mt3_note_output

ROOT = Path(__file__).resolve().parent
APP_CLASSES = {
    "ACE_STEP": (provider_app_name("ACE_STEP"), "AceStepWorker"),
    "BS_ROFORMER": (provider_app_name("BS_ROFORMER"), "BSRoFormerWorker"),
    "MT3": (provider_app_name("MT3"), "MT3Worker"),
    "ALL_IN_ONE": (provider_app_name("ALL_IN_ONE"), "AllInOneWorker"),
    "MR_MT3": (provider_app_name("MR_MT3"), "MrMt3Worker"),
    "YOUR_MT3": (provider_app_name("YOUR_MT3"), "YourMt3Worker"),
}


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as handle:
        json.dump(value, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, path)


def command_json(*args: str) -> object:
    result = subprocess.run(
        ["uv", "run", "modal", *args], cwd=ROOT.parents[1],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Modal metadata command failed: {' '.join(args[:2])}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Modal metadata command did not return JSON") from exc


def _origin(value: str) -> str:
    parsed = urlsplit(value.strip())
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("Modal endpoint is not an HTTPS origin")
    return f"https://{parsed.hostname.lower()}" + (
        f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    )


def deployed_app_id(apps: object, app_name: str) -> str:
    if not isinstance(apps, list):
        raise ValueError("Modal app list must be an array")
    matches = [
        item.get("app_id") for item in apps
        if isinstance(item, dict) and item.get("description") == app_name
        and item.get("state") == "deployed"
    ]
    if len(matches) != 1 or not re.fullmatch(r"ap-[A-Za-z0-9]+", str(matches[0])):
        raise ValueError("expected exactly one authentic deployed Modal app")
    return str(matches[0])


def deployed_version(history: object) -> str:
    if not isinstance(history, list) or not history or not isinstance(history[0], dict):
        raise ValueError("Modal deployment history is empty")
    version = str(history[0].get("version", ""))
    if not re.fullmatch(r"v[1-9][0-9]*", version):
        raise ValueError("latest Modal deployment version is invalid")
    return version


def capture_metadata(provider: str) -> dict:
    app_name, class_name = APP_CLASSES[provider]
    app_id = deployed_app_id(command_json("app", "list", "--json"), app_name)
    deployment_id = deployed_version(command_json("app", "history", app_id, "--json"))
    endpoint = modal.Cls.from_name(app_name, class_name)().endpoint
    endpoint.hydrate()
    metadata = {
        "provider": provider,
        "modalAppId": app_id,
        "modalDeploymentId": deployment_id,
        "modalFunctionId": endpoint.object_id,
        "endpointOrigin": _origin(endpoint.get_web_url()),
    }
    validate_metadata(metadata, provider)
    return metadata


def validate_metadata(value: object, provider: str) -> None:
    if not isinstance(value, dict) or value.get("provider") != provider:
        raise ValueError("Modal metadata provider mismatch")
    for field, pattern in {
        "modalAppId": r"ap-[A-Za-z0-9]+",
        "modalDeploymentId": r"v[1-9][0-9]*",
        "modalFunctionId": r"fu-[A-Za-z0-9]+",
    }.items():
        if not re.fullmatch(pattern, str(value.get(field, ""))):
            raise ValueError(f"Modal metadata has invalid {field}")
    _origin(str(value.get("endpointOrigin", "")))


def identity(metadata: dict) -> dict[str, str]:
    return {
        "MUSIC_GPU_MODAL_APP_ID": metadata["modalAppId"],
        "MUSIC_GPU_MODAL_DEPLOYMENT_ID": metadata["modalDeploymentId"],
        "MUSIC_GPU_MODAL_FUNCTION_ID": metadata["modalFunctionId"],
    }


def running_container_ids(app_id: str) -> list[str]:
    containers = command_json("container", "list", "--app-id", app_id, "--json")
    if not isinstance(containers, list):
        raise ValueError("Modal container list must be an array")
    result = []
    for item in containers:
        if (not isinstance(item, dict) or item.get("app_id") != app_id
                or not re.fullmatch(r"ta-[A-Za-z0-9]+", str(item.get("container_id", "")))):
            raise ValueError("Modal returned invalid container metadata")
        result.append(item["container_id"])
    return result


def install_identity(metadata: dict, identity_path: Path, refresh_path: Path) -> None:
    provider = str(metadata.get("provider", ""))
    validate_metadata(metadata, provider)
    prepared = identity(metadata)
    atomic_json(identity_path, prepared)
    subprocess.run([
        "uv", "run", "modal", "secret", "create", promotion_secret_name(provider),
        "--from-json", str(identity_path), "--force",
    ], cwd=ROOT.parents[1], check=True)
    previous = running_container_ids(metadata["modalAppId"])
    for container_id in previous:
        subprocess.run([
            "uv", "run", "modal", "container", "stop", container_id,
            "--graceful", "--yes",
        ], cwd=ROOT.parents[1], check=True)
    stale = sorted(set(previous) & set(running_container_ids(metadata["modalAppId"])))
    if stale:
        raise RuntimeError("old provider containers remained after identity rotation")
    atomic_json(refresh_path, {
        "schemaVersion": 1, "provider": provider,
        "modalAppId": metadata["modalAppId"],
        "modalDeploymentId": metadata["modalDeploymentId"],
        "stoppedContainerIds": previous, "staleContainerIds": stale,
    })


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_health(metadata: dict, token: str) -> dict:
    origin = _origin(metadata["endpointOrigin"])
    url = f"{origin}/health?{urlencode({'provider': metadata['provider'], 'forceSmoke': 'true'})}"
    request = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.build_opener(NoRedirect).open(request, timeout=1800) as response:
        if response.status != 200 or response.geturl() != url:
            raise RuntimeError("provider health did not return directly from Modal origin")
        return json.loads(response.read())


def retain_smoke_artifact(health: dict, metadata: dict, output: Path) -> None:
    descriptor = health.get("smokeEvidence", {}).get("output", {}).get("artifact", {})
    url = str(descriptor.get("url", ""))
    if not url.startswith(f"{_origin(metadata['endpointOrigin'])}/artifacts/"):
        raise ValueError("smoke artifact capability is missing or targets another origin")
    request = urllib.request.Request(url, headers={"Accept": "audio/wav"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=300) as response:
        if response.status != 200 or response.geturl() != url:
            raise RuntimeError("smoke artifact did not return directly from Modal origin")
        content = response.read(32 * 1024 * 1024 + 1)
    expected_bytes = descriptor.get("bytes")
    expected_sha = str(descriptor.get("sha256", "")).lower()
    if (
        not isinstance(expected_bytes, int)
        or len(content) != expected_bytes
        or len(content) > 32 * 1024 * 1024
        or hashlib.sha256(content).hexdigest() != expected_sha
    ):
        raise ValueError("retained smoke artifact does not match its live descriptor")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(content)
    descriptor["retainedEvidenceFile"] = output.name
    for field in ("url", "capability", "expiresAt"):
        descriptor.pop(field, None)


def _valid_audio_descriptor(value: object) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("bytes"), int) and value["bytes"] > 44
        and isinstance(value.get("sampleRate"), int) and value["sampleRate"] > 0
        and isinstance(value.get("channels"), int) and value["channels"] > 0
        and isinstance(value.get("durationSeconds"), (int, float))
        and math.isfinite(value["durationSeconds"]) and value["durationSeconds"] > 0
        and isinstance(value.get("peakAmplitude"), (int, float))
        and math.isfinite(value["peakAmplitude"]) and value["peakAmplitude"] >= 1e-5
        and isinstance(value.get("rmsAmplitude"), (int, float))
        and math.isfinite(value["rmsAmplitude"]) and value["rmsAmplitude"] >= 1e-7
        and re.fullmatch(r"[a-f0-9]{64}", str(value.get("sha256", ""))) is not None
    )


def validate_bs_roformer_output(output: object) -> None:
    if not isinstance(output, dict) or output.get("stemCount") != 2:
        raise ValueError("BS-RoFormer retained stem evidence count is invalid")
    source = output.get("input")
    stems = output.get("stems")
    if (
        not _valid_audio_descriptor(source)
        or not isinstance(stems, list)
        or len(stems) != 2
        or not all(_valid_audio_descriptor(stem) for stem in stems)
        or {stem.get("stem") for stem in stems} != {"vocals", "instrumental"}
        or output.get("allStemsNonSilent") is not True
        or output.get("distinctStemSha256") is not True
    ):
        raise ValueError("BS-RoFormer retained audio evidence is incomplete")
    hashes = {stem["sha256"] for stem in stems}
    if len(hashes) != 2 or source["sha256"] in hashes:
        raise ValueError("BS-RoFormer retained stems are not distinct")
    if any(
        abs(stem["durationSeconds"] - source["durationSeconds"]) > 0.25
        for stem in stems
    ):
        raise ValueError("BS-RoFormer retained stem duration does not match input")


def validate_evidence(value: object, provider: str) -> None:
    validate_metadata(value, provider)
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("release evidence schema is invalid")
    for field, pattern in {
        "modalImageId": r"im-[A-Za-z0-9]+",
        "checkpointSha256": r"[a-f0-9]{64}",
        "sourceImageDigest": r"sha256:[a-f0-9]{64}",
        "sourceRevision": r"[a-f0-9]{40}",
    }.items():
        if not re.fullmatch(pattern, str(value.get(field, "")).lower()):
            raise ValueError(f"release evidence has invalid {field}")
    proof = value.get("smokeEvidence")
    provenance = (
        proof.get("provenance")
        if isinstance(proof, dict) and isinstance(proof.get("provenance"), dict)
        else proof
    )
    if (not isinstance(proof, dict) or proof.get("provider") != provider
            or proof.get("smokeTested") is not True or not proof.get("output")
            or str(proof.get("checkpointSha256", "")).lower()
            != value["checkpointSha256"]):
        raise ValueError("real provider smoke evidence is incomplete")
    if provider in {"MT3", "YOUR_MT3"}:
        validate_mt3_note_output(proof["output"])
    if provider == "BS_ROFORMER":
        validate_bs_roformer_output(proof["output"])
        details = MANIFEST["providers"][provider]
        if (
            proof.get("configSha256") != details["config_sha256"]
            or proof.get("backendVersion") != details["backend_package_version"]
            or proof.get("backendPackageArtifactSha256")
            != details["backend_package_artifact_sha256"]
            or not re.fullmatch(
                r"[a-f0-9]{64}",
                str(proof.get("backendPackageTreeSha256", "")),
            )
        ):
            raise ValueError("BS-RoFormer config or backend evidence is invalid")
    expected_provenance = {
        "checkpointSha256": value["checkpointSha256"],
        "modalImageId": value["modalImageId"],
        "sourceImageDigest": value["sourceImageDigest"],
    }
    if not isinstance(provenance, dict) or any(
        str(provenance.get(field, "")).lower() != expected.lower()
        for field, expected in expected_provenance.items()
    ):
        raise ValueError("real provider smoke provenance does not match release identity")
    if value["sourceImageDigest"].lower() != DEPLOYMENTS[provider].source_image_digest:
        raise ValueError("release evidence source image does not match deployment identity")
    expected_source_revision = os.getenv("MUSIC_GPU_SOURCE_REVISION", "").strip()
    if expected_source_revision and value["sourceRevision"] != expected_source_revision:
        raise ValueError("release evidence source revision does not match CI release revision")


def capture(
    provider: str, expected: dict, token: str, attempts: int = 30,
    smoke_artifact_output: Path | None = None,
) -> dict:
    metadata = capture_metadata(provider)
    if identity(metadata) != expected:
        raise ValueError("final Modal identity does not match refreshed identity")
    health = None
    for attempt in range(attempts):
        try:
            candidate = read_health(metadata, token)
            if candidate.get("status") == "ready" and candidate.get("healthy") is True:
                health = candidate
                break
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        if attempt + 1 < attempts:
            time.sleep(10)
    if health is None:
        raise RuntimeError("authenticated provider health never became ready")
    if smoke_artifact_output is not None:
        retain_smoke_artifact(health, metadata, smoke_artifact_output)
    final_metadata = capture_metadata(provider)
    if final_metadata != metadata:
        raise ValueError("Modal deployment identity changed during release capture")
    expected_source_revision = os.getenv("MUSIC_GPU_SOURCE_REVISION", "").strip()
    if not expected_source_revision or health.get("sourceRevision") != expected_source_revision:
        raise ValueError("observed source revision does not match CI release revision")
    evidence = {
        "schemaVersion": 1, **metadata,
        "modalImageId": health.get("modalImageId"),
        "checkpointSha256": str(health.get("checkpointSha256", "")).lower(),
        "sourceImageDigest": str(health.get("sourceImageDigest", "")).lower(),
        "sourceRevision": health.get("sourceRevision"),
        "smokeEvidence": health.get("smokeEvidence"),
        "liveHealth": health,
    }
    validate_evidence(evidence, provider)
    return evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, choices=sorted(DEPLOYMENTS))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("observe").add_argument("--output", required=True)
    rotate = commands.add_parser("install-identity")
    rotate.add_argument("--metadata", required=True)
    rotate.add_argument("--identity-output", required=True)
    rotate.add_argument("--refresh-output", required=True)
    capture_parser = commands.add_parser("capture")
    capture_parser.add_argument("--expected-identity", required=True)
    capture_parser.add_argument("--output", required=True)
    capture_parser.add_argument("--health-output")
    capture_parser.add_argument("--smoke-artifact-output")
    args = parser.parse_args()
    if args.command == "observe":
        atomic_json(Path(args.output), capture_metadata(args.provider))
    elif args.command == "install-identity":
        install_identity(
            json.loads(Path(args.metadata).read_text()),
            Path(args.identity_output), Path(args.refresh_output),
        )
    else:
        token = os.getenv("MUSIC_AI_WORKER_TOKEN", "").strip()
        if not token:
            raise ValueError("music worker token is unavailable")
        expected = json.loads(Path(args.expected_identity).read_text())
        if args.provider == "ACE_STEP" and not args.smoke_artifact_output:
            raise ValueError("ACE_STEP capture requires retained smoke artifact output")
        evidence = capture(
            args.provider, expected, token,
            smoke_artifact_output=(
                Path(args.smoke_artifact_output)
                if args.smoke_artifact_output else None
            ),
        )
        atomic_json(Path(args.output), evidence)
        if args.health_output:
            atomic_json(Path(args.health_output), evidence["liveHealth"])


if __name__ == "__main__":
    main()