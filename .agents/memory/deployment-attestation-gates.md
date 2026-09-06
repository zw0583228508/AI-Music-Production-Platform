---
name: Deployment attestation gates
description: Release validation must be inseparable from deployment and must not forward credentials to caller-selected origins.
---

Make live attestation part of the deployment command itself: deploy to an isolated candidate app, derive its endpoint from the deployment provider, derive expected evidence from candidate provisioning, and promote the identical blueprint to production only after every gate agrees. A separately runnable validator or a post-production-deploy check does not automate deployment safety.

**Why:** An opt-in post-deploy command can be skipped, while an authenticated validator that accepts arbitrary origins can leak the worker credential before it checks any evidence.

**How to apply:** Run real smoke inference on every release even when the provisioning container is reused, deploy to a non-production app, resolve its endpoint from trusted provider metadata, reject redirects and unexpected origins before attaching authorization, compare all readiness and checksum gates, and only then deploy the same blueprint to the production app.

Treat the installation matrix as the sole final-status authority, but require it to agree with provider-local status records and the generated completion report. A live `ready` response is insufficient when the current promotion signature fails or any live identity field differs from the signed record.

**Why:** Healthy legacy deployments can outlive signing-key rotation or report a source identity that no longer matches their promotion bundle; self-consistent matrix booleans can otherwise hide contradictions elsewhere.

**How to apply:** Audit local statuses and report rows against the matrix, validate configured endpoint keys without exposing values, and verify each READY provider’s signed promotion against fresh live health and exact immutable identities.

Treat authenticated GPU cold starts as an explicit, fail-closed startup state. Release validation may retry that state for a fixed number of attempts, but must reject ordinary not-ready responses, malformed payloads, identity mismatches, and runtime exceptions immediately.

**Why:** A container refresh can make the first CUDA-sensitive health probe raise before a warmed retry succeeds; exposing that as a generic server error is ambiguous, while retrying arbitrary errors can hide real release failures.

**How to apply:** Pre-warm runtime checks before serving where possible, sanitize probe exceptions into a stable startup contract, and bound retries to the exact authenticated provider/status/retryable tuple.