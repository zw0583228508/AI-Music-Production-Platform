---
name: Checkpoint license provenance
description: License and routing gate for model weights repackaged by unofficial wrappers.
---

An unofficial wrapper repository’s model-card license does not establish redistribution or commercial-use rights for checkpoint bytes credited to an external author or release repository. Keep the provider `BLOCKED_LICENSE` until an immutable grant from the checkpoint rights holder is retained and hash-bound.

**Why:** A wrapper can permissively license its adapter code and metadata without having authority to relicense externally trained weights. Public download availability is not a commercial-use grant.

**How to apply:** Track backend, wrapper, architecture, and checkpoint licenses separately; trace the exact checkpoint to its originating asset; retain the owner’s immutable grant; and require that evidence before READY. While blocked, mark machine-readable manifests and catalogs unambiguously unavailable, reject bootstrap and deployment, stop any historical endpoint, reject authenticated worker health/execution before checkpoint or GPU work, and remove active promotions. In every API provider family, one central authorization predicate must run before exact, legacy, shared-token, or generic-gateway resolution and must gate registry construction, health, catalog status, selection, invocation, cancellation, and arrangement helpers. Prove both direct-worker and every API registry path execute zero inference.