---
name: MIR runtime isolation
description: Runtime and licensing constraints for the isolated MIR provider stack.
---

Keep Madmom-Infer, TorchCREPE, and pyloudnorm in a Python 3.11 image; keep Essentia and Essentia-backed Chroma in a separate Python 3.14 image.

**Why:** Essentia 2.1b6.dev1438 currently provides a CPython 3.14 wheel, while the exact Madmom/TorchCREPE stack is validated on Python 3.11. Forcing both into one environment caused unsatisfiable or source-built dependencies.

**How to apply:** Preserve separate deployment, volume, health, and smoke-proof boundaries. Do not solve compatibility by changing required provider versions.

SheetSage handcrafted weights are CC BY-NC-SA 3.0 and its Madmom downbeat weights are CC BY-NC-SA 4.0, even though package code is MIT.

**Why:** The production platform must not silently accept noncommercial/share-alike model terms.

**How to apply:** Keep SheetSage BLOCKED until the owner explicitly confirms eligible use and accepts those terms, or supplies commercially compatible licensed assets.