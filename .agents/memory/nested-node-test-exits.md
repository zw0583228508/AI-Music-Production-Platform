---
name: Nested Node test exits
description: Preserving failure exit codes when a Node test launches another Node test process.
---

When a Node test harness launches another `node --test` process, remove the inherited `NODE_TEST_CONTEXT` variable from the child environment. For interruption checks, synchronize from inside the active test through an out-of-band handshake, and terminate the nested runner's isolated process group rather than only its coordinator.

**Why:** The nested runner can print a real test failure yet exit successfully when it inherits the parent harness context. TAP output from an active test may also be buffered, and killing only the coordinator can leave its test worker alive.

**How to apply:** Any helper that invokes `node --test` from inside another Node test should clone the environment, remove only the parent test-context marker, and preserve the rest. Signal tests should use a fully written file/IPC handshake from the blocked callback, target the runner under test, and verify the nested child disappears.