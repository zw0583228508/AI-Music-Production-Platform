---
name: Licensed native render attestation
description: Trust boundary for attributing exports to licensed VST3 or SFZ instruments.
---

Never treat endpoint configuration, audible audio, or TrackModel-sensitive output alone as proof that a licensed native instrument rendered a track. Readiness must bind the canonical request, event counts, selected asset identity and checksum, approved host identity and checksum, and output checksum; exports must preserve that evidence.

**Why:** A native host can react to note and expression changes while still ignoring the selected plugin or sample library, producing convincing but falsely attributed synthetic audio.

**How to apply:** Require matching health/smoke evidence before each native render, reject request/output checksum mismatches and other unattested responses, validate audio quality and lineage, and retain deterministic samples whenever any binding fails. If native audio is transformed locally, preserve separate checksums for the provider-returned audio and the exact exported bytes; never present an intermediate checksum as proof of the downloadable stem.

Production readiness must additionally bind the performed-material digest to the exact canonical tempo, meter, bar, phrase, and section evidence used to create it. Generic local synthesis remains explicitly preview-only.

**Why:** Matching native asset checksums can still certify the wrong musical performance when saved edits or canonical phrase/timeline changes leave stale evidence attached to a TrackModel.

**How to apply:** Recompute performed-material evidence after edits; compare phrase IDs, section ranges, timeline digest, MIDI digest, and native render digest before claiming production readiness. Unsupported mapped timelines must remain preview-only rather than receiving partial certification.

Native-code installation is a separate trust boundary from studio administration. Uploaded hosts and VST3 assets must match preapproved identities and checksums before execute permission, plugin loading, or smoke verification; admin status alone never grants native-code execution.

**Why:** A legitimate studio administrator account can still be compromised, and an upload form that directly executes arbitrary host bytes turns that compromise into worker code execution.

**How to apply:** Keep host approval outside the upload request, require authentication to fail closed on administration endpoints, and make the atomically replaced licensed manifest the authoritative activation commit under a cross-process lock.

Instrument-pack rotation history must be committed inside the same atomically replaced manifest as the active selection; auxiliary state files are mirrors only. Activation and rollback must fail closed when an existing manifest cannot be read or parsed.

**Why:** Committing the active selection and history in separate files allows a crash or mirror-write failure to activate new bytes while permanently losing the previous verified version.

**How to apply:** Archive the outgoing pack and select the incoming pack in one manifest replacement, revalidate historical bytes and smoke evidence before rollback, and never treat a corrupt manifest as a first install.
