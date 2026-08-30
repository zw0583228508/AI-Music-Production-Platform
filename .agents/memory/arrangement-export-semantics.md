---
name: Arrangement export semantics
description: Product-truth requirements for deterministic arrangement renders before real model providers are connected.
---

Deterministic or preview renderers must derive audio and MIDI behavior from the selected arrangement’s sections, track activation, energy, density, harmony controls, meter, and tempo. Audio and MIDI must share one arrangement timeline: silent trailing sections still count, while note releases may extend audio beyond the arrangement boundary.

**Why:** A structurally valid WAV or MIDI file is misleading if two materially different arrangements render the same timeline. Preview technology may be limited, but the export must remain semantically tied to the user’s creative decisions.

**How to apply:** Any replacement or extension of the renderer should preserve section-aware timing, section track gates, mute/solo intent, a common MIDI/WAV endpoint, and unique per-track outputs. Provider-backed rendering may improve sound quality without weakening these guarantees.