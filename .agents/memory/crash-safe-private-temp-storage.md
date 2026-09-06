---
name: Crash-safe private temp storage
description: Rules for cleaning sensitive worker files after crashes without disrupting concurrent workers.
---

Sensitive worker uploads must live under a dedicated private root in process-owned directories. Hold an OS file lock for each active process and remove only directories whose lock can be acquired.

**Why:** Request cleanup cannot run after a hard kill, while PID checks can misclassify abandoned data after PID reuse and unconditional startup cleanup can delete another live worker's files.

**How to apply:** Use this pattern for private transient inputs on hosts where multiple worker processes may share a temporary filesystem. Startup must fail explicitly with sanitized diagnostics if stale data cannot be removed.