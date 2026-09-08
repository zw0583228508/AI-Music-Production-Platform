---
name: Nested Node test exits
description: Preserving failure exit codes when a Node test launches another Node test process.
---

When a Node test harness launches another `node --test` process, remove the inherited `NODE_TEST_CONTEXT` variable from the child environment. For interruption checks, synchronize from inside the active test through an out-of-band handshake, and terminate the nested runner's isolated session rather than only its coordinator. Async signal cleanup must keep guarded handlers installed until escalation finishes; `once` listeners and unconditional `finally` removal reopen the default-exit path during the grace period.

**Why:** The nested runner can print a real test failure yet exit successfully when it inherits the parent harness context. TAP output from an active test may also be buffered, and Node can place test workers outside the coordinator's process group. A repeated signal can bypass delayed SIGKILL if the first signal or a concurrent `finally` path removes handlers early.

**How to apply:** Any helper that invokes `node --test` from inside another Node test should clone the environment, remove only the parent test-context marker, and preserve the rest. Signal tests should use a fully written file/IPC handshake from the blocked callback, target the runner under test, send a repeated signal during the grace interval, and verify all captured session members disappear.