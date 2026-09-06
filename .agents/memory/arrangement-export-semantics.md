---
name: Arrangement export semantics
description: Product-truth requirements for deterministic arrangement renders before real model providers are connected.
---

Deterministic or preview renderers must derive audio and MIDI behavior from the selected arrangement’s sections, track activation, energy, density, harmony controls, meter, and tempo. Audio and MIDI must share one arrangement timeline: silent trailing sections still count, while note releases may extend audio beyond the arrangement boundary. Historical arrangements must resolve their exact recorded Song Model version and derive musical globals from it; never fall back to the newest model.

**Why:** A structurally valid WAV or MIDI file is misleading if two materially different arrangements render the same timeline. Preview technology may be limited, but the export must remain semantically tied to the user’s creative decisions.

**How to apply:** Any replacement or extension of the renderer should preserve section-aware timing, section track gates, mute/solo intent, a common MIDI/WAV endpoint, unique per-track outputs, and exact Song Model lineage. Package manifests must keep PREMASTER distinct from final MIX and MASTER files so processing evidence cannot imply that an unprocessed intermediate was mastered. If the referenced model version is missing, fail explicitly rather than mixing historical arrangement data with mutable project metadata. Provider-backed rendering may improve sound quality without weakening these guarantees.