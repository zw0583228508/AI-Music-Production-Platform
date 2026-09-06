---
name: Protected release proposals
description: External repository constraints and recovery rules for reviewed GPU activation pull requests.
---

Keep GPU activation behind an enforced pull-request review, including for repository administrators. A rejected or closed proposal must leave canonical promotion files unchanged, and recovery must reuse the original one-commit, canonical-files-only activation branch and retained signed evidence rather than deploying again. Candidate deployments require separate identity, runtime credentials, and mutable storage from production.

**Why:** Repository protection and GitHub Actions pull-request permissions live outside the codebase. A real drill found that both must be enabled before a validated release can create and merge its proposal; regenerating a release after rejection would defeat the identity proof.

**How to apply:** Before a release, verify the default branch requires one approval with admin enforcement and that Actions may create pull requests. For recovery, cryptographically verify the retained bundle, bind its public key to the generated API record, and require the complete evidence, attestation, and source revision to reproduce the activation branch exactly before reopening the same proposal.