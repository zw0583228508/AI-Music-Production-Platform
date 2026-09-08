---
name: Groove vocal-space evidence
description: How phrase-aware groove must combine silent-space and voiced-occupancy observations.
---

Treat detected arrangement space and measured vocal occupancy as independent evidence streams. Never let one replace the other, and keep measured occupancy active through performance timing for tracks governed by a shared groove plan.

**Why:** A rhythm event can be canonically placed outside voice, then deterministic performance timing can move it across the boundary. Arrangement-space detection can also exist when phrase detection is unavailable, without invalidating separately measured voiced windows.

**How to apply:** Merge canonical silent and voiced observations without inferring either as the complement of the other. Bound fills to exact silent ranges, then re-check measured voice after timing offsets. Preserve historical behavior for plans that do not opt into shared groove semantics.