---
name: Consolidated cancellation evidence
description: Conditions for safely deriving capacity, single-call, and batch cancellation proofs from one remote batch.
---

One full-capacity cancellation batch may support separate capacity-recovery,
single-execution, and full-batch proofs only when every member reaches pre-work,
every cancellation is acknowledged, no member reaches post-work, and a bounded
post-cancellation probe proves capacity recovery. Keep each resulting proof
small and independently validated, and retain a separately bounded wall-time
measurement for the shared run.

**Why:** Separate remote drills repeat cold setup and full observation windows.
The shared batch preserves the stronger batch guarantee while safely implying
the designated single-call lifecycle and allowing an explicit recovery probe.

**How to apply:** Consolidate only drills whose evidence semantics are implied
by the same controlled batch. Do not infer recovery without the probe or infer
execution stop when any cancellation acknowledgment or lifecycle marker is
missing.