---
name: Canonical musical timeline consumers
description: Durable rules for keeping edited Song Models and rendered/exported events on one tempo and meter timeline.
---

Any edit that changes a v2 Song Model tempo map, meter map, or timed event must regenerate all dependent coordinates before persistence and validate the complete canonical model.

**Why:** Keeping old coordinates after a tempo or meter correction creates internally contradictory records even when each edited field is valid by itself.

**How to apply:** Route correction, import, and migration paths through the same canonicalization authority used by initial analysis.

Every tick calculation derived from a meter must account for both numerator and denominator; a bar is `numerator × PPQ × 4 ÷ denominator` ticks.

**Why:** Numerator-only math silently puts compound and non-quarter-note meters such as 6/8 on a different timeline from analysis.

**How to apply:** Reuse canonical bar conversion in planners, renderers, performance generation, export duration, and tests rather than duplicating quarter-note assumptions.