# GPU music-provider worker contract

ACE-Step, MusicGen, BS-RoFormer, MT3, and other heavy models run outside the
CPU worker. The Node API remains the owner of user authorization, job leases,
idempotency, cancellation, candidate validation, ranking, and artifact lineage.

## Readiness

`GET /health` must return HTTP 200 and all of:

```json
{
  "status": "ready",
  "runtimeReady": true,
  "checkpointReady": true,
  "modelVersion": "pinned-provider-version",
  "checksum": "sha256-of-loaded-checkpoint",
  "smokeTested": true
}
```

A configured URL, an allocated GPU, or a downloaded checkpoint is not
sufficient. The worker must load the exact checkpoint and complete a real
inference before setting `smokeTested`.

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