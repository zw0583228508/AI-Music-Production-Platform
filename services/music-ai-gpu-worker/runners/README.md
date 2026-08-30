# Provider runner protocol

The worker invokes the modules without a shell:

```sh
python -m runners.bs_roformer --job --provider BS_ROFORMER --model-version bs-roformer-viperx-v1 --checkpoint /mounted/bs-roformer.ckpt
python -m runners.ace_step --job --provider ACE_STEP --model-version ace-step-1.5-base --checkpoint /mounted/ace-step-1.5-base
```

`--job` accepts exactly one canonical request JSON object on stdin and prints
one final JSON result. BS-RoFormer requires `sourceUrl` (or
`input.sourceUrl`), an HTTPS audio URL. ACE-Step requires `prompt` (or
`songModel.prompt`) and accepts `seed`, `candidateCount`, and
`durationSeconds`, either top-level or in `parameters`.

`--smoke` performs actual GPU inference, rather than a load-only check.
Set `MUSIC_GPU_SMOKE_INPUT` to an HTTPS audio URL for BS-RoFormer and
`MUSIC_GPU_SMOKE_PROMPT` for ACE-Step. Both commands print a JSON proof only
after validating a non-silent, finite durable audio artifact.

The process fails closed for missing CUDA, packages, mounted checkpoints,
invalid input, remote model loading, silent/non-finite audio, or output limits.
Outputs are FLAC/WAV artifacts under `MUSIC_GPU_JOB_OUTPUT_ROOT` (defaulting
to the durable model volume's `job-outputs` directory).

Run the runner-only contract tests from the repository root:

```sh
python -m unittest discover -s services/music-ai-gpu-worker/runners/tests -p 'test_*.py'
```

Deployments must set `MUSIC_PROVIDER_<PROVIDER>_CHECKPOINT_SHA256`,
`MUSIC_GPU_CONTAINER_DIGEST`, `MUSIC_GPU_ARTIFACT_BASE_URL`, and
`MUSIC_GPU_ARTIFACT_CAPABILITY_SECRET`. Results contain URL/capability
descriptors, never filesystem paths; the configured artifact gateway must
validate the capability before serving the durable file.

Provider code is pinned to `bs-roformer-infer==0.1.5` from
`openmirlab/bs-roformer-infer@b0f1386fcced25f559f3e61c9f08a73cd9bddf80`
and an image-build checkout of
`ace-step/ACE-Step-1.5@ca1e85fe9430179831e6bc6be790c332190a3866`.
ACE weights are the separately mounted `ACE-Step/acestep-v15-base` snapshot;
neither runner resolves or downloads model weights during a request.