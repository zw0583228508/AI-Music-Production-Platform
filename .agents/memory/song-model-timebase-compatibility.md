---
name: Song Model timebase compatibility
description: Canonical timing resolution and the compatibility rule for historical Song Models and TrackPerformance data.
---

New canonical Song Models use contract version 2.0 with an explicit 960 PPQ timebase. TrackPerformance data carries its own PPQ so rendering, MIDI export, and seconds conversion share one interpretation.

Historical Song Model 1.0 records remain valid. Historical TrackPerformance data without an explicit PPQ must be interpreted at 480 PPQ rather than silently stretched onto the new grid.

V2 coordinates must be derived through one tempo/meter-aware conversion authority. Timestamped or bar-bounded evidence may receive seconds, tick, beat, bar, and beat-in-bar coordinates; untimestamped sample arrays must remain untimed rather than receiving index-derived positions.

**Why:** The original system mixed seconds, bars, beats, and an implicit 480-tick export grid. Reinterpreting persisted ticks at 960 would halve historical playback and export durations.

**How to apply:** Require the canonical timebase and consistent coordinates on v2 validation and write 960 on newly generated performances. At every tick-to-time or MIDI boundary, use the performance's declared PPQ and apply 480 only when the field is absent. Never synthesize coordinates without field-specific timing evidence.