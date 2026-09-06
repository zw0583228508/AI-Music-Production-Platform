---
name: MT3 adapter compatibility
description: How to evaluate converted MT3 checkpoints against third-party adapter and Transformers compatibility claims.
---

Do not treat an MT3 adapter's declared Transformers range or import-only smoke
as proof that converted weights can infer. Require a non-silent real GPU smoke,
and prefer a coherent pre-rewrite model implementation plus the smallest exact,
build-failing compatibility correction over broad ad hoc model-internal edits.
Provider-family download commands must also be model-specific: aggregate
download commands can report partial success and contaminate isolated volumes.
Treat a zero-note transcription as a failed smoke even when inference exits
normally. For YourMT3, a sustained sine-only drone is not representative note
evidence; use a deterministic transient, decaying harmonic phrase with explicit
attacks/releases, and verify its pinned SHA-256 before inference. Live health
and release promotion must use the same bounded, terminated, hash-addressed
note-evidence validator before READY can be retained or signed.

**Why:** Declared compatibility and a successful import did not predict working
inference; runtime and model semantics still diverged. Only repeated real
inference on representative note attacks/releases exposed the complete
compatibility contract, while an unpinned fixture or a weaker release gate could
make the same model appear ready without preserving the required output.

**How to apply:** When changing the MT3 adapter, Transformers, Torch, or
converted checkpoint, rerun immutable bootstrap and real GPU transcription.
Bind the adapter/runtime decision, image/source identity, checkpoint lineage,
hash-guarded compatibility patch identity, and non-empty output into the same
promotion evidence. Require runtime fixture-hash comparison for reviewed local
smoke inputs. Explicit provisioning/bootstrap subprocesses must receive the
same pin; runner tests that inject it directly do not prove bootstrap
reproducibility. Keep each model family in a fresh provider-private volume.