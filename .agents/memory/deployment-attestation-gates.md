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

Modal GPU endpoints can return a platform-generated 500 before ASGI exists when a zero-container custom image takes longer than the route startup deadline. Warm only the fixed trusted candidate origin without credentials until it returns the expected authentication challenge; then treat the next request as the first authenticated health response.

**Why:** A real Beat This recreate drill repeatedly produced a 500 with no application execution time before later requests reached FastAPI. Sending the bearer token during that platform-only phase made the first authenticated observation ambiguous.

**How to apply:** Bound both phases. The credential-free phase accepts only transient routing failures followed by the exact auth boundary, sends no authorization header, and records only attempt counts. The authenticated phase still accepts only exact startup or ready schemas.

Modal may hydrate an ASGI class with its control-plane Python rather than the image runtime placed first on `PATH`. Child readiness probes must explicitly invoke the reviewed image interpreter and must not race pipe collection after process exit.

**Why:** A probe launched through `sys.executable` ran outside the pinned Beat This environment, while the identical command succeeded through the image interpreter. Zero-time `communicate` could also misclassify completed JSON output.

**How to apply:** Use the absolute interpreter installed in the image, discard child stderr, validate a minimal typed result, retry only transient initialization, and convert spawn/parse failures into sanitized health states.

Every production consumer of an authenticated startup contract must verify the complete promoted identity before retrying, and must not negative-cache a response that remains validly provisional. A cached successful health result must never authorize a later source-bearing request.

**Why:** A worker and release validator can correctly emit and accept `starting` while an API caller still converts that same response into a cached terminal failure, making cold recovery impossible for real user traffic. Conversely, package, source-tree, runtime-lock, model, or smoke evidence can drift after a cached success; forwarding private source under that stale success bypasses the fail-closed gate.

**How to apply:** Share the signed identity gate with the ready path, allow only the exact provider-specific startup schema, retry on a fixed bound, and leave bounded startup exhaustion uncached so a later request can recover. Status-only callers may use a short cache, but every source-bearing request must perform a fresh complete health attestation immediately before each POST, including retries, and transfer nothing when it fails.