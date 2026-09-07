---
name: DiffRhythm upstream recovery
description: Non-obvious upstream CLI, tokenizer, MuQ, and English G2P traps that can suppress authentic DiffRhythm output.
---

Invoke pinned DiffRhythm source through a provider-owned Python adapter rather
than its boolean CLI path. Disable fake stereo as a Python boolean, initialize
the tokenizer in the global location lyric parsing reads, construct MuQ-MuLan
from pinned local config and weights, and pin the omitted English G2P dependency.

**Why:** The upstream CLI parses booleans with `type=bool`, so the string
`"False"` enables fake stereo; that branch contains unconditional debugger
breakpoints. Tokenizer setup assigns a local variable while downstream lyric
parsing reads a global. The pinned English G2P path imports `inflect` without
declaring it, and the installed Hub mixin did not match the pinned MuQ-MuLan
checkpoint layout.

**How to apply:** On any DiffRhythm source/runtime upgrade, inspect boolean
parsing and debugger paths before using the CLI, wire all model/tokenizer state
to explicit local paths, prohibit network resolution, and require a short real
CUDA generation before attempting the full fixture.