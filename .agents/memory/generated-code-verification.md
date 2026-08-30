---
name: Generated-code verification
description: Vite behavior to account for when regenerating shared API client files during a running preview.
---

Regenerating shared API client files while Vite is serving the app can briefly produce missing-module and HMR errors in the browser, even when the generated files are correct.

**Why:** The generator cleans and rewrites the generated output directory, while the live dev server can observe that short replacement window.

**How to apply:** Restart the affected frontend workflow after code generation and before running browser verification; treat pre-restart HMR errors as transient unless they reproduce after the clean restart.

After a task merge changes shared workspace libraries, run the root workspace typecheck before package-local typechecks.

**Why:** A package-local TypeScript run can read stale declaration output from a shared library and report missing exports or columns that already exist in current source.

**How to apply:** Use the root typecheck to rebuild project references first; only treat package-local errors as current after shared declarations have been refreshed.