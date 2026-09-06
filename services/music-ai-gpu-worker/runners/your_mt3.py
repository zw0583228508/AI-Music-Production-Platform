"""YourMT3 adapter; isolated identity over the pinned mt3-infer runtime."""
from __future__ import annotations

from . import mt3

PROVIDER = "YOUR_MT3"
MODEL_VERSION = "your-mt3"
CHECKPOINT_LICENSE = "Apache-2.0"


def main(argv=None):
    previous_provider, previous_version, previous_license = (
        mt3.PROVIDER, mt3.MODEL_VERSION, mt3.CHECKPOINT_LICENSE
    )
    previous_model = __import__("os").environ.get("MT3_INFER_MODEL")
    try:
        mt3.PROVIDER, mt3.MODEL_VERSION, mt3.CHECKPOINT_LICENSE = (
            PROVIDER, MODEL_VERSION, CHECKPOINT_LICENSE
        )
        __import__("os").environ["MT3_INFER_MODEL"] = "yourmt3"
        return mt3.main(argv)
    finally:
        mt3.PROVIDER, mt3.MODEL_VERSION, mt3.CHECKPOINT_LICENSE = (
            previous_provider, previous_version, previous_license
        )
        if previous_model is None:
            __import__("os").environ.pop("MT3_INFER_MODEL", None)
        else:
            __import__("os").environ["MT3_INFER_MODEL"] = previous_model


if __name__ == "__main__":
    raise SystemExit(main())