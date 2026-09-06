"""MR-MT3 adapter; isolated identity over the pinned mt3-infer runtime."""
from __future__ import annotations

from . import mt3

PROVIDER = "MR_MT3"
MODEL_VERSION = "mr-mt3"
CHECKPOINT_LICENSE = "MIT"
CHECKPOINT_SOURCE_REVISION = (
    "gudgud1014/MR-MT3@539c08b0fe551076db6108a5f5b2a57d774881ed#mt3.pth"
)


def main(argv=None):
    # mt3's command handler resolves these module-level immutable identities.
    previous_provider, previous_version, previous_license, previous_revision = (
        mt3.PROVIDER, mt3.MODEL_VERSION, mt3.CHECKPOINT_LICENSE,
        mt3.CHECKPOINT_SOURCE_REVISION,
    )
    previous_model = __import__("os").environ.get("MT3_INFER_MODEL")
    try:
        mt3.PROVIDER, mt3.MODEL_VERSION, mt3.CHECKPOINT_LICENSE = (
            PROVIDER, MODEL_VERSION, CHECKPOINT_LICENSE
        )
        mt3.CHECKPOINT_SOURCE_REVISION = CHECKPOINT_SOURCE_REVISION
        __import__("os").environ["MT3_INFER_MODEL"] = "mr_mt3"
        return mt3.main(argv)
    finally:
        mt3.PROVIDER, mt3.MODEL_VERSION, mt3.CHECKPOINT_LICENSE = (
            previous_provider, previous_version, previous_license
        )
        mt3.CHECKPOINT_SOURCE_REVISION = previous_revision
        if previous_model is None:
            __import__("os").environ.pop("MT3_INFER_MODEL", None)
        else:
            __import__("os").environ["MT3_INFER_MODEL"] = previous_model


if __name__ == "__main__":
    raise SystemExit(main())