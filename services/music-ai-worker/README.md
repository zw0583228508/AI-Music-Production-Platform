# Music AI worker

Python 3.11 FastAPI worker using the root `uv` environment. The smoke command
must succeed before the server starts so health cannot report an untested
checkpoint as ready:

```sh
uv run python -m unittest discover -s services/music-ai-worker/tests
uv run python services/music-ai-worker/smoke_test.py
uv run uvicorn app:app --app-dir services/music-ai-worker --host 0.0.0.0 --port 8008
```

`MUSIC_AI_WORKER_TOKEN` is required bearer authentication for every provider
capability endpoint (`/health`, `/analyze`, `/separate`, `/process`, and
`/render`). The worker fails closed with `401` when the token is unset, blank,
missing, or incorrect. The one-time capability artifact download route remains
public by design: its unguessable, short-lived artifact ID is the capability.
Inputs are limited by `MUSIC_AI_MAX_SOURCE_BYTES`, `MUSIC_AI_MAX_INPUT_BYTES`,
and `MUSIC_AI_MAX_DURATION_SECONDS`; public HTTP(S) sources only are accepted.
Native renderers are optional and fail closed. Licensed assets must be placed in
a private, worker-readable mount outside Git (for example
`MUSIC_AI_ASSET_ROOT=/var/lib/music-ai/assets`) and selected by
`MUSIC_AI_ASSET_MANIFEST`. The manifest itself must contain a `vst3` and/or
`sfz` entry with an asset `id`, exact `identity`, `licenseOwner`,
`licenseReference`, and a SHA-256 checksum. Both entries require an executable
native MIDI host selected by `rendererPath`, `rendererIdentity`, and
`rendererSha256`. VST3 entries use `path`; Pedalboard verifies that the plugin
loads, while the native host performs instrument/MIDI rendering. SFZ entries
use `libraryPath` and a native sfizz host. Every path must remain inside the
asset root; a missing, changed, or undocumented asset or host is unhealthy.

Example manifest (keep the real file in the private mount, never in Git):

```json
{
  "vst3": {
    "id": "licensed-orchestral-vst3",
    "identity": "Vendor / Product / Version",
    "path": "/var/lib/music-ai/assets/plugins/orchestral.vst3",
    "rendererPath": "/var/lib/music-ai/assets/bin/vst3-midi-render-host",
    "rendererIdentity": "Approved VST3 MIDI Host / Version",
    "rendererSha256": "<sha256 of the native host>",
    "sha256": "<sha256 of the plugin file>",
    "licenseOwner": "Your licensed account or organization",
    "licenseReference": "Invoice, subscription, or license record reference"
  },
  "sfz": {
    "id": "licensed-vsco2-ce",
    "identity": "Versilian Studios / VSCO 2 CE / Version",
    "libraryPath": "/var/lib/music-ai/assets/vsco2-ce",
    "rendererPath": "/var/lib/music-ai/assets/bin/sfizz-render-host",
    "rendererIdentity": "Approved sfizz Host / Version",
    "rendererSha256": "<sha256 of the native host>",
    "sha256": "<deterministic hash of all library files>",
    "licenseOwner": "Your licensed account or organization",
    "licenseReference": "Applicable VSCO 2 CE license record reference"
  }
}
```

Both native hosts receive `--track-model`, `--sample-rate`,
`--duration-seconds`, `--output`, `--attestation`, and `--asset-identity`, plus
`--plugin` for VST3 or `--library` for SFZ. They must consume notes, CC,
articulations, and automation from the supplied canonical TrackModel, load the
selected instrument, and write a finite, audible WAV at the requested sample
rate and duration. They must also write JSON to `--attestation` containing the
exact `provider` (`vst3` or `sfz`), `assetIdentity`, `assetSha256`,
`rendererSha256`, `trackModelSha256`, `eventCounts` (`notes`, `cc`,
`articulations`, `automation`), and `outputSha256`. The worker validates every
field against its own hashes and request before decoding the WAV. Smoke
readiness renders pitch and expression variants and requires three distinct
output hashes, so a fixed-tone or TrackModel-ignoring host fails closed. The
worker never accepts an asset path from a render request.

Studio administrators can provision those private files without shell access.
The API server authorizes administrators with `MUSIC_STUDIO_ADMIN_IDS` and/or
`MUSIC_STUDIO_ADMIN_EMAILS`, then streams multipart uploads to the worker using
the existing `MUSIC_AI_WORKER_TOKEN`. Set `MUSIC_AI_WORKER_URL` on the API
server (the renderer-specific worker URLs remain supported as fallbacks).
Asset administration also fails closed when that token is absent.

Before a host can be uploaded, add its exact identity and SHA-256 to
`MUSIC_AI_APPROVED_NATIVE_HOSTS` as a JSON array, for example
`[{"kind":"sfz","identity":"Approved sfizz Host / Version","sha256":"..."}]`.
The worker checks the uploaded executable against this registry before granting
execute permission or starting smoke verification. Studio admin status alone
does not authorize arbitrary native code.

VST3 plugins are native code as well. Their exact `assetId`, identity, and
deterministic file-or-bundle checksum must also appear in
`MUSIC_AI_APPROVED_VST3_ASSETS`, for example
`[{"assetId":"licensed-piano-v2","identity":"Licensed Piano / 2.0","sha256":"..."}]`.
The worker rejects an unapproved plugin before `load_plugin` or any native host
process can receive it.

The admin lifecycle is intentionally two-step:

1. `POST /admin/assets/stage` uploads `assetFiles` and `rendererFile` plus
   `kind`, `assetId`, exact `identity`, `licenseOwner`, `licenseReference`, and
   `rendererIdentity`. Files are written below `MUSIC_AI_ASSET_ROOT`, checksums
   are computed there, and the candidate must pass all three canonical
   TrackModel renders before it becomes `verified`.
2. `POST /admin/assets/{candidateId}/activate` rechecks the candidate bytes and
   smoke evidence, then replaces `MUSIC_AI_ASSET_MANIFEST` with an atomic
   rename. A changed, missing, or failed candidate returns an error without
   modifying the current manifest. Smoke evidence is stored in that same
   manifest entry so readiness and active identity switch together.

`GET /admin/assets` returns active VST3/SFZ identities and verified candidates
without exposing private filesystem paths. Staged files, license records,
checksums, state, and the active manifest all remain runtime data outside Git.
`MUSIC_AI_MAX_ASSET_UPLOAD_BYTES` controls the streamed file limit (2 GiB by
default); clients must send `Content-Length`, and the normal JSON request limit
does not apply to this one upload route.

The manifest pins the Basic Pitch and Demucs checkpoint hashes and runtime
versions. Health also reads the installed distribution metadata and is unhealthy
when a package version differs from the pinned manifest. Downloaded checkpoints,
readiness markers, and stem artifacts are runtime data and are not committed.

The local workflow exposes:

- `GET /health?provider=BASIC_PITCH|DEMUCS|VST3|SFIZZ_VSCO2_CE` — strict
  runtime, asset identity/checksum, version, and smoke readiness. Native health
  includes the exact selected plugin/library identity, license evidence, and
  TrackModel render evidence.
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
- `POST /render` — fail-closed canonical TrackModel rendering through VST3 or
  sfizz/VSCO. Unavailable or failed native assets never become a synthetic
  provider result.

Heavy neural generation uses the separate contract documented in
`docs/music-ai-gpu-worker-contract.md`.

## Native renderer provisioning

`bootstrap_sfizz_vsco2.py` provisions the exact public sfizz `1.2.3` source and
the CC0 VSCO2 CE SFZ branch under `/var/lib/music-ai/assets/sfz`. It records the
source revisions plus deterministic file count, byte count, and tree hashes.
It does not claim readiness or activate the bytes. Set
`MUSIC_AI_SFIZZ_INSTRUMENT` to an reviewed library-relative SFZ, approve the
exact host identity/checksum, and use the normal stage/activate lifecycle. The
three-render smoke remains the only route to `SFIZZ_VSCO2_CE` readiness.

`native_hosts/pedalboard_vst3_host.py` is the offline VST3 TrackModel host and
`native_hosts/sfizz_track_model_host.py` adapts TrackModel MIDI events to the
pinned `sfizz_render` executable. Both emit the exact attestation consumed by
the existing worker. Build the staged single-file executable with
`python native_hosts/build_host.py vst3 /private/path/vst3-host` (or `sfz`);
the resulting zipapp binds the entry point and shared protocol code into the
one checksum approved by the worker. Neither is a substitute instrument. VST3 remains blocked
until a separately licensed, approved plugin is supplied and passes its real
native smoke renders.

Remote source fetching resolves the hostname exactly once, rejects any
non-global DNS answer, and connects directly to the vetted address while HTTPS
continues certificate and SNI validation for the original hostname. Redirects
and URL credentials are rejected.