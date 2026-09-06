---
name: Private recovery drills
description: Isolation and alert-redaction rules for validating owner-controlled model recovery archives.
---

Recovery drills must download and verify archives only in disposable storage. The scheduled drill must not mount the production model volume, while the real restore path may reuse the same verification routine before promotion. Successful drills must also write a durable, redacted heartbeat that an independently scheduled freshness monitor checks.

**Why:** A readiness check must prove all archive and asset checksums without creating any path that can mutate or commit production state. Network exceptions may embed private source URLs in their messages, so preserving their exception chain can leak credentials or restricted-source locations into scheduler alerts. A drill schedule that disappears otherwise looks identical to a healthy system unless success has an expiring, externally checked signal.

**How to apply:** Keep verification separate from promotion, omit production volumes from drill infrastructure declarations, and replace URL-bearing download failures with actionable sanitized errors raised without the original exception context. Persist only the completion time and non-sensitive counts/booleans; never store the source URL, archive contents, or restricted model details in monitoring state.