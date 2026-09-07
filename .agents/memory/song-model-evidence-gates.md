---
name: Song Model evidence gates
description: Trust rules for deciding when analyzer output is valid enough to enter the canonical Song Model.
---

Musical fields must only be populated when their detector has meaningful signal evidence. Decoded duration, sample count, nonzero numerical residue, or template assumptions are not valid evidence; unavailable or failed fields must keep empty maps.

User corrections create a new immutable Song Model version and must recompute canonical validation from the corrected data. A new version must not inherit stale issues for fields the correction repaired.

Canonical reconciliation is capability-specific: provider reliability for tempo, meter, key, melody, and harmony must be calibrated independently. Repeated observations from one provider count as one source, not independent corroboration. Close unsupported conflicts must abstain and lower field availability/confidence instead of choosing the loudest provider.

Vocal occupancy and arrangement space are observations from decoded, verified vocal-stem PCM only. Melody gaps, lyric gaps, section templates, and source duration must never be relabeled as breaths or silence. Arrangement changes must be evidence-gated and no-op when vocal evidence is unavailable.

**Why:** Silent, near-silent, and DC-like audio can otherwise receive high confidence from duration alone and produce arbitrary tempo, key, energy, or section values that look authoritative in the inspector.

**How to apply:** Gate each detector on field-specific evidence, reconcile distinct providers with domain-specific reliability and deterministic margins, and label inferred/template structure as low-confidence. Preserve explicit failed or not-available states through the API and UI. After corrections, preserve provider provenance but regenerate validation status and issues from the complete corrected model.