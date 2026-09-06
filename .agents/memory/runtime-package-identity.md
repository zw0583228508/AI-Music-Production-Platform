---
name: Runtime package identity
description: How readiness evidence must cryptographically bind installed provider code to pinned upstream provenance.
---

Provider readiness must verify a deterministic hash of the installed executable package tree and bind it to a checksummed package artifact whose relevant source files match the pinned upstream revision. Version metadata and manifest fields alone are not runtime identity.

**Why:** A worker can truthfully report the expected package version while executing altered or differently built bytes. Returning source and license fields copied from a manifest only proves that the manifest is present, not that the running implementation derives from that source.

When a package bundles models for multiple inference backends, the model identity must hash the exact backend path passed to inference. Verifying a neighboring ONNX file does not attest a TensorFlow SavedModel used by the production call.

**How to apply:** For provider installation evidence, retain the package artifact hash and source comparison, compute the installed package-tree hash at health time, hash the actual inference checkpoint tree, require both in API attestation, and recheck the same identities immediately before accepting private source data for inference.