---
name: Provider truth and job fencing
description: Rules for truthful music-provider provenance and safe recovery of long-running analysis work.
---

Never attribute musical output to an external model unless that provider is actually configured and executed. Local or deterministic fallbacks must identify themselves, and malformed provider output must be rejected before it changes an arrangement.

**Why:** Convincing fallback data can otherwise look like a successful AI-provider result, making musical provenance and quality claims unreliable.

**How to apply:** Keep unavailable providers visible as unavailable, validate canonical contracts before persistence, and preserve provider/version provenance with every result.

Long-running analysis workers must hold a database fencing token for every state transition and terminal write; an in-memory lock or lease timestamp alone is insufficient.

**Why:** After a restart or lease transfer, a stale worker can otherwise overwrite a newer worker's completed result or mark it failed.

**How to apply:** Increment a claim version, condition all paired job/result writes on worker plus version plus valid lease, and exit silently when ownership is lost.