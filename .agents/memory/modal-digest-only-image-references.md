---
name: Modal digest-only image references
description: The accepted syntax for immutable external image inputs in Modal Dockerfile builds.
---

Use `repository@sha256:<digest>` for immutable `FROM` and `COPY --from` image references in Modal Dockerfile-backed builds; omit the tag.

**Why:** Modal's image builder delegates external stages through a path that rejects Docker references containing both a tag and a digest, even though some Docker tooling accepts that syntax.

**How to apply:** Keep the human-readable runtime version in separate runtime metadata, while the actual build input uses the digest-only repository reference.