---
name: Background analysis leases
description: Concurrency rule for resumable music-analysis workers across retries, restarts, and multiple API instances.
---

Long-running analysis must be claimed through an expiring database lease. Every progress, failure, and completion write must verify that the worker still owns that lease; retries and recovery may only claim unowned or expired work.

**Why:** Process-local job guards can strand retries during cleanup and cannot prevent one API instance from interrupting or duplicating another instance's live work. Lease-conditional terminal writes also keep stale workers from creating conflicting Song Model versions.

**How to apply:** Use the same rule for future separation, transcription, and provider-backed stages. Heartbeat while work is active, recover expired leases periodically, serialize version allocation, and clear the lease in the same transaction as terminal state.