"""Create the signed, atomically rotated promotion bundle for a Modal worker.

Deployment CI should call this only after it has observed the IDs returned by
Modal for the exact deployment. The signing key is read from the CI
environment and is never copied into the worker environment.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from modal_config import (
    DEPLOYMENTS,
    build_promotion_record,
    write_promotion_bundle,
    write_worker_identity,
)


PROMOTED_PROVIDERS = {"ACE_STEP", "BS_ROFORMER", "MT3", "ALL_IN_ONE"}


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _origin(value: str) -> str:
    parsed = urlparse(value)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("endpoint origin is invalid") from exc
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("endpoint origin must be a credential-free HTTPS origin")
    if parsed.path not in {"", "/"} or parsed.params or parsed.query or parsed.fragment:
        raise ValueError("endpoint origin must not contain a path, query, or fragment")
    return (
        f"https://{parsed.hostname.lower()}"
        + (f":{port}" if port and port != 443 else "")
    )


def trusted_endpoint_origin(endpoint_origin: str, trusted_origin: str) -> str:
    candidate = _origin(endpoint_origin)
    if not trusted_origin or candidate != _origin(trusted_origin):
        raise ValueError("endpoint does not match the trusted provider deployment origin")
    return candidate


def fetch_authenticated_health(endpoint_origin: str, provider: str, token: str) -> object:
    trusted = os.getenv(f"MUSIC_GPU_TRUSTED_ENDPOINT_ORIGIN_{provider}", "")
    endpoint = trusted_endpoint_origin(endpoint_origin, trusted)
    if provider not in PROMOTED_PROVIDERS:
        raise ValueError("provider does not use this release health contract")
    if not token:
        raise ValueError("GPU worker token is unavailable")
    request = Request(
        f"{endpoint}/health?provider={provider}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with build_opener(NoRedirects).open(request, timeout=30) as response:
            if response.geturl().split("?", 1)[0] != f"{endpoint}/health":
                raise ValueError("authenticated health redirected unexpectedly")
            return json.loads(response.read(1024 * 1024))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError("authenticated live health request failed") from exc


def _verify_live_identity(payload: object, expected: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("authenticated live health returned an invalid payload")
    exact = {
        "provider": expected["provider"],
        "modelVersion": expected["modelVersion"],
        "checkpointSha256": expected["checkpointSha256"],
        "revision": expected["checkpointRevision"],
        "modalAppId": expected["modalAppId"],
        "modalDeploymentId": expected["modalDeploymentId"],
        "modalFunctionId": expected["modalFunctionId"],
        "modalImageId": expected["modalImageId"],
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
    checked = _verify_live_identity(payload, expected)
    if (
        checked.get("status") != "ready"
        or checked.get("ready") is not True
        or checked.get("healthy") is not True
        or checked.get("retryable") is not False
        or checked.get("runtimeReady") is not True
    ):
        raise ValueError("authenticated live health is not ready")


def verify_live_health_with_retries(fetch_health, expected: dict, attempts: int = 6) -> None:
    """Retry only the exact authenticated startup contract for this provider."""
    if attempts < 1:
        raise ValueError("health verification attempts must be positive")
    for attempt in range(attempts):
        payload = _verify_live_identity(fetch_health(), expected)
        startup = (
            payload.get("status") == "starting"
            and payload.get("ready") is False
            and payload.get("healthy") is False
            and payload.get("retryable") is True
            and payload.get("retryAfterSeconds") == 5
        )
        if startup:
            if attempt + 1 == attempts:
                raise TimeoutError("authenticated health remained in startup state")
            time.sleep(5)
            continue
        verify_live_health(payload, expected)
        return


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", required=True, choices=sorted(DEPLOYMENTS))
    parser.add_argument("--modal-app-id", required=True)
    parser.add_argument("--modal-deployment-id", required=True)
    parser.add_argument("--modal-function-id", required=True)
    parser.add_argument("--modal-image-id", required=True)
    parser.add_argument("--endpoint-origin", required=True)
    parser.add_argument("--checkpoint-sha256", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--worker-identity-output", required=True, type=Path)
    args = parser.parse_args()
    private_key = os.getenv("MUSIC_GPU_PROMOTION_PRIVATE_KEY_FILE", "")
    if not private_key:
        raise SystemExit(
            "MUSIC_GPU_PROMOTION_PRIVATE_KEY_FILE must be provided by CI"
        )
    deployment = DEPLOYMENTS[args.provider]
    record = build_promotion_record(
        deployment,
        modal_app_id=args.modal_app_id,
        modal_deployment_id=args.modal_deployment_id,
        modal_function_id=args.modal_function_id,
        modal_image_id=args.modal_image_id,
        endpoint_origin=args.endpoint_origin,
        checkpoint_sha256=args.checkpoint_sha256,
        source_revision=args.source_revision,
    )
    token = os.getenv("MUSIC_AI_WORKER_TOKEN", "")
    verify_live_health_with_retries(
        lambda: fetch_authenticated_health(record["endpointOrigin"], args.provider, token),
        record,
    )
    write_promotion_bundle(args.output, record, Path(private_key))
    write_worker_identity(args.worker_identity_output, record)


if __name__ == "__main__":
    main()