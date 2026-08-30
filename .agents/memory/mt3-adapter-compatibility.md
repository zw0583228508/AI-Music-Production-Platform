---
name: MT3 adapter compatibility
description: How to evaluate converted MT3 checkpoints against third-party adapter and Transformers compatibility claims.
---

Do not treat an MT3 adapter's declared Transformers range or import-only smoke
as proof that converted weights can infer. Require a non-silent real GPU smoke,
and prefer a coherent pre-rewrite model implementation plus the smallest exact,
build-failing compatibility correction over broad ad hoc model-internal edits.

**Why:** Declared compatibility and a successful import did not predict working
inference; runtime and model semantics still diverged. Only repeated real
inference exposed the complete compatibility contract.

**How to apply:** When changing the MT3 adapter, Transformers, Torch, or
converted checkpoint, rerun immutable bootstrap and real GPU transcription.
Bind the adapter/runtime decision, image/source identity, checkpoint lineage,
and non-empty output into the same promotion evidence.