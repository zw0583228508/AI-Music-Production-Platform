---
name: Attested generation I/O
description: Why GPU generation readiness must cover result provenance, external artifact URLs, and production source allowlists.
---

GPU workers that pass health attestation must return the same immutable runtime provenance on successful generation results: model/checkpoint revision, Modal image, source digest, CUDA/PyTorch/GPU identity, and smoke status. Private artifact URLs must use an externally reachable promoted origin rather than `request.base_url` behind an internal proxy. If generation downloads private source media, readiness must also verify a non-empty, valid source-origin allowlist.

**Why:** A worker can be truthfully healthy yet still be unusable if the API rejects its result for missing provenance, discards an incorrectly shaped audio artifact, or the source URL allowlist rejects every production object. An internal ASGI proxy can also rewrite `Host` to loopback, causing successful generation to return an unreachable artifact URL. Trusting caller-controlled forwarded headers instead would create a different security problem.

**How to apply:** Treat response provenance, provider-audio schema, external artifact origin, and source allowlist as release gates. Bind origins to deployment configuration rather than inbound headers, and retain a URL-free proof of authenticated source download, generation, and capability retrieval.