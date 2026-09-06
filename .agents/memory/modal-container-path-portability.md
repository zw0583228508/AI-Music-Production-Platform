---
name: Modal container path portability
description: Path and local-file rules for Python modules imported from Dockerfile-backed Modal images.
---

Python configuration modules used both by the local Modal CLI and inside a
Dockerfile image must not assume a fixed number of repository parents. Modal
can import the same module from a flat `/app` path. Local smoke fixtures should
be added through the image local-file API supported by the installed SDK,
rather than legacy mount APIs.

**Why:** A fully built GPU image failed before function execution because its
repo-root calculation indexed a nonexistent parent under `/app`; the installed
Modal SDK also no longer exposed the legacy mount class.

**How to apply:** Make repository-root discovery valid in both layouts, keep
worker-root paths container-local, and verify the installed SDK signature
before wiring local fixtures into a Modal function.