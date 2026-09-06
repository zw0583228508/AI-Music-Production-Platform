"""Fail-closed SongFormer provisioning boundary.

No import or command in this module can download source or checkpoint bytes
until every required checkpoint has an affirmative retained license grant.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "model_manifest.json").read_text())


class SongFormerLicenseBlocked(RuntimeError):
    """Raised before filesystem, network, GPU, or subprocess work."""


def assert_license_cleared() -> None:
    gate = MANIFEST.get("licenseGate", {})
    if (
        gate.get("status") != "LICENSE_CLEARED"
        or gate.get("provisioningAllowed") is not True
    ):
        raise SongFormerLicenseBlocked(
            "SONGFORMER provisioning is blocked: required checkpoint rights are not verified"
        )


def main() -> None:
    assert_license_cleared()
    raise RuntimeError(
        "SONGFORMER provisioning requires a reviewed implementation after license clearance"
    )


if __name__ == "__main__":
    main()