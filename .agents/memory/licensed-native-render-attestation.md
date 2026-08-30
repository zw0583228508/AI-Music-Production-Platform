---
name: Licensed native render attestation
description: Trust boundary for attributing exports to licensed VST3 or SFZ instruments.
---

Never treat endpoint configuration, audible audio, or TrackModel-sensitive output alone as proof that a licensed native instrument rendered a track. Readiness must bind the canonical request, event counts, selected asset identity and checksum, approved host identity and checksum, and output checksum; exports must preserve that evidence.

**Why:** A native host can react to note and expression changes while still ignoring the selected plugin or sample library, producing convincing but falsely attributed synthetic audio.

**How to apply:** Require matching health/smoke evidence before each native render, reject unattested responses, validate audio quality and lineage, and retain the deterministic renderer whenever any binding fails.