---
name: Historical export reconciliation
description: Safety policy for inventorying and cleaning private export objects that predate durable crash ownership.
---

Only current content-addressed export packages that are unreferenced, older than an explicit threshold, and present in an exactly reviewed dry-run candidate set may be deleted. Ready references, supported historical names, provider generation assets, unknown formats, and objects without trustworthy creation time remain preservation-only.

**Why:** Older and manually produced objects do not carry enough ownership identity to infer safe deletion, while provider audio and historical package URIs can remain valid downloads.

**How to apply:** Recompute inventory immediately before cleanup and abort if the eligible set differs from the reviewed report; never broaden cleanup based only on the exports directory or file extension.