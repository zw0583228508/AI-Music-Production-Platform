---
name: Killed spawn-worker fixtures
description: How to model permanently blocked child work in tests that forcibly reap spawned processes.
---

Tests that intentionally terminate or kill a spawned worker should model the permanent block with plain child-local work, such as a long sleep or active timer, rather than waiting on a shared event, queue, synchronized value, or unsettled top-level await.

**Why:** Killing a child while it owns or waits through multiprocessing synchronization can wedge the parent’s resource cleanup and make a bounded-worker regression hang for reasons unrelated to the production cleanup contract. Node can also exit with code 13 for an unsettled top-level await instead of remaining alive, invalidating signal-resistance fixtures.

**How to apply:** For reaping and deadline tests, keep proof of unresolved remote state in the parent fixture and use child-local blocking behavior that demonstrably keeps the event loop active. Use shared synchronization only when the child is expected to exit cooperatively.