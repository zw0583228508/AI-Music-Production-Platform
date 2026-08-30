---
name: Versioned editor rehydration
description: Reliability rule for local, autosaved arrangement edits in the producer workspace.
---

Treat the accepted server revision as the source of truth for every autosaved editor document. Keep the UI dirty until the write succeeds, then rehydrate the active section and track from the returned revision. If the expected version conflicts, pause autosave and require an explicit choice between loading the latest revision and applying the local edit on top of it.

**Why:** A successful version increment can coexist with stale component state if note, chord, or automation arrays remain in memory. This makes reloads appear to resurrect deleted events even when the API stored the correct result.

**How to apply:** For any local arrangement mutation, send an expected-version precondition, await the acknowledgment before showing “synced,” update the cached revision, and refresh contextual editor state from that accepted payload. Track local edit generations so an older in-flight acknowledgment cannot clear or overwrite newer unsaved work.