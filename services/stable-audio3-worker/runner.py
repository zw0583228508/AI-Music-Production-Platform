"""Pinned Stable Audio 3 runner used by the isolated worker only."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import torch
import torchaudio
from stable_audio_3 import StableAudioModel
from stable_audio_3.loading_utils import load_diffusion_cond

def localize_snapshot(value, model_root: Path):
    if isinstance(value, dict):
        return {
            key: (
                str(model_root)
                if key in {"repo_id", "model_path"}
                and isinstance(item, str)
                and item.startswith("stabilityai/stable-audio-3-")
                else localize_snapshot(item, model_root)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [localize_snapshot(item, model_root) for item in value]
    return value

def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--model",required=True); parser.add_argument("--output",required=True)
    parser.add_argument("--prompt",required=True); parser.add_argument("--duration",type=float,required=True)
    parser.add_argument("--initAudio"); parser.add_argument("--initNoiseLevel",type=float,default=0)
    parser.add_argument("--inpaintStart",type=float); parser.add_argument("--inpaintEnd",type=float)
    parser.add_argument("--loraPath"); parser.add_argument("--loraStrength",type=float,default=1)
    args=parser.parse_args()
    model_name={"STABLE_AUDIO_3_SMALL_MUSIC":"small-music","STABLE_AUDIO_3_MEDIUM":"medium"}.get(Path(args.model).name)
    if not model_name: raise RuntimeError("unreviewed Stable Audio 3 model path")
    model_root=Path(args.model).resolve()
    config_path=model_root/"model_config.json"; checkpoint_path=model_root/"model.safetensors"
    if not config_path.is_file() or not checkpoint_path.is_file():
        raise RuntimeError("immutable local Stable Audio 3 snapshot is incomplete")
    model_config=localize_snapshot(json.loads(config_path.read_text()),model_root)
    os.environ["HF_HUB_OFFLINE"]="1"
    os.environ["TRANSFORMERS_OFFLINE"]="1"
    loaded=load_diffusion_cond(model_config,str(checkpoint_path),device="cuda",model_half=True)
    model=StableAudioModel(loaded,model_config,"cuda",True)
    if args.loraPath:
        candidate=Path(args.loraPath).resolve()
        if not candidate.is_file(): raise RuntimeError("LoRA path is not an immutable local file")
        model.load_lora([str(candidate)]); model.set_lora_strength(args.loraStrength)
    kwargs={"prompt":args.prompt,"duration":args.duration,"steps":8}
    if args.initAudio:
        waveform,sample_rate=torchaudio.load(args.initAudio)
        audio=(sample_rate,waveform)
        if args.inpaintStart is not None:
            kwargs.update(inpaint_audio=audio,inpaint_mask_start_seconds=args.inpaintStart,
                          inpaint_mask_end_seconds=args.inpaintEnd)
        else: kwargs.update(init_audio=audio,init_noise_level=args.initNoiseLevel)
    rendered=model.generate(**kwargs).detach().float().cpu()
    if rendered.ndim == 3 and rendered.shape[0] == 1:
        rendered=rendered[0]
    if rendered.ndim != 2:
        raise RuntimeError(f"Stable Audio 3 returned unsupported audio shape {tuple(rendered.shape)}")
    if args.inpaintStart is not None:
        source=waveform
        if sample_rate != 44100:
            source=torchaudio.functional.resample(source,sample_rate,44100)
        if source.shape[0] != rendered.shape[0]:
            if source.shape[0] == 1:
                rendered=rendered.mean(dim=0,keepdim=True)
            else:
                raise RuntimeError("inpainting source channel layout does not match model output")
        samples=min(source.shape[-1],rendered.shape[-1])
        begin=min(samples,max(0,round(args.inpaintStart*44100)))
        end=min(samples,max(begin,round(args.inpaintEnd*44100)))
        rendered[:,:begin]=source[:,:begin]
        rendered[:,end:samples]=source[:,end:samples]
    torchaudio.save(args.output,rendered,44100)
if __name__=="__main__": main()