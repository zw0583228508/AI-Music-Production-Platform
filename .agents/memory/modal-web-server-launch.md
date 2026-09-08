---
name: Modal web-server launch
description: Correct process lifecycle for Modal web_server functions that launch a separate runtime.
---

Functions decorated with Modal `web_server` must launch the HTTP process non-blockingly and then return; they must not wait on the child process. Application startup hooks must also open the port before doing long verification.

**Why:** A worker can print that Uvicorn is listening and still never receive routed traffic if the decorated function waits on the child. Modal also terminates Uvicorn when a long startup hook prevents the port from accepting connections before its short startup timeout.

**How to apply:** Spawn the isolated runtime with a detached/non-blocking process call and return. Run long integrity warmups behind a shared lock after the port opens; readiness and work must wait on that lock. Confirm a routed authenticated request instead of trusting startup logs.