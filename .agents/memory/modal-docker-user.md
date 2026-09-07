---
name: Modal Docker USER behavior
description: Modal Dockerfile-backed images ignore the Docker USER instruction.
---

Do not treat a Dockerfile `USER` instruction as evidence that a Modal function runs under that UID; Modal's image builder reports that the instruction is unsupported and skips it.

**Why:** A provider image built successfully while the Modal build log explicitly said `Skipping USER instruction, it is unsupported by Modal container images.`

**How to apply:** For Modal workers that require OS-level privilege dropping, verify the effective runtime UID and use a Modal-supported isolation mechanism rather than relying on Docker `USER`.