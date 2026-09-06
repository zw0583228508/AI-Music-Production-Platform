"""Deploy SheetSage and require live attestation before promotion.

Release from the repository root with:
    python services/sheetsage-worker/modal_app.py --fixture <volume-file>

The release command runs candidate-image inference, deploys an isolated candidate,
derives its HTTPS endpoint from Modal, and promotes the identical blueprint to the
production app only after authenticated live evidence passes.
"""
from __future__ import annotations

import argparse
import modal

from modal_config import (
    APP_NAME, ENDPOINT_LABEL, LICENSE_SECRET_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME, REPOSITORY_ROOT,
    RUNTIME_SECRET_NAME, SMOKE_MOUNT, SMOKE_VOLUME_NAME, WORKER_ROOT,
    image_build_args, worker_environment,
)

app = modal.App(APP_NAME)
CANDIDATE_APP_NAME = f"{APP_NAME}-candidate"
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT, build_args=image_build_args()
)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
smoke_volume = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=False)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
license_secret = modal.Secret.from_name(LICENSE_SECRET_NAME)


@app.cls(
    image=image,
    secrets=[runtime_secret, license_secret],
    volumes={MODEL_MOUNT: model_volume, SMOKE_MOUNT: smoke_volume},
    timeout=600,
    scaledown_window=300,
    max_containers=1,
    # Intentionally no min_containers / scale floor.
    env=worker_environment(),
)
@modal.concurrent(max_inputs=1)
class SheetSageWorker:
    @modal.asgi_app(label=ENDPOINT_LABEL)
    def endpoint(self):
        from app import app as fastapi_app
        return fastapi_app


def deployed_candidate_endpoint_url() -> str | None:
    """Resolve the isolated candidate endpoint from Modal metadata."""
    return SheetSageWorker().endpoint.get_web_url()


def deploy_and_validate(fixture_name: str) -> dict:
    """Attest an isolated candidate before changing production traffic."""
    from deployment_validation import validate_deployment
    from modal_provision import app as provision_app, smoke_remote

    if not fixture_name or fixture_name != __import__("pathlib").Path(fixture_name).name:
        raise ValueError("fixture must name a previously uploaded volume file")
    with provision_app.run():
        smoke_evidence = smoke_remote.remote(fixture_name)
    expected_checksum = smoke_evidence.get("manifestSha256")
    if not isinstance(expected_checksum, str):
        raise RuntimeError(
            "deployment validation failed: provisioning_manifest_checksum"
        )
    app.deploy(name=CANDIDATE_APP_NAME, strategy="recreate")
    endpoint_url = deployed_candidate_endpoint_url()
    if not endpoint_url:
        raise RuntimeError("deployment validation failed: modal_endpoint")
    result = validate_deployment(endpoint_url, expected_checksum)
    app.deploy(name=APP_NAME, strategy="rolling")
    return {
        "validated": True,
        "provider": result["provider"],
        "version": result["version"],
        "checksum": result["checksum"],
        "gates": result["validatedGates"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture",
        required=True,
        help="licensed real-audio fixture filename already on the smoke volume",
    )
    args = parser.parse_args()
    print(deploy_and_validate(args.fixture))


if __name__ == "__main__":
    main()