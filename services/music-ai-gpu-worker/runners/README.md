# Provider runner protocol

The worker invokes the modules without a shell:

```sh
python -m runners.bs_roformer --job --provider BS_ROFORMER --model-version bs-roformer-viperx-v1 --checkpoint /mounted/bs-roformer.ckpt
python -m runners.ace_step --job --provider ACE_STEP --model-version ace-step-1.5-base --checkpoint /mounted/ace-step-1.5-runtime
```

`--job` accepts exactly one canonical request JSON object on stdin and prints
one final JSON result. BS-RoFormer requires `sourceUrl` (or
`input.sourceUrl`), an HTTPS audio URL. ACE-Step requires `prompt` (or
`songModel.prompt`) and accepts `seed`, `candidateCount`, and
`durationSeconds`, either top-level or in `parameters`.

`--smoke` performs actual GPU inference, rather than a load-only check.
For BS-RoFormer, MT3, and All-In-One, mount a short non-silent fixture below
`MUSIC_GPU_CHECKPOINT_ROOT` and set `MUSIC_GPU_SMOKE_INPUT_PATH` to its absolute
path. `MUSIC_GPU_SMOKE_INPUT_URL` is an optional HTTPS alternative (the legacy
`MUSIC_GPU_SMOKE_INPUT` URL name is also accepted). Local paths outside the
model volume fail closed. Local and remote inputs pass the same decode,
duration, finite-sample, size, and non-silence checks as jobs. ACE-Step uses
the source-pinned constant `SMOKE_PROMPT`; deployment cannot silently replace
the smoke workload.

The process fails closed for missing CUDA, packages, mounted checkpoints,
invalid input, remote model loading, silent/non-finite audio, or output limits.
Outputs are FLAC/WAV artifacts under `MUSIC_GPU_JOB_OUTPUT_ROOT` (defaulting
to the durable model volume's `job-outputs` directory).

Run the runner-only contract tests from the repository root:

```sh
python -m unittest discover -s services/music-ai-gpu-worker/runners/tests -p 'test_*.py'
```

Deployments must set `MUSIC_PROVIDER_<PROVIDER>_CHECKPOINT_SHA256`,
the source-build digest input `MUSIC_GPU_CONTAINER_DIGEST`,
`MUSIC_GPU_ARTIFACT_BASE_URL`, and
`MUSIC_GPU_ARTIFACT_CAPABILITY_SECRET`. Results contain URL/capability
descriptors, never filesystem paths; the configured artifact gateway must
validate the capability before serving the durable file.

Provider code is pinned to `bs-roformer-infer==0.1.5` from
`openmirlab/bs-roformer-infer@b0f1386fcced25f559f3e61c9f08a73cd9bddf80`
and an image-build checkout of
`ace-step/ACE-Step-1.5@ca1e85fe9430179831e6bc6be790c332190a3866`.
ACE weights use an attested composite root built from the pinned
`ACE-Step/acestep-v15-base` and `ACE-Step/Ace-Step1.5` snapshots;
neither runner resolves or downloads model weights during a request.

## Offline bootstrap layout

Bootstrap is a separate, network-enabled administrative step. Runtime
containers must be offline-capable and mount this shape read-only (job outputs
are a separate writable mount):

```text
${MUSIC_GPU_CHECKPOINT_ROOT}/
  smoke/smoke.wav
  bs-roformer-viperx-v1.ckpt
  bs-roformer-viperx-v1.yaml
  mt3-official-multitrack/       # exact official gs://mt3/checkpoints/mt3 serialization
  all-in-one/
    harmonix-fold0-0vra4ys2.pth
  all-in-one-demucs/             # populated torch-hub/demucs-infer cache
  ace-step-1.5-runtime/          # one aggregate-hash-attested composite root
    acestep-v15-base/            # base snapshot
    vae/                         # shared full-repository subtree
    Qwen3-Embedding-0.6B/        # shared full-repository subtree
```

Required environment includes the exact aggregate/file hashes in
`MUSIC_PROVIDER_<PROVIDER>_CHECKPOINT_SHA256`,
`MUSIC_PROVIDER_BS_ROFORMER_CONFIG_PATH` and
`MUSIC_PROVIDER_BS_ROFORMER_CONFIG_SHA256`,
`MT3_INFER_MODEL=mt3_pytorch`, `ALL_IN_ONE_MODEL=harmonix-fold0`,
`MUSIC_PROVIDER_ALL_IN_ONE_DEMUCS_ROOT`, and
`MUSIC_GPU_SMOKE_INPUT_PATH=${MUSIC_GPU_CHECKPOINT_ROOT}/smoke/smoke.wav`.

Authoritative identities researched at the pinned runner revisions:

* MT3-Infer `280a95817a67da0ae46987ddbb18c946963afffe` calls the
  `mt3_pytorch` registry entry a directory checkpoint at
  `.mt3_checkpoints/mt3_pytorch`, sourced from kunato/mt3-pytorch
  `pretrained/`; its registry records weight SHA-256
  `b8a3807ed265059abd25ad7f68142c06c35e8f6144dcaa45bd55946a3745398f`.
  The runner passes the mounted directory explicitly with auto-download off.
* All-In-One-Infer `3c93b4ae389328544dd5955af7497030cb1bca3a`
  `harmonix-fold0` requires `harmonix-fold0-0vra4ys2.pth`, SHA-256
  `0db596dfb0995f41d62f6267d76a9d54c046f1649bd35e1dbeca0c5f9a7b8acd`.
  The current upstream `taejunkim/allinone` snapshot observed during this
  audit is `379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19`; pin that snapshot during
  bootstrap. Mixed-audio inference also requires the already-populated
  Demucs cache; runtime sets Hugging Face/Transformers offline mode.
* ACE-Step Base is repository `ACE-Step/acestep-v15-base`, pinned to HF
  snapshot `e432212fec32b8965a14ffa57ae653438d6abd14`. Its shared `vae` and
  `Qwen3-Embedding-0.6B` trees come from `ACE-Step/Ace-Step1.5`, pinned to
  `19671f406d603126926c1b7e2adc169acbcade22`. Mount all three required
  subtrees beneath the single aggregate-hash-attested
  `ace-step-1.5-runtime` root. Set
  `MUSIC_PROVIDER_ACE_STEP_CONFIG_PATH=acestep-v15-base` if overriding the
  identical default; no path or other basename is accepted. At source revision
  `ca1e85fe9430179831e6bc6be790c332190a3866`, `initialize_service` accepts
  `project_root` and `config_path` (not `checkpoint_dir`), uses
  `ACESTEP_CHECKPOINTS_DIR` as the containing directory, then loads
  `${ACESTEP_CHECKPOINTS_DIR}/${config_path}`. The runner sets the checkpoints
  directory and `project_root` to a disposable runtime view outside the
  attested composite root. That view links only the validated model files and
  shared trees back beneath the attested root, so the handler's synchronization
  of `configuration_acestep_v15.py`, `modeling_acestep_v15_base.py`, and
  `apg_guidance.py` writes only into temporary storage. The runner rejects
  source symlink escapes, removes the view after inference, sets
  `PYTHONDONTWRITEBYTECODE=1`, disables MLX, checks initialization success,
  keeps `thinking=False` without loading the LLM, and keeps hub resolution
  offline.
  The Linux x86_64 runtime is exactly torch `2.10.0+cu128`, torchvision
  `0.25.0+cu128`, and torchaudio `2.10.0+cu128`; Transformers must be
  `>=4.51.0,<4.58.0` and Accelerate `>=1.12.0`. Actual versions are validated
  before model initialization and recorded in provenance. The old worker-wide
  torch 2.5/CUDA 12.4 identity is not valid for this ACE runner.
* The historical “viperx v1” name resolves to the UVR
  `model_bs_roformer_ep_317_sdr_12.9755.ckpt` family and its
  `config_bs_roformer_384_8_2_485100.yaml`; the original public host is no
  longer an immutable authoritative source. Therefore bootstrap must pin the
  exact independently audited bytes in the two SHA environment variables.
  The runner will not use bs-roformer-infer's downloadable registry and will
  reject a missing/mismatched config rather than substitute another model.

Do not bootstrap in a request or smoke process. `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1` are forced by model adapters where applicable.