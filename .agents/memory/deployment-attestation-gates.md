---
name: Deployment attestation gates
description: Release validation must be inseparable from deployment and must not forward credentials to caller-selected origins.
---

Make live attestation part of the deployment command itself: deploy to an isolated candidate app, derive its endpoint from the deployment provider, derive expected evidence from candidate provisioning, and promote the identical blueprint to production only after every gate agrees. A separately runnable validator or a post-production-deploy check does not automate deployment safety.

**Why:** An opt-in post-deploy command can be skipped, while an authenticated validator that accepts arbitrary origins can leak the worker credential before it checks any evidence.

**How to apply:** Run real smoke inference on every release even when the provisioning container is reused, deploy to a non-production app, resolve its endpoint from trusted provider metadata, reject redirects and unexpected origins before attaching authorization, compare all readiness and checksum gates, and only then deploy the same blueprint to the production app.