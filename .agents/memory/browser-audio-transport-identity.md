---
name: Browser audio transport identity
description: Rules for stable browser media control and preventing source/timeline drift.
---

Keep one browser media element lifecycle for the mounted workspace, and make transport commands consult the media element's actual paused state. Bind every playback request to the same explicit source identity used for duration and timeline data. For A/B source changes, carry the current timestamp forward and clamp it to the new source's duration rather than resetting the comparison to zero.

Treat each asynchronous `play()` call as an invalidatable attempt. Pause, stop, retry, source changes, and unmount must supersede that attempt so its later rejection cannot overwrite the intentional transport state.

**Why:** Recreating media instances from changing metadata made pause behavior unreliable, while independently choosing a project-wide “latest” audio artifact could audition a different upload when analyses completed out of order. Browsers can also emit `play` before the `play()` promise settles; an immediate user pause then rejects that promise with `AbortError`, which must not become a playback failure.

**How to apply:** When adding previews or alternate playback sources, switch the existing transport's source deliberately, carry the source identity through the request, and resolve derived audio only through that source's lineage. Never infer playback identity from project-wide artifact recency. Preserve errors only for the currently active play attempt.