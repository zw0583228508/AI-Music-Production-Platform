---
name: Licensed native render attestation
description: Trust boundary for attributing exports to licensed VST3 or SFZ instruments.
---

Never treat endpoint configuration, audible audio, or TrackModel-sensitive output alone as proof that a licensed native instrument rendered a track. Readiness must bind the canonical request, event counts, selected asset identity and checksum, approved host identity and checksum, and output checksum; exports must preserve that evidence.

**Why:** A native host can react to note and expression changes while still ignoring the selected plugin or sample library, producing convincing but falsely attributed synthetic audio.

**How to apply:** Require matching health/smoke evidence before each native render, reject request/output checksum mismatches and other unattested responses, validate audio quality and lineage, and retain deterministic samples whenever any binding fails. If native audio is transformed locally, preserve separate checksums for the provider-returned audio and the exact exported bytes; never present an intermediate checksum as proof of the downloadable stem.

Native-code installation is a separate trust boundary from studio administration. Uploaded hosts and VST3 assets must match preapproved identities and checksums before execute permission, plugin loading, or smoke verification; admin status alone never grants native-code execution.

**Why:** A legitimate studio administrator account can still be compromised, and an upload form that directly executes arbitrary host bytes turns that compromise into worker code execution.

**How to apply:** Keep host approval outside the upload request, require authentication to fail closed on administration endpoints, and make the atomically replaced licensed manifest the authoritative activation commit under a cross-process lock.
