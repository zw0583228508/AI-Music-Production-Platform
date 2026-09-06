"""Observe, rotate, and verify a Beat This Modal release without manual IDs."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import modal

import promote_modal

APP_NAME = "beat-this-worker"
IDENTITY_SECRET_NAME = "beat-this-deployment-identity-v1"
SMOKE_FUNCTION = "smoke_real_audio"
ENDPOINT_CLASS = "BeatThisWorker"
ENDPOINT_METHOD = "endpoint"
ROOT = Path(__file__).resolve().parent


def command_json(*args: str) -> object:
    result = subprocess.run(
        ["uv", "run", "modal", *args],
        cwd=ROOT.parents[1],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Modal metadata command failed: {' '.join(args[:2])}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Modal metadata command did not return JSON") from exc


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as temporary:
        json.dump(value, temporary, sort_keys=True, separators=(",", ":"))
        temporary.write("\n")
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, path)


def deployed_app_id(apps: object) -> str:
    if not isinstance(apps, list):
        raise ValueError("Modal app list must be an array")
    matches = [
        item.get("app_id")
        for item in apps
        if isinstance(item, dict)
        and item.get("description") == APP_NAME
        and item.get("state") == "deployed"
    ]
    if len(matches) != 1 or not re.fullmatch(r"ap-[A-Za-z0-9]+", str(matches[0])):
        raise ValueError("expected exactly one authentic deployed Beat This app")
    return str(matches[0])


def deployed_version(history: object) -> str:
    if not isinstance(history, list) or not history or not isinstance(history[0], dict):
        raise ValueError("Modal deployment history is empty")
    version = history[0].get("version")
    if not isinstance(version, str) or not re.fullmatch(r"v[1-9][0-9]*", version):
        raise ValueError("latest Modal deployment version is invalid")
    return version


def capture_metadata() -> dict:
    app_id = deployed_app_id(command_json("app", "list", "--json"))
    deployment_id = deployed_version(
        command_json("app", "history", app_id, "--json")
    )
    endpoint = modal.Cls.from_name(APP_NAME, ENDPOINT_CLASS)().endpoint
    endpoint.hydrate()
    function_id = endpoint.object_id
    endpoint_origin = promote_modal.origin(endpoint.get_web_url())
    metadata = {
        "modalAppId": app_id,
        "modalDeploymentId": deployment_id,
        "modalFunctionId": function_id,
        "endpointOrigin": endpoint_origin,
    }
    validate_metadata(metadata)
    return metadata


def validate_metadata(metadata: object) -> None:
    if not isinstance(metadata, dict):
        raise ValueError("Modal release metadata must be an object")
    patterns = {
        "modalAppId": r"ap-[A-Za-z0-9]+",
        "modalDeploymentId": r"v[1-9][0-9]*",
        "modalFunctionId": r"fu-[A-Za-z0-9]+",
    }
    for field, pattern in patterns.items():
        if not re.fullmatch(pattern, str(metadata.get(field, ""))):
            raise ValueError(f"Modal release metadata has invalid {field}")
    promote_modal.origin(str(metadata.get("endpointOrigin", "")))


def identity(metadata: dict) -> dict:
    validate_metadata(metadata)
    return {
        "BEAT_THIS_MODAL_APP_ID": metadata["modalAppId"],
        "BEAT_THIS_MODAL_DEPLOYMENT_ID": metadata["modalDeploymentId"],
        "BEAT_THIS_MODAL_FUNCTION_ID": metadata["modalFunctionId"],
    }


def capture_release(expected_identity: dict) -> dict:
    metadata = capture_metadata()
    actual_identity = identity(metadata)
    if actual_identity != expected_identity:
        raise ValueError(
            "final Modal deployment identity does not match the prepared identity"
        )
    smoke = modal.Function.from_name(APP_NAME, SMOKE_FUNCTION)
    smoke_evidence = smoke.remote()
    evidence = {
        "schemaVersion": 1,
        "provider": "BEAT_THIS",
        **metadata,
        "modalImageId": smoke_evidence.get("modalImageId")
            if isinstance(smoke_evidence, dict) else None,
        "sourceRevision": smoke_evidence.get("sourceRevision")
            if isinstance(smoke_evidence, dict) else None,
        "sourceImageDigest": smoke_evidence.get("sourceImageDigest")
            if isinstance(smoke_evidence, dict) else None,
        "smokeEvidence": smoke_evidence.get("proof")
            if isinstance(smoke_evidence, dict) else None,
    }
    validate_release_evidence(evidence)
    return evidence


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
    promote_modal.origin(str(evidence.get("endpointOrigin", "")))
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


def running_container_ids(app_id: str) -> list[str]:
    containers = command_json("container", "list", "--app-id", app_id, "--json")
    if not isinstance(containers, list):
        raise ValueError("Modal container list must be an array")
    result = []
    for container in containers:
        if (
            not isinstance(container, dict)
            or container.get("app_id") != app_id
            or not re.fullmatch(
                r"ta-[A-Za-z0-9]+", str(container.get("container_id", ""))
            )
        ):
            raise ValueError("Modal returned invalid container metadata")
        result.append(container["container_id"])
    return result


def install_identity(
    metadata: dict,
    identity_path: Path,
    refresh_output: Path,
) -> dict:
    prepared = identity(metadata)
    atomic_json(identity_path, prepared)
    subprocess.run(
        [
            "uv", "run", "modal", "secret", "create", IDENTITY_SECRET_NAME,
            "--from-json", str(identity_path), "--force",
        ],
        cwd=ROOT.parents[1],
        check=True,
    )
    previous_containers = running_container_ids(metadata["modalAppId"])
    for container_id in previous_containers:
        subprocess.run(
            [
                "uv", "run", "modal", "container", "stop", container_id,
                "--graceful", "--yes",
            ],
            cwd=ROOT.parents[1],
            check=True,
        )
    remaining = set(running_container_ids(metadata["modalAppId"]))
    stale = remaining.intersection(previous_containers)
    if stale:
        raise RuntimeError("old Beat This containers remained after identity rotation")
    atomic_json(refresh_output, {
        "schemaVersion": 1,
        "provider": "BEAT_THIS",
        "modalAppId": metadata["modalAppId"],
        "modalDeploymentId": metadata["modalDeploymentId"],
        "stoppedContainerIds": previous_containers,
        "staleContainerIds": [],
    })
    return prepared


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_health(endpoint_origin: str, token: str) -> dict:
    origin = promote_modal.origin(endpoint_origin)
    url = f"{origin}/health?{urlencode({'provider': 'BEAT_THIS'})}"
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(request, timeout=30) as response:
        if response.status != 200 or response.geturl() != url:
            raise RuntimeError("Beat This health did not return directly from its origin")
        if urlsplit(response.geturl()).hostname != urlsplit(origin).hostname:
            raise RuntimeError("Beat This health escaped the observed Modal origin")
        return json.loads(response.read())


def verified_health(evidence: dict, token: str, attempts: int = 30) -> dict:
    validate_release_evidence(evidence)
    expected = {
        "provider": "BEAT_THIS",
        "modalAppId": evidence["modalAppId"],
        "modalDeploymentId": evidence["modalDeploymentId"],
        "modalFunctionId": evidence["modalFunctionId"],
        "modalImageId": evidence["modalImageId"],
        "modelVersion": promote_modal.MANIFEST["version"],
        "checkpointSha256": promote_modal.MANIFEST["checkpointSha256"],
        "checkpointRevision": promote_modal.MANIFEST["sourceCommit"],
        "sourceRevision": evidence["sourceRevision"],
        "sourceImageDigest": evidence["sourceImageDigest"],
        "runtime": {
            key: promote_modal.MANIFEST["runtime"][key]
            for key in promote_modal.RUNTIME_KEYS
        },
    }
    final_health: dict | None = None

    def fetch_health() -> dict:
        nonlocal final_health
        final_health = read_health(evidence["endpointOrigin"], token)
        return final_health

    promote_modal.verify_live_health_with_retries(
        fetch_health,
        expected,
        attempts=attempts,
        delay_seconds=10,
    )
    if final_health is None:
        raise RuntimeError("final Beat This health was not observed")
    return final_health


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    observe = commands.add_parser("observe")
    observe.add_argument("--output", required=True)
    capture = commands.add_parser("capture")
    capture.add_argument("--output", required=True)
    capture.add_argument("--expected-identity", required=True)
    rotate = commands.add_parser("install-identity")
    rotate.add_argument("--metadata", required=True)
    rotate.add_argument("--identity-output", required=True)
    rotate.add_argument("--refresh-output", required=True)
    health = commands.add_parser("verify-health")
    health.add_argument("--evidence", required=True)
    health.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.command == "observe":
        atomic_json(Path(args.output), capture_metadata())
    elif args.command == "capture":
        expected = json.loads(Path(args.expected_identity).read_text())
        atomic_json(Path(args.output), capture_release(expected))
    elif args.command == "install-identity":
        metadata = json.loads(Path(args.metadata).read_text())
        install_identity(
            metadata,
            Path(args.identity_output),
            Path(args.refresh_output),
        )
    else:
        token = (
            os.getenv("BEAT_THIS_WORKER_TOKEN")
            or os.getenv("MUSIC_AI_WORKER_TOKEN")
            or ""
        ).strip()
        if not token:
            raise ValueError("Beat This worker token is unavailable")
        evidence = json.loads(Path(args.evidence).read_text())
        atomic_json(Path(args.output), verified_health(evidence, token))


if __name__ == "__main__":
    main()