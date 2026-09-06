---
name: MOSS media-runtime conflict
description: Why the pinned MOSS-Music and moss-audio SGLang revisions cannot currently share one truthful TorchCodec runtime.
---

Keep MOSS-Music unavailable when its pinned model revision requires the
TorchCodec 0.9 line while its pinned moss-audio SGLang revision requires
TorchCodec 0.8. Do not let installation order choose one silently, and do not
override either pin without a reviewed upstream-compatible revision.

**Why:** Real provisioning downloaded both model snapshots, but native media
preflight failed. Inspection showed mutually incompatible upstream TorchCodec
requirements; FFmpeg path propagation alone could not make that environment
coherent.

**How to apply:** Require dependency resolution, `pip check`, native
TorchCodec loading, and a real tiny-WAV decode before model smoke. Resume only
with a reviewed compatible SGLang/MOSS revision pair or an upstream-approved
constraint change.