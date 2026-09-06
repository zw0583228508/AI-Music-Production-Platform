"""Non-deployable SongFormer boundary while checkpoint rights are unresolved."""
import json
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "model_manifest.json").read_text())
app = modal.App("songformer-worker")


def assert_deployment_cleared() -> None:
    gate = MANIFEST.get("licenseGate", {})
    if (
        gate.get("status") != "LICENSE_CLEARED"
        or gate.get("deploymentAllowed") is not True
    ):
        raise RuntimeError(
            "SONGFORMER deployment is blocked: required checkpoint rights are not verified"
        )


@app.local_entrypoint()
def main(action: str = "bootstrap") -> None:
    del action
    assert_deployment_cleared()
    raise RuntimeError(
        "SONGFORMER deployment requires a reviewed implementation after license clearance"
    )