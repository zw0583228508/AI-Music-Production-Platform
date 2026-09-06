---
name: MOSS media-runtime conflict
description: The resolver and native-library gates for a truthful MOSS-Music plus moss-audio SGLang runtime.
---

Install the MOSS-Music base package without its Torch runtime extra, then install
the pinned moss-audio SGLang `python[all]` extra. Keep Gradio below version 6
when the Transformers stack still requires Hugging Face Hub below version 1.
A successful resolver and `pip check` are not native media proof: the CUDA
TorchCodec 0.8 wheel links NVDEC, while the official CPU wheel avoids NVDEC but
can still fail at `libtorchcodec_custom_ops7.so` against a CUDA Torch runtime.
Keep the native preflight out of Docker build layers so the immutable image can
be built and the compatibility function can retain a truthful failure. Keep
MOSS unavailable until one reviewed wheel/runtime pair passes that remote media
preflight without dependency suppression or overrides.

**Why:** Clean official-package builds passed `pip check`, but the CUDA wheel
required `libnvcuvid.so.1` and the CPU wheel then failed at its Torch custom-ops
library. Package metadata alone therefore overstated readiness. Provisioning
was correctly stopped before model downloads.

**How to apply:** Before any MOSS model provisioning, require exact source and
wheel provenance, dependency resolution, `pip check`, native WAV and MP3
decode, resampling, and tensor construction in a fail-closed compatibility
function. A failed probe must stop before assets, smoke, deployment, or
promotion. Resume only after an upstream-supported TorchCodec/Torch/FFmpeg
combination passes all gates.