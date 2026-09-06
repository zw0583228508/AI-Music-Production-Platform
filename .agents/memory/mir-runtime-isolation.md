---
name: MIR runtime isolation
description: Runtime and licensing constraints for the isolated MIR provider stack.
---

Keep Madmom-Infer, TorchCREPE, and pyloudnorm in a Python 3.11 image; keep Essentia and Essentia-backed Chroma in a separate Python 3.14 image.

**Why:** Essentia 2.1b6.dev1438 currently provides a CPython 3.14 wheel, while the exact Madmom/TorchCREPE stack is validated on Python 3.11. Forcing both into one environment caused unsatisfiable or source-built dependencies.

**How to apply:** Preserve separate deployment, volume, health, and smoke-proof boundaries. Do not solve compatibility by changing required provider versions.

SheetSage handcrafted weights are CC BY-NC-SA 3.0 and its Madmom downbeat weights are CC BY-NC-SA 4.0, even though package code is MIT.

**Why:** The production platform must not silently accept noncommercial/share-alike model terms.

**How to apply:** The owner explicitly confirmed this project is non-commercial and accepted those SheetSage terms. Keep it BLOCKED only while the exact licensed assets remain inaccessible or unverified.

The owner also confirmed the project is non-commercial for MusicGen's CC BY-NC 4.0 weights.

**Why:** Weight installation must not infer license eligibility from package installation alone.

**How to apply:** MusicGen provisioning may use its separately recorded acceptance, but exact immutable model revisions and real smoke evidence are still mandatory before READY.

SheetSage's upstream asset table mixes checksum algorithms: its 40-character config checksums are SHA-1 identities, while provider readiness requires independently computed SHA-256 values.

**Why:** Treating the upstream SHA-1 strings as SHA-256 made two authentic handcrafted config files appear corrupt even though they matched the source package exactly.

**How to apply:** Verify upstream identity with the algorithm implied by its checksum length, then record and enforce SHA-256 separately in the local manifest.

Persistent MIR smoke proofs must be signed and bind the asset manifest, fixture, output, local runtime files, and actual installed distribution contents without process caching.

**Why:** A mutable volume proof or version-only runtime identity can survive a code or same-version package substitution and falsely preserve READY status.

**How to apply:** Recompute the runtime fingerprint on every readiness check and require a fresh real-inference proof whenever any bound input changes.
