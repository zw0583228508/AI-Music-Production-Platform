---
name: Pino regression harnesses
description: How to exercise serialized Pino output in standalone API test harnesses without worker-loader failures.
---

Standalone logger regression harnesses should bundle the application logger while leaving `pino` and its transports external, then emit the temporary harness inside the API package tree.

**Why:** Rebundling Pino in a one-off test also pulls in its worker entry points and loader assumptions. A harness emitted under `/tmp` cannot resolve package-local external dependencies, while a package-local temporary module uses normal Node resolution and tests the real serialized output.

**How to apply:** For focused tests that spawn the logger in a child process, keep Pino external and place the generated module beside the package tests. Use the production logger build only when testing the full server bundle.