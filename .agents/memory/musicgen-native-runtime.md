---
name: MusicGen native runtime
description: Native build compatibility for the exact pinned AudioCraft MusicGen environment.
---

Treat installation of the pinned AudioCraft source as a native build, not a pure Python package install. Include a compiler, pkg-config, and FFmpeg development headers.

**Why:** AudioCraft's exact dependency set compiles PyAV 11 and PESQ from source. FFmpeg 4.2 lacks the codec capability symbols PyAV 11 expects, while FFmpeg 4.4 remains compatible with the upstream recommendation to stay below version 5.

**How to apply:** Use the CUDA 11.8 Ubuntu 22.04 runtime for FFmpeg 4.4, and verify native extension compilation before downloading multi-gigabyte model snapshots.