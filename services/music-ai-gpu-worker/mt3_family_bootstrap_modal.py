"""One-shot isolated Modal provisioning for the Wave 2 MT3 providers.

This module is not an HTTP worker and is never included in normal serving
deployment. It mounts exactly one provider-private model volume per function,
downloads only through the pinned mt3-infer CLI, performs CUDA smoke inference,
and commits the bounded JSON evidence required for later human-reviewed
promotion.
"""
from __future__ import annotations

import sys
from pathlib import Path

import modal

from modal_config import (
    DEPLOYMENTS,
    MR_MT3_MODEL_VOLUME_NAME,
    MT3_FAMILY_MODEL_MOUNT,
    YOUR_MT3_MODEL_VOLUME_NAME,
    provider_image_build_args,
)


APP_NAME = "music-ai-mt3-family-bootstrap"
ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next(
    (candidate for candidate in (ROOT, *ROOT.parents)
     if (candidate / "pnpm-workspace.yaml").is_file()),
    ROOT,
)
app = modal.App(APP_NAME)
mr_mt3_image = modal.Image.from_dockerfile(
    ROOT / "Dockerfile.mr-mt3", context_dir=REPOSITORY_ROOT,
    build_args=provider_image_build_args(DEPLOYMENTS["MR_MT3"]),
)
your_mt3_image = modal.Image.from_dockerfile(
    ROOT / "Dockerfile.your-mt3", context_dir=REPOSITORY_ROOT,
    build_args=provider_image_build_args(DEPLOYMENTS["YOUR_MT3"]),
)
mr_mt3_volume = modal.Volume.from_name(MR_MT3_MODEL_VOLUME_NAME, create_if_missing=True)
your_mt3_volume = modal.Volume.from_name(YOUR_MT3_MODEL_VOLUME_NAME, create_if_missing=True)


def _bootstrap(provider: str) -> dict:
    sys.path.insert(0, "/app")
    from mt3_family_bootstrap import bootstrap
    return bootstrap(provider, Path(MT3_FAMILY_MODEL_MOUNT))


@app.function(
    image=mr_mt3_image, gpu=DEPLOYMENTS["MR_MT3"].gpu,
    volumes={MT3_FAMILY_MODEL_MOUNT: mr_mt3_volume},
    timeout=2 * 60 * 60, max_containers=1,
)
def bootstrap_mr_mt3() -> dict:
    try:
        return _bootstrap("MR_MT3")
    finally:
        mr_mt3_volume.commit()


@app.function(
    image=your_mt3_image, gpu=DEPLOYMENTS["YOUR_MT3"].gpu,
    volumes={MT3_FAMILY_MODEL_MOUNT: your_mt3_volume},
    timeout=2 * 60 * 60, max_containers=1,
)
def bootstrap_your_mt3() -> dict:
    try:
        return _bootstrap("YOUR_MT3")
    finally:
        your_mt3_volume.commit()


@app.local_entrypoint()
def bootstrap(provider: str) -> None:
    normalized = provider.strip().upper()
    if normalized == "MR_MT3":
        print(bootstrap_mr_mt3.remote())
    elif normalized == "YOUR_MT3":
        print(bootstrap_your_mt3.remote())
    else:
        raise ValueError("provider must be MR_MT3 or YOUR_MT3")