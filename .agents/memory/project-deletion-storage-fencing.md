---
name: Project deletion storage fencing
description: Why project-associated object writes must be fenced against deletion rather than relying on signed URL expiry.
---

All final private-object writes associated with a project must share a project-level database fence with project deletion. Direct source uploads should pass through an authenticated endpoint that holds this fence while streaming.

**Why:** A signed upload URL can begin a request before its expiry and commit after expiry. Cleanup that treats expiry as terminal can delete too early, report completion, and leave the later object orphaned.

**How to apply:** For uploads, analysis outputs, and durable exports, acquire the same project-scoped lock, recheck that the project or upload reservation is still active, hold the fence through the object write, and only then commit metadata.

Integration coverage must deterministically exercise both lock orderings by pausing each side after it owns the fence. Do not rely on concurrent request scheduling or accept a retained object merely because cleanup is retryable; verify successful cleanup removes it.