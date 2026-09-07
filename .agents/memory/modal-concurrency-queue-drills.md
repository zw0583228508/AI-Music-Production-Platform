---
name: Modal concurrency queue drills
description: How to prove live queueing rather than merely per-container concurrency or horizontal scaling.
---

Modal `max_inputs` limits concurrent inputs per container, not across the function fleet. A burst above that value does not prove queueing unless the drill also constrains total containers or otherwise attests a fleet-wide boundary.

**Why:** Modal may satisfy an over-cap burst by starting another container, making every request succeed without any request waiting behind the intended memory-derived cap.

**How to apply:** For release queue drills, constrain the drill function to one container, bind evidence to the separate app/deployment/function/runtime image, fence identity before and after execution, and verify from safe timing fields that an over-cap request starts after an earlier request finishes.