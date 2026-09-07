---
name: Stable Audio 3 offline inference
description: Non-obvious offline-loading and exact inpainting constraints for the pinned Stable Audio 3 runtime.
---

Stable Audio 3 snapshots can contain nested conditioner configuration that still names a gated Hugging Face repository even when the primary checkpoint is loaded from a local directory. Offline serving must recursively localize those references to the corresponding snapshot subdirectory and enable strict offline modes; otherwise real inference attempts a request-time gated download.

**Why:** Direct local loading of the main checkpoint was insufficient because T5Gemma conditioner construction independently resolved its repository identity.

**How to apply:** For any Stable Audio 3 snapshot or runtime upgrade, verify every nested repository/model-path reference resolves inside the provisioned immutable snapshot and run smoke inference with network access unavailable.

Upstream inpainting may regenerate or change channel layout outside the requested mask. A product contract requiring bit-exact preservation must composite the model-rendered mask into the source while retaining the source channel layout outside the mask.

**Why:** The pinned upstream implementation produced valid inpainting audio but changed samples or channel shape outside the requested region.

**How to apply:** Preserve source samples and channel layout outside the mask, use model output only inside it, and retain an exact sample-comparison smoke assertion.