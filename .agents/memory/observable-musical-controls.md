---
name: Observable musical controls
description: Rules for exposing arrangement controls, evidence, and processing readiness without schema-only or smoke-only claims.
---

Any producer-facing musical control must travel through the typed canonical model and cause an observable, deterministic change in the arrangement plan, TrackModels, performance events, or shipped audio. A schema field or persisted parameter alone is not implementation.

**Why:** Controls can appear functional in Studio while being discarded during materialization, and analysis evidence can appear supported while being dropped before generation. Smoke-tested audio processing can likewise look ready without touching exported bytes.

**How to apply:** Test the complete path from real provider evidence or UI input through normalization, persistence, generation, and export. Readiness for an audio processor requires final-byte evidence and fail-closed authentication, not only import or health smoke results.