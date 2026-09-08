---
name: Closed-world release verification
description: Why master production release reports must use an explicit stage manifest and strict evidence allowlists.
---

Production completion verification must use a closed-world manifest of required stages. Missing stages, missing artifact evidence, malformed provenance, or failed invariants block release; an empty or caller-defined capability set can never pass.

**Why:** A self-reported matrix can appear complete while silently omitting the exact stage whose evidence is absent. Free-form report fields can also turn an audit artifact into a privacy leak.

**How to apply:** Require exact evidence digests and bounded identifiers for every required stage, allowlist optional abstentions, derive the report ID from all evidence inputs, and serialize only explicitly public fields.