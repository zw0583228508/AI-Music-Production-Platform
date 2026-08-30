"""Create the signed, atomically rotated promotion bundle for a Modal worker.

Deployment CI should call this only after it has observed the IDs returned by
Modal for the exact deployment. The signing key is read from the CI
environment and is never copied into the worker environment.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from modal_config import (
    DEPLOYMENTS,
    build_promotion_record,
    write_promotion_bundle,
    write_worker_identity,
)


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
    write_promotion_bundle(args.output, record, Path(private_key))
    write_worker_identity(args.worker_identity_output, record)


if __name__ == "__main__":
    main()