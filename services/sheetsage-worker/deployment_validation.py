"""Fail-closed validation of a deployed SheetSage HTTPS endpoint."""
from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

TRUSTED_ENDPOINT_SUFFIX = "--sheetsage-candidate.modal.run"


class DeploymentValidationError(RuntimeError):
    """The deployed endpoint did not satisfy its promotion evidence gates."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def validate_health_evidence(
    health: Any, expected_manifest_sha256: str
) -> dict[str, Any]:
    if not _sha256(expected_manifest_sha256):
        raise DeploymentValidationError(
            "deployment validation failed: expected_manifest_checksum"
        )
    if not isinstance(health, dict):
        raise DeploymentValidationError(
            "deployment validation failed: health_response"
        )
    gates = {
        "provider_identity": health.get("provider") == "SHEETSAGE",
        "assets_verified": health.get("assetsVerified") is True,
        "runtime_ready": health.get("runtimeReady") is True,
        "checkpoint_ready": health.get("checkpointReady") is True,
        "signed_real_smoke_proof": (
            health.get("smokeTested") is True
            and health.get("smokeProofVerified") is True
        ),
        "manifest_checksum": (
            health.get("checksum") == expected_manifest_sha256
            and _sha256(health.get("checksum"))
        ),
        "healthy_status": (
            health.get("healthy") is True and health.get("status") == "ready"
        ),
    }
    failed = [name for name, passed in gates.items() if not passed]
    if failed:
        raise DeploymentValidationError(
            "deployment validation failed: " + ", ".join(failed)
        )
    return {
        "provider": health["provider"],
        "version": health.get("version"),
        "checksum": health["checksum"],
        "validatedGates": list(gates),
    }


def validate_deployment(
    endpoint_url: str,
    expected_manifest_sha256: str,
    *,
    token: str | None = None,
    timeout_seconds: float = 60,
) -> dict[str, Any]:
    parsed = urlparse(endpoint_url)
    hostname = parsed.hostname or ""
    if (
        parsed.scheme != "https"
        or not hostname.endswith(TRUSTED_ENDPOINT_SUFFIX)
        or parsed.port is not None
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise DeploymentValidationError(
            "deployment validation failed: endpoint_url"
        )
    runtime_token = token or os.getenv("SHEETSAGE_API_TOKEN") or os.getenv(
        "MUSIC_AI_WORKER_TOKEN"
    )
    if not runtime_token:
        raise DeploymentValidationError(
            "deployment validation failed: authentication_configuration"
        )
    health_url = endpoint_url.rstrip("/") + "/health"
    request = Request(
        health_url,
        headers={"Authorization": f"Bearer {runtime_token}", "Accept": "application/json"},
    )
    try:
        opener = build_opener(_NoRedirect())
        with opener.open(request, timeout=timeout_seconds) as response:
            if response.status != 200:
                raise DeploymentValidationError(
                    f"deployment validation failed: health_http_{response.status}"
                )
            health = json.loads(response.read())
    except HTTPError as exc:
        raise DeploymentValidationError(
            f"deployment validation failed: health_http_{exc.code}"
        ) from None
    except (URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError):
        raise DeploymentValidationError(
            "deployment validation failed: health_request"
        ) from None
    return validate_health_evidence(health, expected_manifest_sha256)