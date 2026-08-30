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
Runner artifact URLs use the authenticated submission's HTTPS origin, not a
configured or guessed public URL. Each signed URL expires and atomically
consumes only its named artifact; separate stem capabilities remain usable.
`MUSIC_GPU_CONTAINER_DIGEST` is a deterministic SHA-256 of the reviewed
provider image build inputs (Dockerfile, worker/config/manifest, runner, and
requirements), not a claim about an OCI registry layer digest. It is baked and
passed by `modal_app.py`, so the control plane can pin the exact source-image
identity consistently with the `containerDigest` contract.

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