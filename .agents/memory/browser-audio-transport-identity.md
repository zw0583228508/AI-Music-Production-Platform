---
name: Browser audio transport identity
description: Rules for stable browser media control and preventing source/timeline drift.
---

Keep one browser media element lifecycle for the mounted workspace, and make transport commands consult the media element's actual paused state. Bind every playback request to the same explicit source identity used for duration and timeline data.

**Why:** Recreating media instances from changing metadata made pause behavior unreliable, while independently choosing a project-wide “latest” audio artifact could audition a different upload when analyses completed out of order.

**How to apply:** When adding previews or alternate playback sources, switch the existing transport's source deliberately, carry the source identity through the request, and resolve derived audio only through that source's lineage. Never infer playback identity from project-wide artifact recency.