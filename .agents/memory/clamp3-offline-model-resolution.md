---
name: CLaMP3 offline model resolution
description: Enforce egress denial and bind upstream repository arguments to local snapshots.
---

Offline library flags are not network isolation, and cached repository IDs can still trigger remote format probes. Serving and smoke need platform egress blocking plus exact local snapshot arguments.

**Why:** With Modal egress blocked, real audio inference exposed a hidden Hugging Face lookup for a safetensors variant even though the pinned MERT PyTorch checkpoint was present.

**How to apply:** Set `block_network` at the Modal function boundary, attest that control in health, and hash an adapter that replaces upstream repository-name arguments with immutable local snapshot paths.