"""Central fail-closed authorization gate for every LaDA-Band execution path."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LICENSE = json.loads((ROOT / "license_manifest.json").read_text())


def authorization_state() -> tuple[bool, str]:
    try:
        evidence = json.loads((ROOT / LICENSE["evidence_file"]).read_text())
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return False, "BLOCKED_LICENSE: retained LaDA-Band license review is unavailable"

    decision = evidence.get("decision", {})
    source = evidence.get("source", {})
    model = evidence.get("model", {})
    authorized = (
        LICENSE.get("license_status") == "RESEARCH_ONLY_AUTHORIZED"
        and LICENSE.get("routing_status") == "RESEARCH_READY_CANDIDATE"
        and LICENSE.get("environment_values_are_authorization_evidence") is False
        and source.get("firstPartyLicenseStatus") == "RESEARCH_USE_GRANTED"
        and model.get("approvedAccountEvidenceRetained") is True
        and model.get("acceptedTermsEvidenceRetained") is True
        and model.get("firstPartyModelGrantRetained") is True
        and model.get("completeThirdPartyWeightGrantsRetained") is True
        and decision.get("researchUseAuthorized") is True
        and decision.get("assetDownloadAuthorized") is True
        and decision.get("runtimeBuildAuthorized") is True
        and decision.get("provisioningAuthorized") is True
        and decision.get("inferenceAuthorized") is True
    )
    if not authorized:
        return False, (
            "BLOCKED_LICENSE: first-party source/model terms, approved gated "
            "account acceptance, and complete bundled-weight grants are not retained"
        )
    return True, "authorized for isolated non-commercial research use"


def require_authorization(operation: str) -> None:
    authorized, reason = authorization_state()
    if not authorized:
        raise RuntimeError(f"{operation} refused: {reason}")