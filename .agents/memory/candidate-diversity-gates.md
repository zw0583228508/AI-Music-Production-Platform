---
name: Candidate diversity gates
description: Rules for deterministic candidate strategies, musical fingerprints, and duplicate rejection.
---

Candidate diversity must be measured from canonical musical structure: section track activation, energy/density, harmony, and TrackModel shape. Provider labels, prose, and scores are not diversity evidence. Candidate strategies and derived seeds must remain stable across retries and recovery.

Candidates below the diversity threshold remain auditable and previewable, but cannot be ranked or selected. Provider preference scores never override diversity rejection, and the system must report insufficient diversity instead of silently synthesizing replacements or auto-selecting the first candidate.

Only candidates with complete, non-failed quality evidence may enter diversity comparison or become a baseline. Musical fingerprints are internal evaluation material; public contracts may expose the decision and distance, but not the fingerprint contents.

**Why:** Multiple nominal candidates can otherwise represent the same arrangement with trivial metadata or score differences, creating false choice and allowing provider confidence to masquerade as musical variety.

**How to apply:** Any new generation provider, critic, repair loop, or ranking rule must preserve the base-seed/derived-seed identity, extend canonical fingerprints only with musical evidence, admit only quality-eligible baselines, redact fingerprints from public responses, and keep rejected near-duplicates outside selection.