---
name: OpenAPI bounded counts
description: Compatibility guidance for small count fields generated through the workspace OpenAPI and Zod pipeline.
---

Model small bounded count summaries as finite numeric enums rather than bare integers or shared numeric bounds while the generated validators target Zod 3.

**Why:** The current generator emits `zod.int()` for a bare OpenAPI integer, but the workspace's Zod version does not expose that API. Reused maximum bounds can also be declared after schemas that reference them, causing temporal-dead-zone type and runtime failures.

**How to apply:** For counts with a small fixed range, use `type: number` and enumerate the allowed integers. Keep server construction bounded too. Use ordinary bounds only after generated declaration ordering is verified.