---
name: Perceptual audio evidence gates
description: Rules for using rendered-audio criticism in ranking, repair, and release decisions.
---

Perceptual audio confidence must be derived from the exact persisted audio bytes and an explicit channel/frame layout. Master-only analysis may support technical dimensions, but masking, balance, vocal attribution, and track attribution must abstain unless verified stems or rendered per-track PCM support them.

**Why:** Full-mix loudness proxies can look plausible while fabricating unsupported perceptual confidence, and incorrect stereo frame handling can shift findings and repair scopes to the wrong musical time.

**How to apply:** Bind critic evidence hashes to the persisted audio artifact, validate vocal provenance and windows against rendered duration, derive repair scopes from persisted server-authored findings, and rank provider preference only after sufficient audio and symbolic evidence.