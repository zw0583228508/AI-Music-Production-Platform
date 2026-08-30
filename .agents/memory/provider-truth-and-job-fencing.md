---
name: Provider truth and job fencing
description: Rules for truthful music-provider provenance and safe recovery of long-running analysis work.
---

Never attribute musical output to an external model unless that provider is actually configured and executed. Local or deterministic fallbacks must identify themselves, and malformed provider output must be rejected before it changes an arrangement.

**Why:** Convincing fallback data can otherwise look like a successful AI-provider result, making musical provenance and quality claims unreliable.

**How to apply:** Keep unavailable providers visible as unavailable, validate canonical contracts before persistence, and preserve provider/version provenance with every result. Assign interpreter provenance on the server after execution; never accept a model's own claim about which interpreter ran. If validation removes every provider contribution and local logic supplies the result, classify the whole result as fallback.

Provider trust boundaries start before JSON parsing and continue through artifact persistence: bound response bytes, validate copied media locally, and never treat provider-reported object paths as ownership proof. Fusion provenance requires independent corroborating evidence.

**Why:** A syntactically plausible payload can still exhaust a worker, reference another job's private data, contain invalid media, or make one provider look like a multi-provider consensus.

**How to apply:** Stream and cap provider responses, copy provider artifacts into the current job's private namespace, probe media before recording it, and emit fusion provenance only when multiple evidence sources contribute.

Long-running analysis workers must hold a database fencing token for every state transition and terminal write; an in-memory lock or lease timestamp alone is insufficient.

**Why:** After a restart or lease transfer, a stale worker can otherwise overwrite a newer worker's completed result or mark it failed.

**How to apply:** Increment a claim version, condition all paired job/result writes on worker plus version plus valid lease, and exit silently when ownership is lost.

Remote analysis providers should receive only short-lived, GET-only signed source URLs; never pass storage credentials or expose private object paths as reusable access tokens.

**Why:** Providers need access to the original upload, but a long-lived or credential-bearing handoff would turn a model adapter into a data-exfiltration risk.

**How to apply:** Mint the URL only for a configured provider request, keep its lifetime within the provider timeout, and discard it after execution.

Song Model version allocation must be serialized across every writer, including analysis finalization and user corrections; compute the next version only after acquiring the per-project transaction lock.

**Why:** A correction and an analysis can finish at nearly the same time; reading the latest version before the transaction can cause a valid analysis to fail or produce duplicate revisions.

**How to apply:** Use the shared project lock plus a database uniqueness constraint, and require UI writes to include the version they edited so stale writes return a conflict.
