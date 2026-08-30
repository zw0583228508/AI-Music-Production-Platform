---
name: Private artifact publication
description: Coordination and compatibility rules for publishing and deleting durable private artifacts.
---

Durable private outputs must publish under the same project-scoped database lock used by project deletion, recheck that the project exists before writing bytes, and remove bytes if the fenced metadata transaction does not commit.

**Why:** Enumerating cleanup paths before an in-flight worker writes its output can leave private bytes with no surviving database row, while metadata-only fencing does not undo an external storage write.

**How to apply:** Use one project advisory lock for deletion and final publication. Persist the exact content-addressed storage identity in artifact lineage, and compensate by deleting the object whenever publication fails after the byte write.

Cleanup must normalize every still-supported historical storage URI to the same canonical private-object path.

**Why:** Backward-compatible downloads prove historical rows remain live; ignoring their old URI scheme during deletion or retention leaks the underlying content-addressed object.

**How to apply:** Whenever a private artifact URI representation changes, keep deletion, retention, and integration tests compatible with both old and new forms until the old records are migrated away.