---
name: Killed spawn-worker fixtures
description: How to model permanently blocked child work in tests that forcibly reap spawned processes.
---

Tests that intentionally terminate or kill a spawned worker should model the permanent block with plain child-local work, such as a long sleep, rather than waiting on a shared event, queue, or synchronized value.

**Why:** Killing a child while it owns or waits through multiprocessing synchronization can wedge the parent’s resource cleanup and make a bounded-worker regression hang for reasons unrelated to the production cleanup contract.

**How to apply:** For reaping and deadline tests, keep proof of unresolved remote state in the parent fixture and use child-local blocking behavior. Use shared synchronization only when the child is expected to exit cooperatively.