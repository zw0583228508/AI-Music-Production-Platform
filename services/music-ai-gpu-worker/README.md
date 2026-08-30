# GPU music model worker

This is the production boundary for ACE-Step, MusicGen, BS-RoFormer, and MT3.
It is intentionally fail-closed: a configured URL, a CUDA allocation, or a
downloaded model directory never makes a provider ready by itself.

## Pinned deployment

The reference container pins Python 3.11.11, CUDA 12.4.1, PyTorch
2.5.1+cu124, Transformers 4.48.3, and Accelerate 1.3.0. The model manifest
also pins the model version and checkpoint path for every provider. Checkpoint
directories/files belong under the durable `MUSIC_GPU_CHECKPOINT_ROOT`
(default `/var/lib/music-ai-gpu/models`) and must have an exact SHA-256 in
`model_manifest.json` or the deployment environment variable
`MUSIC_PROVIDER_<PROVIDER>_CHECKPOINT_SHA256`; `null` is deliberately
unavailable, not a wildcard.

Enable only mounted providers:

```sh
MUSIC_GPU_ENABLED_PROVIDERS=ACE_STEP,MUSICGEN
MUSIC_GPU_RUNNER_ACE_STEP='python -m my_ace_step_runner'
MUSIC_GPU_RUNNER_MUSICGEN='python -m my_musicgen_runner'
MUSIC_AI_WORKER_TOKEN='<set through the deployment secret store>'
```

The worker and Node API must pin the same deployed hashes as
`MUSIC_PROVIDER_ACE_STEP_CHECKPOINT_SHA256`,
`MUSIC_PROVIDER_MUSICGEN_CHECKPOINT_SHA256`,
`BS_ROFORMER_CHECKPOINT_SHA256`, and `MT3_CHECKPOINT_SHA256`. A provider remains
configured but unhealthy when either side lacks its pin or reports a mismatch.

The runner command is executed without a shell. For `--smoke`, it receives
`--provider`, `--model-version`, and `--checkpoint`, and must perform real
GPU inference then print one JSON proof line:

```json
{"smokeTested":true,"provider":"MUSICGEN","modelVersion":"musicgen-large","checkpointSha256":"<manifest sha256>","output":{"samples":1}}
```

For `--job`, the canonical request JSON is sent on stdin. The runner must
print a final JSON object with `candidates` for ACE-Step/MusicGen or the
provider-specific separation/transcription result. The worker overwrites
provider, model version, checkpoint hash, and smoke provenance with attested
values; runner claims are never trusted.

The job database is SQLite in the checkpoint root by default, so queued and
running jobs survive process restarts. `Idempotency-Key` is required and is
bound to a request hash. Jobs expose same-origin status/cancel URLs, progress
stages, and terminal `completed`, `failed`, or `cancelled` states. There is no
CPU fallback.

Authentication is mandatory. Without `MUSIC_AI_WORKER_TOKEN`, every protected
route returns 503 rather than exposing GPU compute. The reference container
runs as an unprivileged `music-ai` user.

## Modal deployment foundation

`modal_app.py` deploys isolated Modal ASGI endpoints labelled `bs-roformer`,
`ace-step`, `mt3`, and `all-in-one`. Each endpoint serves the existing FastAPI
worker but enables only its own provider. MusicGen is deliberately not a Modal
priority deployment.

`MUSIC_GPU_MODAL_DEPLOY_PROVIDERS` is a strict comma-separated deployment
allowlist. It defaults to `ACE_STEP`, the only provider with a verified public
checkpoint snapshot. An explicitly empty value or unknown provider aborts
module evaluation. For example, after separately validating and mounting MT3:

```sh
MUSIC_GPU_PUBLIC_ORIGIN_ACE_STEP=https://workspace--music-ai-gpu-worker-ace-step.modal.run \
MUSIC_GPU_MODAL_DEPLOY_PROVIDERS=ACE_STEP,MT3 \
  modal deploy services/music-ai-gpu-worker/modal_app.py
```

Set one exact `MUSIC_GPU_PUBLIC_ORIGIN_<PROVIDER>` at deploy time for every
selected provider. The worker receives it as `MUSIC_GPU_PUBLIC_ORIGIN` and
fails health/submission closed when it is absent or differs from the request
origin.

Provider images have independent runtime pins. ACE-Step uses the official
Linux x86_64 stack: CUDA 12.8.1 runtime image, PyTorch 2.10.0+cu128,
Torchvision 0.25.0+cu128, Torchaudio 2.10.0+cu128, Transformers 4.57.6, and
Accelerate 1.12.0. Other providers retain the reviewed CUDA 12.4/PyTorch 2.5.1
stack until their checkpoint/runtime combination is validated.
It remains bearer-protected by `MUSIC_AI_WORKER_TOKEN`; endpoint URLs are not
an authorization boundary and must not be placed in clients.

The Modal image is built from the checked-in Dockerfile, retaining its pinned
CUDA, Python, PyTorch, Transformers, Accelerate, and `uv` identities. Separate
durable Volumes hold models, SQLite jobs, and runner outputs. Provider classes
have one concurrent input and exactly one container because the FastAPI worker
uses a process-local task registry around its durable SQLite journal.
Each provider image installs only its own pinned
`runners/requirements-<provider>.txt` dependency set during its OCI build; it
does not download weights or executable model code while serving a request.

Create the volumes before deployment. The application deliberately uses
`create_if_missing=False`: an accidentally empty volume must make deployment
fail rather than quietly make a provider appear usable.

```sh
modal volume create music-ai-models-v1
modal volume create music-ai-jobs-v1
modal volume create music-ai-outputs-v1
```

Create the named secret out of band. It contains `MUSIC_AI_WORKER_TOKEN`,
`MUSIC_GPU_ARTIFACT_CAPABILITY_SECRET`, plus approved runner,
smoke-runner, checkpoint revision, and checkpoint-SHA values; never commit it.
Runner artifact URLs require the authenticated request origin to exactly match
the deployment-controlled `MUSIC_GPU_PUBLIC_ORIGIN`; suffix/Host guesses are
rejected. Each signed URL expires and atomically
consumes only its named artifact; separate stem capabilities remain usable.
Authenticated health smoke uses the same strictly validated provider endpoint
origin and passes its `/artifacts` base only to the smoke subprocess; runner
stderr and local paths are never reflected through health failures.
The `sourceImageDigest` response is a deterministic SHA-256 of the reviewed
provider image build inputs (Dockerfile, worker/config/manifest, runner, and
requirements), not an OCI registry layer digest or actual container identity.
The legacy `containerDigest` field aliases this source digest for compatibility
and must not be the sole trust anchor. `modalImageId`/`imageId` report Modal's
strictly validated runtime-injected `MODAL_IMAGE_ID`.

```sh
modal secret create music-ai-worker-runtime --from-dotenv .modal-worker.env
modal deploy services/music-ai-gpu-worker/modal_app.py
modal app show music-ai-gpu-worker
```

Use `modal app show` to obtain the provider-qualified URL, configure the
control plane with that URL and the same bearer token, then verify
`GET <url>/health?provider=<PROVIDER>`. Deployment alone is not readiness: the
mounted checkpoint checksum and a real smoke inference must pass.

Synchronize weights only from approved revision-pinned sources, hash them
before enabling a provider, and never commit them:

```sh
modal volume put music-ai-models-v1 ./verified-models/ace-step-1.5-base ace-step-1.5-base
modal volume get music-ai-models-v1 ace-step-1.5-base ./verified-models/ace-step-1.5-base
```

The deployable bootstrap entrypoint performs an atomic staged snapshot,
canonical digest, smoke-fixture write, and model Volume commit:

```sh
modal run services/music-ai-gpu-worker/bootstrap_modal_app.py::bootstrap --provider ACE_STEP
```

ACE-Step builds `ace-step-1.5-runtime` atomically from the public
`ACE-Step/Ace-Step1.5` snapshot at
`19671f406d603126926c1b7e2adc169acbcade22` and
`ACE-Step/acestep-v15-base` at
`e432212fec32b8965a14ffa57ae653438d6abd14`. The composite contains only
`acestep-v15-base`, `vae`, `Qwen3-Embedding-0.6B`, and required root
configuration. It excludes the turbo and 1.7B thinking model. A prior verified
`ace-step-1.5-base` is hardlinked (or copied) into staging when available and
is never deleted; otherwise the base revision is downloaded. The final
composite is independently canonical-hashed before its model Volume commit.
Bootstrap entrypoints also
exist for BS_ROFORMER, MT3, and ALL_IN_ONE, but intentionally fail before
creating checkpoint files because their current adapter identities do not establish an
unambiguous, immutable public checkpoint snapshot. Operators must review and
pin those sources rather than allowing an inference-time auto-download or a
checkpoint-shaped placeholder. Successful bootstrap output contains only
provider, relative path, digest, revision, and size.

For a checkpoint upgrade, create new versioned volumes, update the pinned
secret/checksum in a reviewed deployment, and wait for health smoke validation
before changing traffic. Roll back to the previous reviewed Modal deployment
and prior volume/secret version; do not overwrite verified weights in place.
Operational commands are `modal app logs music-ai-gpu-worker`,
`modal app history music-ai-gpu-worker`, and
`modal app rollback music-ai-gpu-worker <deployment-id>`. Check `modal app
--help` for the installed CLI's exact history/rollback syntax. These commands
do not claim a deployment or inference succeeded.

## Run

```sh
uv run uvicorn app:app --app-dir services/music-ai-gpu-worker --host 0.0.0.0 --port 8009
```

Use the Node API's `MUSIC_PROVIDER_<PROVIDER>_URL` values pointing at
`/generate`, `/separate`, or `/transcribe`. The API will route only after a
strict health response includes the matching provider, exact model version,
GPU/runtime readiness, checkpoint readiness, 64-character SHA-256, and a real
smoke proof.