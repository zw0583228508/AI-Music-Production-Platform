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