---
name: BS-RoFormer adapter contract
description: The verified inference surface and no-download constraint for bs-roformer-infer 0.1.5.
---

Use `bs_roformer.inference.proc_folder` with both the local checkpoint and config
paths. Do not assume the distribution exposes a `BSRoformerSession` API, and do
not omit either path.

**Why:** The `bs-roformer-infer==0.1.5` distribution installs the
`bs_roformer` package and its folder runner. Omitting explicit asset paths
activates the package's first-use model downloader, which violates immutable
pre-staging and makes health provenance unreliable.

**How to apply:** When changing the BS-RoFormer adapter or version, inspect the
installed package surface and run real GPU smoke. Continue passing both paths
and attest both files before invoking inference.