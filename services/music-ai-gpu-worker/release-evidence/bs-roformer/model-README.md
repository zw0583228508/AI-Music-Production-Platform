---
license: mit
tags:
  - audio
  - music-source-separation
  - bs-roformer
  - vocal-extraction
  - pytorch
---

# BS-RoFormer — Vocal Extraction

> **Unofficial HuggingFace packaging** of
> [BS-RoFormer](https://github.com/lucidrains/BS-RoFormer) (Band-Split RoFormer),
> using the [ViperX checkpoint](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md).
> Adds a `from_pretrained` interface and native **Apple Silicon (MPS)** support.

Extracts **vocals** from a music track. Outputs exactly 2 stems:

| Stem | Description |
|------|-------------|
| `vocals` | Isolated vocal track |
| `other` | Everything else (mix − vocals) |

## Quick start

```bash
pip install transformers torch librosa soundfile \
            einops beartype rotary-embedding-torch
```

```python
from transformers import AutoModel

model = AutoModel.from_pretrained("puar-playground/bs-roformer", trust_remote_code=True)
stems = model.separate("song.wav", output_dir="output/")
# output/vocals.wav  — isolated vocals
# output/other.wav   — instrumental
```

## Device selection

```python
# Auto-detect: CUDA → MPS (Apple Silicon) → CPU
model = AutoModel.from_pretrained("puar-playground/bs-roformer", trust_remote_code=True)

# Explicit
model = AutoModel.from_pretrained("puar-playground/bs-roformer", trust_remote_code=True,
                                  device="mps")   # or "cuda", "cpu"
```

## Repository layout

```
bs-roformer/
├── modeling_bs_roformer.py   # BSRoFormerConfig + BSRoFormerForSourceSeparation
├── config.json
├── requirements.txt
├── bs_roformer.yaml          # model architecture config
├── bs_roformer.ckpt          # model weights (Git LFS)
└── bs_roformer_src/          # vendored BS-RoFormer source
```

## Credits

- BS-RoFormer architecture: [lucidrains/BS-RoFormer](https://github.com/lucidrains/BS-RoFormer)
- Checkpoint: [BS-RoFormer (ViperX edition)](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md) from ZFTurbo/Music-Source-Separation-Training
- Paper: *Music Source Separation with Band-Split RoPE Transformer* (Chen et al., 2024)
