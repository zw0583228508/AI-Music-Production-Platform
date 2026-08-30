# Music AI capability matrix

This project distinguishes installed packages, configured endpoints, and verified
providers. A provider is `ready` only after its runtime and checkpoint load,
its model version and checkpoint checksum are known, and a real smoke inference
has completed successfully.

## Verified local CPU stack

| Provider/runtime | Capability | Version/checkpoint | Current state | Readiness proof |
| --- | --- | --- | --- | --- |
| Basic Pitch | Polyphonic audio-to-MIDI transcription | `basic-pitch 0.4.0`, ICASSP 2022 ONNX checkpoint | Ready on CPU after worker smoke test | Real 440 Hz WAV inference returns ordered note events; ONNX checkpoint loads and executes with `CPUExecutionProvider` |
| Demucs | Vocal/instrumental source separation | `demucs 4.0.1`, `htdemucs` checkpoint `955717e8-8726e21a.th` | Ready on CPU after worker smoke test | Real two-second stereo WAV inference writes distinct `vocals` and `no_vocals` stems |
| ONNX Runtime | Local checkpoint execution | `onnxruntime 1.29.0` | Ready on CPU | Basic Pitch ONNX graph loads and executes with the CPU provider |
| Pedalboard built-ins | Compressor, gain, limiter, and mastering effects | `pedalboard 0.9.24` | Ready on CPU | Real floating-point audio is processed and validated for shape, finite samples, and output peak |
| Local symbolic director and expressive synth | Arrangement, MIDI, and deterministic audio rendering | Built into the TypeScript API | Ready on CPU | Existing arrangement, quality, lineage, and export suites |

Model packages and exact transitive versions are locked in `uv.lock`. Large
downloaded checkpoints live in the ignored runtime cache and are validated
against the manifest before readiness is reported; they are not committed to
Git.

## Installed but blocked by missing assets or hardware

| Provider/runtime | State | What is missing |
| --- | --- | --- |
| Pedalboard VST3 | Blocked until attested | A compatible, licensed VST3 binary and approved native MIDI host in a private worker asset mount, manifest checksums/license ownership, and a canonical TrackModel smoke render with asset/host/output attestation. Pedalboard built-ins do not make the VST3 provider ready. |
| sfizz / VSCO2 CE | Blocked until attested | An approved native sfizz host and verified SFZ library in a private worker asset mount, manifest checksums/license ownership, and a canonical TrackModel smoke render with asset/host/output attestation. |
| ACE-Step base / complete | GPU worker implemented; deployment blocked | Pin and mount the licensed/approved checkpoint SHA-256, install the ACE-Step runner, allocate CUDA hardware, enable the provider, and pass real smoke inference. |
| MusicGen | GPU worker implemented; deployment blocked | Pin and mount the AudioCraft checkpoint SHA-256, install the MusicGen runner, allocate CUDA hardware, enable the provider, and pass real smoke inference. |
| BS-RoFormer | GPU worker implemented; deployment blocked | Pin and mount the BS-RoFormer checkpoint SHA-256, install the separation runner, allocate CUDA hardware, enable the provider, and pass real smoke inference. Demucs never impersonates this identity. |
| MT3 | GPU worker implemented; deployment blocked | Pin and mount the MT3 checkpoint SHA-256, install the transcription runner, allocate CUDA hardware, enable the provider, and pass real smoke inference. Basic Pitch remains separate. |

## External or provider-owned models

`ALL_IN_ONE`, `SHEETSAGE`, `CHROMA`, `BASS`, `ANYACCOMP`, `SYMPHONYGEN`,
`METEOR`, and `MIDI_SAG` remain `unavailable` until their own endpoint,
authentication (when required), checkpoint/model version, and smoke health are
present. Declaring an environment variable alone changes a provider to
`configured`; it does not make it `ready`.

OpenAI is used only for Studio Copilot through Replit AI Integrations. It is not
used as a music-analysis, stem-separation, arrangement-audio, or mastering
provider.

## Runtime topology

The Node API remains the authoritative orchestration boundary for ownership,
leases, cancellation, idempotency, Song Model validation, candidate quality,
and export lineage. The Python worker performs bounded model inference and
returns canonical payloads with model/checkpoint provenance.

Development uses a private worker URL on the local service port. Production
should use the same HTTP contract on a separately deployed worker. Heavy models
must use a GPU worker; CPU execution is intentionally limited to the verified
baseline above.

Relevant configuration:

- `BASIC_PITCH_API_URL`: Python worker base URL for `/analyze`.
- `DEMUCS_API_URL`: Python worker base URL for `/separate`.
- `MUSIC_AI_WORKER_TOKEN`: optional bearer token shared by the API and worker.
- `PEDALBOARD_VST3_API_URL`: configured only when a real VST3 plugin backend is
  present.
- `MUSIC_AI_ASSET_ROOT`: private worker-mounted directory containing licensed
  native assets; never a Git path.
- `MUSIC_AI_ASSET_MANIFEST`: private JSON manifest describing the selected
  plugin/library identity, SHA-256, license owner, and license record.
- `MUSIC_AI_VST3_PLUGIN_NAME`: optional exact name for a multi-plugin VST3
  bundle.
- `SFIZZ_RENDER_API_URL`: configured only for a worker whose selected SFZ
  library and native host passed canonical TrackModel sensitivity smoke tests.
  The API never receives or transmits the private library path.

Never place tokens, model-provider credentials, licensed plugin binaries, or
sample libraries in source control.
