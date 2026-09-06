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

All four endpoint classes are always defined and deployed. Modal imports this
module again inside each remote container, so deploy-time-only selection
variables cannot safely control class definitions. Deployment does not imply
readiness: providers without verified checkpoints remain fail-closed.

```sh
MUSIC_GPU_PUBLIC_ORIGIN_ACE_STEP=https://workspace--ace-step.modal.run \
MUSIC_GPU_PUBLIC_ORIGIN_BS_ROFORMER=https://workspace--bs-roformer.modal.run \
MUSIC_GPU_PUBLIC_ORIGIN_MT3=https://workspace--mt3.modal.run \
MUSIC_GPU_PUBLIC_ORIGIN_ALL_IN_ONE=https://workspace--all-in-one.modal.run \
  modal deploy services/music-ai-gpu-worker/modal_app.py
```

Set one exact `MUSIC_GPU_PUBLIC_ORIGIN_<PROVIDER>` at deploy time for every
provider. The worker receives it as `MUSIC_GPU_PUBLIC_ORIGIN` and
fails health/submission closed when it is absent or differs from the request
origin.

Provider images have independent runtime pins. ACE-Step uses the official
Linux x86_64 stack: CUDA 12.8.1 runtime image, PyTorch 2.10.0+cu128,
Torchvision 0.25.0+cu128, Torchaudio 2.10.0+cu128, Transformers 4.57.6, and
Accelerate 1.12.0. Other providers retain the reviewed CUDA 12.4/PyTorch 2.5.1
stack until their checkpoint/runtime combination is validated.
It remains bearer-protected by `MUSIC_AI_WORKER_TOKEN`; endpoint URLs are not
an authorization boundary and must not be placed in clients.

Each Modal image is built from a checked-in provider-specific Dockerfile,
retaining its pinned CUDA, Python, PyTorch, Transformers, Accelerate, and `uv`
identities. Distinct Dockerfile paths are required because Modal identifies
Dockerfile images before applying build arguments; sharing one path can silently
substitute another provider's dependency stack. Separate durable Volumes hold
models, SQLite jobs, and runner outputs. Provider classes have one concurrent
input and exactly one container because the FastAPI worker uses a process-local
task registry around its durable SQLite journal.
Each provider image installs only its own pinned
`runners/requirements-<provider>.txt` dependency set during its OCI build; it
does not download weights or executable model code while serving a request.

### Verified provider capability matrix

| Provider | Modal GPU/runtime | Installed adapter | Checkpoint and smoke status | API readiness |
| --- | --- | --- | --- | --- |
| ACE-Step 1.5 | L40S; CUDA 12.8.1; Torch 2.10.0+cu128 | Official ACE-Step source at `ca1e85fe9430179831e6bc6be790c332190a3866` | Composite checkpoint SHA verified; real GPU smoke passed | `ready` |
| BS-RoFormer | L4; CUDA 12.4.1; Torch 2.5.1+cu124 | `bs-roformer-infer==0.1.5` | MIT Viperx snapshot `puar-playground/bs-roformer@b1361b816daca507f079d85e935c291bcb0a5351`; checkpoint SHA `5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa`; real L4 smoke passed | `ready` with matching signed promotion |
| MT3 | L4; CUDA 12.4.1; Torch 2.5.1+cu124; Transformers 4.38.2 | `mt3-infer==0.1.3` at `280a95817a67da0ae46987ddbb18c946963afffe` | Converted checkpoint snapshot and canonical SHA verified; real L4 smoke produced valid transcription; routing still requires the exact signed matching promotion | fail-closed pending signed matching promotion |
| All-In-One | L4; CUDA 12.4.1; Torch 2.5.1+cu124 | `all-in-one-infer` at `3c93b4ae389328544dd5955af7497030cb1bca3a`; `demucs-infer` 4.2.2 at `4b79d5c756ce298503d90b0cca2abbc76c565416` | All eight CC-BY-NC-SA-4.0 Harmonix folds and the MIT HTDemucs asset are revision/SHA pinned and atomically staged; readiness still requires real GPU smoke and a signed promotion | `configured` until smoke and promotion pass |

`runtimeReady=true` for blocked providers proves their isolated image,
CUDA/Torch stack, and adapter import are usable. It is not permission to route
jobs: `checkpointReady=false`, `smokeTested=false`, and `healthy=false` keep
them unavailable until immutable sources, licenses, revisions, SHA-256 values,
and real model-specific GPU smoke results are established.

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

### Signed promotion

Modal providers are not ready in the API until deployment CI publishes one
versioned promotion bundle. The record binds the Modal app, deployment,
function, and image IDs to the exact HTTPS endpoint origin, checkpoint digest,
checkpoint revision, repository source revision, source-image digest, model
version, and every runtime pin. CI signs the canonical record with an Ed25519
private key. The API receives only the public key, so it can verify a promotion
but cannot create one.

Set `MUSIC_GPU_SOURCE_REVISION` to the immutable repository revision during the
candidate deployment. Before the first deployment, create the provider-only
identity Secret with non-empty placeholders; health remains fail-closed until
CI replaces them with observed IDs:

```sh
modal secret create music-ai-gpu-promotion-ace-step-v1 \
  MUSIC_GPU_MODAL_APP_ID=unpromoted \
  MUSIC_GPU_MODAL_DEPLOYMENT_ID=unpromoted \
  MUSIC_GPU_MODAL_FUNCTION_ID=unpromoted
```

After `modal deploy` returns the final Modal IDs, CI
creates the signed bundle:

```sh
MUSIC_GPU_PROMOTION_PRIVATE_KEY_FILE='/ci/secrets/promotion-ed25519.pem' \
MUSIC_AI_WORKER_TOKEN='<runtime secret>' \
MUSIC_GPU_TRUSTED_ENDPOINT_ORIGIN_ACE_STEP='https://workspace--music-ai-gpu-worker-ace-step.modal.run' \
python services/music-ai-gpu-worker/promote_modal.py \
  --provider ACE_STEP \
  --modal-app-id '<Modal app ID>' \
  --modal-deployment-id '<Modal deployment ID>' \
  --modal-function-id '<Modal function ID>' \
  --modal-image-id '<Modal image ID>' \
  --endpoint-origin 'https://workspace--music-ai-gpu-worker-ace-step.modal.run' \
  --checkpoint-sha256 '<64 hex characters>' \
  --source-revision '<immutable repository revision>' \
  --output /ci/promotions/ace-step.json \
  --worker-identity-output /ci/promotions/ace-step-worker-identity.json
```

The script first sends the worker token only to the provider's independently
configured trusted origin. It retries only the exact authenticated `starting`
contract with matching deployment identity and runtime pins. All redirects,
ordinary runtime failures, malformed responses, and identity drift fail before
signing. It then writes one `{record,signature}` document through `os.replace`,
so an image or checkpoint change cannot expose a mixed old/new pair. Publish
that entire document as `MUSIC_PROVIDER_ACE_STEP_PROMOTION_BUNDLE` in the API
environment, and provide the corresponding PEM public key to the API as
`MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY`. The API verifies the signature and
derives its expected image, checkpoint, and source-image pins from that one
bundle before requiring live health evidence to match it and reporting `ready`.
Changing the image, checkpoint, endpoint, source revision, or runtime pins
requires a newly signed atomic bundle.

Publish the generated worker identity JSON through the provider-only Modal
Secret referenced by `modal_app.py`, then replace existing containers without
changing code:

```sh
modal secret create music-ai-gpu-promotion-ace-step-v1 \
  --from-json /ci/promotions/ace-step-worker-identity.json --force
modal app rollover '<Modal app ID>' --strategy recreate
```

The worker reports those CI-observed app, deployment, and function IDs together
with Modal's reserved `MODAL_IMAGE_ID`. The API requires exact equality with the
signed record. Publish the API bundle only after the Secret update succeeds;
during any partial rotation the provider remains configured but not ready.

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
BS-RoFormer bootstrap downloads only `bs_roformer.ckpt` and
`bs_roformer.yaml` from the immutable MIT-labelled
`puar-playground/bs-roformer@b1361b816daca507f079d85e935c291bcb0a5351`
snapshot. It verifies the 639,331,213-byte checkpoint as
`5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa`
and the config as
`9df444dbc1a704e23858e0315a211ec5fa4c69f92ecefb173d05e8f721ed2b1f`
before publishing the config and then the checkpoint readiness marker. The
snapshot card carries an MIT license declaration and credits the Viperx
checkpoint and upstream MIT BS-RoFormer implementations; this reviewed package,
not the mutable third-party release URL, is the production source.
MT3 uses the provider-private `music-ai-mt3-models-v1` Volume. Provision it
with:

```sh
modal run services/music-ai-gpu-worker/mt3_bootstrap_modal.py
```

The bootstrap stages only `config.json` and `mt3.pth` from the weight
introduction commit
`kunato/mt3-pytorch@03a06ef7f288f64e7cd25f17c3f37bcf9fe111bc`.
Each file has an exact retained size and SHA-256 before the directory is
atomically published as `mt3-official-multitrack`. The canonical directory
digest is
`33f6bc4c0410a1c7c1c426c5406566de0b7418af2dc3dfd798496f70cef85622`.
Retained provenance in `release-evidence/mt3/checkpoint-provenance.json`
shows that all 191 mapped assignments are exactly equal to
`gs://mt3/checkpoints/mt3` (`maxAbsDelta=0`) and both additional positional
buffers exactly match the pinned constructor. The `ismir2021` negative control
matched zero assignments, so the truthful model version is
`mt3-pytorch-multitrack`. The official Google checkpoint is Apache-2.0; no
rights are inferred from the unlicensed conversion repository.
The reviewed runtime uses `mt3-infer==0.1.3` at
`280a95817a67da0ae46987ddbb18c946963afffe`, Transformers 4.38.2, and one
exact build-time import relocation identified in runtime provenance.
The historical L4 result is in `smoke_proofs/mt3-l4.json`: the 32-second
non-silent structured fixture produced 48 notes and matched the reviewed image
and source digest. It predates the isolated deployment and is not release
evidence. Only a newly retained smoke result and separately signed exact
promotion bundle can enable API routing.

Successful bootstrap output contains only provider, relative path, digest,
revision, and size.

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
