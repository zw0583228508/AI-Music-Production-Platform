---
name: Blocked-provider evidence preimages
description: Auditability and schema rules for terminal provider compatibility failures
---

For a provider closed as blocked after a remote compatibility probe, retain the
non-secret raw compatibility result, exact asset-manifest descriptor, and a
normalized raw run excerpt alongside their hashes. A narrative transcript and
hashes whose preimages are unavailable are not sufficient evidence.

**Why:** A terminal blocker must remain independently auditable after ephemeral
CI and platform logs expire. This also prevents a summary from asserting model,
fixture, or runtime facts that reviewers cannot reproduce from retained data.

**How to apply:** Ensure the provisioning manifest producer writes the same
identity schema consumed by compatibility and health validators. Reuse an exact
existing manifest without network, reject ambiguous nonempty state, and bind
status/matrix/report claims to retained preimages through the root audit.