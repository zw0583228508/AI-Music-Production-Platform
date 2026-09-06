---
name: Provider-audio arrangement semantics
description: Rules for selecting, exporting, and chaining provider-native audio when no symbolic tracks exist.
---

Provider-native audio is a valid arrangement result even when the provider returns no symbolic TrackModels. Keep that result explicitly audio-only: require verified audio plus complete quality evidence, do not fabricate MIDI or TrackModels, and export the provider WAV with its manifest and provenance. Mastering may append processing evidence, but must not replace the source provider/model identity.

**Why:** Source-only ACE-Step projects can produce real, high-quality audio without any defensible symbolic note evidence. Empty MIDI would look like a successful musical artifact while containing no real performance.

**How to apply:** Symbolic candidates still require canonical TrackModels and MIDI evidence. Audio-only candidates require provider-ingested WAV evidence and a quality report. Keep mastering identity in separate processing evidence while retaining source parents and generation identity. LEGO/REPAINT may consume a prior private provider WAV only through same-project checks, a constrained signed URL, and explicit source-artifact parent lineage.