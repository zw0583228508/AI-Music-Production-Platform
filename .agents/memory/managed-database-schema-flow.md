---
name: Managed database schema flow
description: How schema changes are applied safely in this Replit-managed PostgreSQL project.
---

Treat the Drizzle schema as the source of truth. Apply it to development and integration-test databases with the existing Drizzle push flow; let Replit Publish compute and apply the production schema diff.

**Why:** Replit-managed PostgreSQL applies development changes after merges and production changes during Publish. Checked-in startup/deploy DDL creates an unsupported third migration path and can mutate production on every launch.

**How to apply:** Keep test setup and post-merge setup idempotently pushing the schema. Never add schema mutation to application startup or deployment builds; production schema changes flow through a new Publish.