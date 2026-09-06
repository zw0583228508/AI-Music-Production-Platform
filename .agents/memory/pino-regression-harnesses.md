---
name: Pino regression harnesses
description: How to exercise serialized Pino output in standalone API test harnesses without worker-loader failures.
---

Standalone logger regression harnesses should bundle the application logger while leaving `pino` and its transports external, then emit the temporary harness inside the API package tree.

**Why:** Rebundling Pino in a one-off test also pulls in its worker entry points and loader assumptions. A harness emitted under `/tmp` cannot resolve package-local external dependencies, while a package-local temporary module uses normal Node resolution and tests the real serialized output.

**How to apply:** For focused tests that spawn the logger in a child process, keep Pino external and place the generated module beside the package tests. Use the production logger build only when testing the full server bundle.

Recursive formatter redaction must sanitize into a cycle-safe copy rather than mutate the logged value, and it must traverse enumerable fields on custom-prototype wrappers as well as plain objects and arrays.

**Why:** In-place sanitization can corrupt caller state or throw on frozen data, while skipping custom instances leaves a structural path for private values to reach serialized logs.

**How to apply:** Regression fixtures for deep redaction should include arrays, frozen nested values, caller-state assertions, and a custom class instance with both sensitive and benign enumerable fields.

Pino's `formatters.bindings` does not sanitize application context supplied later through `logger.child()`. Persistent child context must be sanitized before child creation, and that protection must carry forward to children created from children.

**Why:** Payload formatting and initial binding formatting can appear to provide a complete privacy boundary while provider metadata persisted on child loggers bypasses both paths.

**How to apply:** Treat `child()` as its own serialization boundary. Sanitize a cycle-safe copy of bindings before delegating to Pino, and apply the same protected child factory to every returned logger.

Pino redaction wildcards such as `*.accessToken` do not cover an `accessToken` property at the root of a log record.

**Why:** Structured logging helpers may spread arbitrary metadata directly into the root record, so wildcard-only policies can leave the same sensitive alias exposed in a common alternate shape.

**How to apply:** When using Pino path redaction, register both the bare field name and its wildcard path. With recursive formatter redaction, exercise both root and nested serialized shapes. Keep logging-only helpers free of database imports so focused harnesses can test their real behavior.

Recursive Pino formatters must serialize `Error` instances explicitly and prevent the default `err` serializer from reprocessing the sanitized plain object.

**Why:** Error diagnostics are non-enumerable and disappear during ordinary object traversal; a later default serializer can also relabel an already serialized error as `Object`.

**How to apply:** Use Pino's standard Error serializer inside the recursive sanitizer, configure the root `err` serializer as an identity pass, and assert type, message, stack, and redacted enumerable metadata in serialized output.
