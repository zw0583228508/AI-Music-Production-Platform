---
name: Structure-model smoke evidence
description: How to create honest structure-analysis smoke inputs and canonicalize leading pickup beats.
---

Structure-model smoke fixtures must contain sustained, multi-bar rhythmic and harmonic evidence. A non-silent pure tone is not sufficient evidence of working beat, bar, tempo, or section inference.

If the model begins its output on a pickup beat, discard only the leading partial bar and start the canonical grid at the first model-detected downbeat. Never invent missing beats or reject otherwise valid evidence solely because the first detected position is not beat one.

**Why:** Real All-In-One GPU inference on a short sine wave returned no BPM or beats. A deterministic multi-section click/chord fixture produced stable tempo, beat, bar, and section evidence, while legitimately beginning on a pickup position.

**How to apply:** Use this rule for real smoke tests and normalization around music-structure models. Require at least one detected downbeat and preserve all evidence from the first complete bar onward.