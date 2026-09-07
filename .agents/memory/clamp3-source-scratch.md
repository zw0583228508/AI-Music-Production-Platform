---
name: CLaMP3 source scratch isolation
description: Keep upstream CLaMP3 preprocessing logs outside the attested source tree.
---

CLaMP3's preprocessors write `temp/` and relative `logs/` beside their source. Run extraction from a private per-request copy of the verified small source tree, with model bytes still linked to the immutable volume.

**Why:** Repeated root inference altered the checkout with logs; after a required non-root privilege drop, extraction correctly failed when upstream tried to create `temp/` inside the read-only checkout.

**How to apply:** Verify the original source/model identities before every request, copy only the small source tree into private scratch for execution, preserve the checkpoint symlink to verified volume bytes, and discard the copy afterward.