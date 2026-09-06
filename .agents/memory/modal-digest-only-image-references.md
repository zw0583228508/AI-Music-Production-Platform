---
name: Modal digest-only image references
description: The accepted syntax for immutable external image inputs in Modal Dockerfile builds.
---

Use `repository@sha256:<digest>` for immutable `FROM` and `COPY --from` image references in Modal Dockerfile-backed builds; omit the tag. Before relying on a GHCR digest, verify that the registry still serves it and prefer the target platform manifest digest over a mutable tag or an avoidable multi-platform index.

**Why:** Modal's image builder rejects external references containing both a tag and a digest. A digest pin is immutable but not permanently available: tag republishing or registry garbage collection can make a formerly valid GHCR digest unreachable.

**How to apply:** Keep the human-readable runtime version in separate metadata. Resolve and verify the target-platform manifest immediately before build/release, then use its digest-only repository reference.