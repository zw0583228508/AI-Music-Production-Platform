---
name: Codec threshold fixtures
description: How to exercise lossy audio codecs reliably in source-copy threshold tests.
---

Round-trip codec fixtures through FFmpeg and compare the decoded PCM, rather
than asking SoundFile/libsndfile to open every encoded container directly.

**Why:** The worker FFmpeg provides AAC encoding and decoding, but its
libsndfile build does not recognize either M4A or raw ADTS AAC. Direct reads
therefore fail before the source-copy metric can measure codec loss.

**How to apply:** For threshold corpus additions, encode with the worker's
named FFmpeg encoder, decode the artifact to WAV with FFmpeg, and pass that PCM
to waveform comparison. Keep a container artifact long enough to prove the
real codec path was exercised.