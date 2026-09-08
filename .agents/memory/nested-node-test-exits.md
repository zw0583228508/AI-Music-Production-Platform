---
name: Nested Node test exits
description: Preserving failure exit codes when a Node test launches another Node test process.
---

When a Node test harness launches another `node --test` process, remove the inherited `NODE_TEST_CONTEXT` variable from the child environment.

**Why:** The nested runner can print a real test failure yet exit successfully when it inherits the parent harness context, causing wrapper regressions to miss failures.

**How to apply:** Any test helper or package runner that invokes `node --test` from inside another Node test should clone the environment, remove only the parent test-context marker, and preserve the rest.