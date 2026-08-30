---
name: Modal GPU identity and model immutability
description: Trust boundaries for promoting Modal GPU workers and preserving canonical model hashes.
---

Use Modal's runtime-injected immutable image object ID as the deployed image identity. Keep any deterministic source-tree hash separately labeled as source-build evidence, and promote the observed image ID through configuration controlled independently of the worker.

**Why:** A source hash is not an OCI/container digest, while Modal exposes the actual running image as an `im-...` identity. Readiness must not claim stronger container provenance than it has.

**How to apply:** Require the promoted image ID, exact endpoint origin, checkpoint hash, runtime pins, GPU evidence, and real smoke inference to agree in health and completed-result provenance.

Treat mounted model snapshots as immutable. If an upstream loader syncs code, caches, or bytecode into its model directory, build a temporary runtime view outside the attested checkpoint and link only validated model bytes into it.

**Why:** ACE-Step initialization overwrites model-adjacent Python files, which changes an otherwise canonical checkpoint digest after successful inference.

**How to apply:** Reject checkpoint symlink escapes, hash the canonical aggregate snapshot, direct loader writes to temporary storage, and verify the checkpoint hash remains stable after smoke and queued jobs.