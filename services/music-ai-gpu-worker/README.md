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

## Run

```sh
uv run uvicorn app:app --app-dir services/music-ai-gpu-worker --host 0.0.0.0 --port 8009
```

Use the Node API's `MUSIC_PROVIDER_<PROVIDER>_URL` values pointing at
`/generate`, `/separate`, or `/transcribe`. The API will route only after a
strict health response includes the matching provider, exact model version,
GPU/runtime readiness, checkpoint readiness, 64-character SHA-256, and a real
smoke proof.