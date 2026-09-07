---
name: Focused API bundle boundaries
description: How to isolate provider routing tests from database runtime packaging without hiding accidental database access.
---

Focused provider-routing tests that import an orchestration module should alias its database workspace package to a stub that throws on every database operation.

**Why:** Bundling the real database package pulls native/client CommonJS assumptions such as node-postgres dynamic requires into ESM tests, while externalizing the whole workspace can expose unresolved TypeScript directory imports. A permissive mock would also let a supposedly fail-closed path touch persistence unnoticed.

**How to apply:** Use a test-only bundle alias for the database package, keep the rest of the application module real, and make the stub throw synchronously on its first operation. This both avoids packaging artifacts and proves blocked routing returns before persistence.