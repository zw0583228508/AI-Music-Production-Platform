---
name: Modal container path portability
description: Path and local-file rules for Python modules imported from Dockerfile-backed Modal images.
---

Python configuration modules used both by the local Modal CLI and inside a
Dockerfile image must not assume a fixed number of repository parents. Modal
can import the same module from a flat `/app` path. Local smoke fixtures should
be added through the image local-file API supported by the installed SDK,
rather than legacy mount APIs. When a derived image changes a module already
embedded under `/app`, overlay that module and every changed local module it
imports into the image; a host source mount does not reliably win import
precedence. Managed ASGI loading may also use Modal's interpreter rather than a
worker virtualenv, so expose the virtualenv site-packages through `PYTHONPATH`.

**Why:** A fully built GPU image failed before function execution because its
repo-root calculation indexed a nonexistent parent under `/app`; the installed
Modal SDK also no longer exposed the legacy mount class.
An operator verifier repeatedly imported stale modules from the base image even
though Modal reported source mounts, and managed ASGI loading could not see
FastAPI installed only in the isolated virtualenv.

**How to apply:** Make repository-root discovery valid in both layouts, keep
worker-root paths container-local, and verify the installed SDK signature
before wiring local fixtures into a Modal function. For immutable derived
images, copy changed `/app` modules explicitly and test imports through the same
interpreter Modal uses to hydrate the function. Include every overlay and its
local imports in the source-identity digest so promotion evidence represents
the runnable module set.