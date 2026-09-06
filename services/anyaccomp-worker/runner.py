"""Single-file adapter around the immutable upstream AnyAccomp pipeline."""
from __future__ import annotations

import argparse
import os
import random
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--vocal", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=50)
    parser.add_argument("--cfg", type=float, default=3.0)
    parser.add_argument("--seed", type=int, default=1024)
    args = parser.parse_args()

    source = (args.assets / "source").resolve()
    pretrained = (source / "pretrained").resolve()
    if not source.is_dir() or pretrained != (args.assets / "weights/pretrained").resolve():
        raise RuntimeError("reviewed AnyAccomp source/checkpoint relationship is invalid")
    sys.path.insert(0, str(source))
    os.chdir(source)

    import librosa
    import numpy as np
    import soundfile as sf
    import torch
    from anyaccomp.inference_utils import Sing2SongInferencePipeline

    if not torch.cuda.is_available():
        raise RuntimeError("AnyAccomp requires CUDA inference")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed(args.seed)
    torch.backends.cudnn.deterministic = True

    pipeline = Sing2SongInferencePipeline(
        str(source / "pretrained/flow_matching"),
        str(source / "config/flow_matching.json"),
        str(source / "pretrained/vocoder"),
        str(source / "config/vocoder.json"),
        device="cuda",
    )
    vocal, _ = librosa.load(args.vocal, sr=24000, mono=True)
    if len(vocal) < 2400 or float(np.max(np.abs(vocal))) < 1e-5:
        raise RuntimeError("AnyAccomp vocal input is silent or too short")
    vocal_tensor = torch.tensor(vocal).unsqueeze(0).cuda()
    vocal_codes = pipeline.encode_vocal(vocal_tensor)
    with torch.inference_mode(), torch.cuda.amp.autocast(dtype=torch.bfloat16):
        mel = pipeline.model.reverse_diffusion(
            vocal_mel=vocal_codes,
            n_timesteps=args.steps,
            cfg=args.cfg,
        )
        rendered = pipeline._generate_audio(mel.float())
    audio = rendered.squeeze().detach().cpu().numpy()
    audio = librosa.util.fix_length(data=audio, size=len(vocal))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, audio, 24000, subtype="PCM_16")


if __name__ == "__main__":
    main()