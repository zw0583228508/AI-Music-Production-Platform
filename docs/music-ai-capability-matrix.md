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
| Python symbolic MIDI boundary | Local MIDI construction, parsing, and Standard MIDI File serialization | `music21 9.9.2`, `mido 1.3.3`, `pretty-midi 0.2.11.post0` | Ready on Python 3.11 after worker smoke test | Smoke test imports all three packages, serializes a note through music21 → mido → pretty_midi, then reparses the resulting MIDI with mido |
| Local symbolic director and expressive synth | Arrangement, MIDI, and deterministic audio rendering | Built into the TypeScript API | Ready on CPU | Existing arrangement, quality, lineage, and export suites |

Model packages and exact transitive versions are locked in `uv.lock`. Large
downloaded checkpoints live in the ignored runtime cache and are validated
against the manifest before readiness is reported; they are not committed to
Git.

## Optional adapters blocked pending native attestation

| Provider/runtime | State | What is missing |
| --- | --- | --- |
| Pedalboard VST3 adapter | `unavailable` unless attested | Requires a compatible licensed VST3 binary, approved executable native MIDI host, approved instrument/control mappings, private-manifest asset and host SHA-256 values/license record, and a canonical TrackModel smoke render with host/output attestation. Pedalboard built-ins are never a VST3 fallback or readiness proof. |
| sfizz / VSCO / VSCO2 CE adapter | `unavailable` unless attested | Requires a compatible licensed VSCO/SFZ library, approved executable native sfizz host, approved instrument/control mappings, private-manifest library and host SHA-256 values/license record, and a canonical TrackModel smoke render with host/output attestation. No synthetic renderer is substituted. |
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
- `MUSIC_AI_WORKER_TOKEN`: required non-blank bearer token shared by the API
  and worker for provider capability and processing routes. The worker returns
  `401` when it is unset, blank, missing, or incorrect; one-time artifact
  download URLs remain public capabilities by design.
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

## Dependency and lock boundary

The workspace-root `pyproject.toml` is the sole uv dependency source for the
Python 3.11 symbolic boundary. Its `music21>=9.7,<10` declaration resolves in
the current `uv.lock` to `music21 9.9.2`; the same lock records `mido 1.3.3`,
`pretty-midi 0.2.11.post0`, and `pedalboard 0.9.24`. A clean deployment must
use that root lock before claiming symbolic-MIDI readiness.

Never place tokens, model-provider credentials, licensed plugin binaries, or
sample libraries in source control.
