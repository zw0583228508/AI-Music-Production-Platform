# GPU music-provider worker contract

ACE-Step, MusicGen, BS-RoFormer, MT3, and other heavy models run outside the
CPU worker. The Node API remains the owner of user authorization, job leases,
idempotency, cancellation, candidate validation, ranking, and artifact lineage.

## Readiness

`GET /health` must return HTTP 200 and all of:

```json
{
  "status": "ready",
  "provider": "ACE_STEP",
  "runtimeReady": true,
  "gpuReady": true,
  "checkpointReady": true,
  "modelVersion": "pinned-provider-version",
  "checksum": "sha256-of-loaded-checkpoint",
  "smokeTested": true
}
```

A configured URL, an allocated GPU, or a downloaded checkpoint is not
sufficient. The worker must load the exact checkpoint and complete a real
inference before setting `smokeTested`.

The Node deployment must independently pin the expected checksum with
`MUSIC_PROVIDER_<PROVIDER>_CHECKPOINT_SHA256` for generation providers and
`<PROVIDER>_CHECKPOINT_SHA256` for analysis providers. Health and completed
results must match that pin; a merely well-formed SHA-256 is never sufficient.
Worker bearer authentication is mandatory.

Provider adapters discover readiness with
`GET /health?provider=<PROVIDER_ID>` using the same bearer token configured for
submission and cancellation. The unqualified health endpoint is an
operator-facing aggregate and is not the adapter contract.

The reference implementation lives in `services/music-ai-gpu-worker`. It
stores checkpoints and its SQLite job journal in a durable mounted model
directory, verifies the pinned Python/CUDA/PyTorch runtime, and executes
provider-specific runners without a shell. The checked-in checkpoint hashes
are intentionally unset because weights are not stored in Git; those providers
remain unavailable until a deployment pins and mounts the real assets.

## Generation

The existing provider adapter sends canonical Song Model, arrangement request,
candidate count, and idempotency metadata to the configured provider endpoint.
The worker may return a completed result or HTTP 202 with:

```json
{
  "jobId": "provider-owned-id",
  "status": "queued",
  "statusUrl": "/jobs/provider-owned-id",
  "cancelUrl": "/jobs/provider-owned-id"
}
```

Status and cancellation URLs must remain on the configured worker origin.
Polling must eventually return a terminal `completed`, `failed`, or `cancelled`
state. `DELETE cancelUrl` must acknowledge cancellation or return 404 when the
job is already gone.

The reference worker exposes `/generate` and `/arrange` for ACE-Step/MusicGen,
`/separate` for BS-RoFormer, and `/transcribe` plus `/analyze` for MT3. Every
submission requires `Idempotency-Key`; reusing a key for a different request
returns HTTP 409. Running jobs are requeued after restart, while pending
cancellations become terminal rather than being replayed.

Completed candidates must include the provider/model/checkpoint identity and
canonical arrangement or TrackModel data expected by the Node contract. Audio
artifacts must carry format, sample rate, duration, and lineage metadata. The
Node API rejects malformed candidates and candidates without complete quality
evidence.

## Execution requirements

- Pin container/runtime, CUDA, framework, model revision, and checkpoint hash.
- Keep checkpoints in durable model storage, never Git.
- Enforce request size, duration, concurrency, and GPU-memory limits.
- Use provider-side idempotency keyed by the API request identity.
- Support progress, cancellation, and process-restart recovery.
- Never fall back to a different checkpoint or CPU model under the same
  provider identity.
- Keep vendor credentials in Replit Secrets or the provider deployment secret
  store; never return them in health, logs, provenance, or error messages.

Until a worker satisfies this contract, its provider remains `configured` or
`unavailable`, never `ready`.