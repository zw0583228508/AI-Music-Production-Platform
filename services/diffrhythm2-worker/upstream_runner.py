"""Execute the pinned DiffRhythm2 implementation with explicit offline assets."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import torch
import torchaudio
from muq import MuQMuLan
from safetensors.torch import load_file

UPSTREAM = Path("/opt/diffrhythm2")


def load_upstream():
    sys.path.insert(0, str(UPSTREAM))
    spec = importlib.util.spec_from_file_location(
        "pinned_diffrhythm2_inference", UPSTREAM / "inference.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("pinned DiffRhythm2 inference module is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--assets", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--diagnostic", required=True)
    args = parser.parse_args()

    request = json.loads(Path(args.request).read_text())
    assets = Path(args.assets)
    model_root = assets / "ASLP-lab--DiffRhythm2"
    mulan_root = assets / "OpenMuQ--MuQ-MuLan-large"
    muq_root = assets / "OpenMuQ--MuQ-large-msd-iter"
    text_root = assets / "FacebookAI--xlm-roberta-base"
    required = [
        model_root / "model.safetensors",
        model_root / "config.json",
        model_root / "decoder.bin",
        model_root / "decoder.json",
    ]
    if (
        not all(path.is_file() for path in required)
        or not (mulan_root / "pytorch_model.bin").is_file()
        or not (muq_root / "model.safetensors").is_file()
        or not (text_root / "model.safetensors").is_file()
    ):
        raise RuntimeError("immutable DiffRhythm2 conditioning assets are incomplete")
    if not torch.cuda.is_available():
        raise RuntimeError("DiffRhythm2 real inference requires CUDA")

    upstream = load_upstream()
    device = torch.device("cuda")
    config = json.loads((model_root / "config.json").read_text())
    config["use_flex_attn"] = False
    model = upstream.CFM(
        transformer=upstream.DiT(**config),
        num_channels=config["mel_dim"],
        block_size=config["block_size"],
    ).to(device)
    model.load_state_dict(load_file(str(model_root / "model.safetensors")))
    mulan_config = json.loads((mulan_root / "config.json").read_text())
    mulan_config["audio_model"]["name"] = str(muq_root)
    mulan_config["text_model"]["name"] = str(text_root)
    mulan = MuQMuLan(config=mulan_config).to(device)
    mulan_state = torch.load(
        mulan_root / "pytorch_model.bin", map_location="cpu", weights_only=True
    )
    mulan.load_state_dict(mulan_state)
    tokenizer = upstream.CNENTokenizer()
    upstream.lrc_tokenizer = tokenizer
    decoder = upstream.Generator(
        str(model_root / "decoder.json"), str(model_root / "decoder.bin")
    ).to(device)

    lyrics = request["lyrics"]
    lyrics_token = torch.tensor(
        sum(upstream.parse_lyrics(lyrics), []), dtype=torch.long, device=device
    )
    prompt_wav, sample_rate = torchaudio.load(request["rhythmPath"])
    prompt_wav = torchaudio.functional.resample(prompt_wav.to(device), sample_rate, 24000)
    prompt_wav = prompt_wav[:, : 24000 * 10].mean(dim=0, keepdim=True)
    with torch.inference_mode():
        style_embedding = mulan(wavs=prompt_wav).to(device).squeeze(0)
    model = model.half()
    decoder = decoder.half()
    style_embedding = style_embedding.half()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    upstream.inference(
        model=model,
        decoder=decoder,
        text=lyrics_token,
        style_prompt=style_embedding,
        duration=request["duration"],
        output_dir=str(output.parent),
        song_name=output.stem,
        cfg_strength=request["guidance"],
        sample_steps=request["steps"],
        fake_stereo=False,
    )
    generated = output.with_suffix(".mp3")
    if not generated.is_file() or generated.stat().st_size <= 44:
        raise RuntimeError("pinned DiffRhythm2 inference produced no valid artifact")
    diagnostic = {
        "cuda": torch.version.cuda,
        "cudaAvailable": True,
        "device": torch.cuda.get_device_name(0),
        "torch": torch.__version__,
        "dtype": "float16",
        "modelConfig": str(model_root / "config.json"),
        "checkpoint": str(model_root / "model.safetensors"),
        "mulan": str(mulan_root),
        "muq": str(muq_root),
        "textEncoder": str(text_root),
        "tokenizer": str(UPSTREAM / "g2p/g2p/vocab.json"),
        "decoderConfig": str(model_root / "decoder.json"),
        "decoderCheckpoint": str(model_root / "decoder.bin"),
        "conditioning": "MuQ-MuLan audio embedding from deterministic first 10 seconds",
        "output": str(generated),
    }
    Path(args.diagnostic).write_text(json.dumps(diagnostic, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()