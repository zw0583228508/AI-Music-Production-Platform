# Music AI worker

Python 3.11 FastAPI worker using the root `uv` environment. The smoke command
must succeed before the server starts so health cannot report an untested
checkpoint as ready:

```sh
uv run python -m unittest discover -s services/music-ai-worker/tests
uv run python services/music-ai-worker/smoke_test.py
uv run uvicorn app:app --app-dir services/music-ai-worker --host 0.0.0.0 --port 8008
```

`MUSIC_AI_WORKER_TOKEN` enables bearer authentication. Inputs are limited by
`MUSIC_AI_MAX_SOURCE_BYTES`, `MUSIC_AI_MAX_INPUT_BYTES`, and
`MUSIC_AI_MAX_DURATION_SECONDS`; public HTTP(S) sources only are accepted.
`MUSIC_AI_VST3_PATH` must name a successfully loadable VST3 for `/render`.
The manifest pins the Basic Pitch and Demucs checkpoint hashes and runtime
versions. Health also reads the installed distribution metadata and is unhealthy
when a package version differs from the pinned manifest. Downloaded checkpoints,
readiness markers, and stem artifacts are runtime data and are not committed.

The local workflow exposes:

- `GET /health?provider=BASIC_PITCH|DEMUCS` — strict runtime, checkpoint,
  checksum, version, and smoke readiness.
- `POST /analyze` — Basic Pitch audio-to-MIDI evidence.
- `POST /separate` — Demucs vocal/instrumental FLAC stems. The response is
  deliberately small (well below 32MB) and contains absolute, same-origin,
  one-time `downloadUrl` values rather than inline base64 audio. Artifacts are
  cryptographically unguessable, expire after
  `MUSIC_AI_ARTIFACT_TTL_SECONDS` (default 15 minutes), and are deleted after a
  successful download. They intentionally use capability URLs instead of bearer
  authentication because the current Node client does not send Authorization
  headers when downloading stems. Each stem and the combined output are bounded
  below 512MB by `MUSIC_AI_MAX_STEM_BYTES` and
  `MUSIC_AI_MAX_SEPARATION_OUTPUT_BYTES`.
- `POST /process` — Pedalboard built-in effects.
- `POST /render` — fail-closed VST3 processing; unavailable without a real,
  loadable plugin.

Heavy neural generation uses the separate contract documented in
`docs/music-ai-gpu-worker-contract.md`.

Remote source fetching resolves the hostname exactly once, rejects any
non-global DNS answer, and connects directly to the vetted address while HTTPS
continues certificate and SNI validation for the original hostname. Redirects
and URL credentials are rejected.