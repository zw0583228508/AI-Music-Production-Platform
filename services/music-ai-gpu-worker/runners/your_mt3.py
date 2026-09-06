"""YourMT3 adapter; isolated identity over the pinned mt3-infer runtime."""
from __future__ import annotations

from . import mt3

PROVIDER = "YOUR_MT3"
MODEL_VERSION = "your-mt3"
CHECKPOINT_LICENSE = "Apache-2.0"
CHECKPOINT_SOURCE_REVISION = (
    "mimbres/YourMT3@e45ebd70398682d54b7bb1901a5216e18f3b1824"
    "#logs/2024/mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops/"
    "checkpoints/last.ckpt"
)
UPSTREAM_SOURCE_REVISION = (
    "huggingface.co/spaces/mimbres/YourMT3@5e66c1ea173a8186e0d20432b841d3180cc015b5"
)
CONVERSION_SOURCE_REVISION = "not-applicable-native-yourmt3-checkpoint"
BACKEND_PATCH = (
    "no-behavioral-patch;transformers==4.45.1;"
    "t5mod-sha256:b2cc683b55f5d3284c0788d59f8f0a7c39b03535731aeb7a62c81c86c351f480"
)


def main(argv=None):
    previous = (
        mt3.PROVIDER,
        mt3.MODEL_VERSION,
        mt3.CHECKPOINT_LICENSE,
        mt3.CHECKPOINT_SOURCE_REVISION,
        mt3.UPSTREAM_SOURCE_REVISION,
        mt3.CONVERSION_SOURCE_REVISION,
        mt3.BACKEND_PATCH,
    )
    previous_model = __import__("os").environ.get("MT3_INFER_MODEL")
    try:
        (
            mt3.PROVIDER,
            mt3.MODEL_VERSION,
            mt3.CHECKPOINT_LICENSE,
            mt3.CHECKPOINT_SOURCE_REVISION,
            mt3.UPSTREAM_SOURCE_REVISION,
            mt3.CONVERSION_SOURCE_REVISION,
            mt3.BACKEND_PATCH,
        ) = (
            PROVIDER,
            MODEL_VERSION,
            CHECKPOINT_LICENSE,
            CHECKPOINT_SOURCE_REVISION,
            UPSTREAM_SOURCE_REVISION,
            CONVERSION_SOURCE_REVISION,
            BACKEND_PATCH,
        )
        __import__("os").environ["MT3_INFER_MODEL"] = "yourmt3"
        return mt3.main(argv)
    finally:
        (
            mt3.PROVIDER,
            mt3.MODEL_VERSION,
            mt3.CHECKPOINT_LICENSE,
            mt3.CHECKPOINT_SOURCE_REVISION,
            mt3.UPSTREAM_SOURCE_REVISION,
            mt3.CONVERSION_SOURCE_REVISION,
            mt3.BACKEND_PATCH,
        ) = previous
        if previous_model is None:
            __import__("os").environ.pop("MT3_INFER_MODEL", None)
        else:
            __import__("os").environ["MT3_INFER_MODEL"] = previous_model


if __name__ == "__main__":
    raise SystemExit(main())