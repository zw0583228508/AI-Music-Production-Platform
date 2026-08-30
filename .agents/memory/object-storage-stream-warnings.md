---
name: Object Storage stream warnings
description: Replit Object Storage download streams can exceed Node's default listener warning threshold during successful media analysis.
---

Object Storage download streams may emit `MaxListenersExceededWarning` for a `PassThrough` when provider retry handling and consumer pipeline handling attach listeners to the same stream. Treat this as non-fatal only when the object fully downloads and downstream processing completes.

**Why:** Multiple source-ingestion E2E runs completed upload, FFmpeg analysis, database writes, and Song Model readiness while the warning remained across buffered and streamed download approaches.

**How to apply:** Do not raise the process-wide listener limit or hide all warnings. If this becomes operationally significant, trace and isolate the provider stream wrapper; continue treating actual stream errors or incomplete files as failures.