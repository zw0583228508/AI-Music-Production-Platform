"""Provisioning-only real inference proof; no synthetic audio is accepted."""
from __future__ import annotations
import hashlib, json, os
from pathlib import Path
import soundfile as sf
from app import ASSETS, SPEC, sha
from inference import infer

def main(fixture: Path) -> dict:
    if not fixture.is_file(): raise RuntimeError("a real rhythm fixture is required")
    output=ASSETS/"smoke-output.mp3"
    infer(lyrics="[verse]\nA real voice follows the pulse\n[chorus]\nRhythm makes the song move",
          rhythm_wav=fixture.read_bytes(),output=output,style_prompt="acoustic pop",duration=8,steps=4,guidance=2)
    audio,_=sf.read(str(output)); rms=float((audio**2).mean()**.5) if len(audio) else 0
    copied=hashlib.sha256(fixture.read_bytes()).hexdigest()==sha(output)
    if rms <= 1e-5 or copied: raise RuntimeError("smoke rejected silent or copied source output")
    proof={"provider":"DIFFRHYTHM_2","realInference":True,"lyricsConditioned":True,"rhythmConditioned":True,
           "nonSilent":True,"notSourceCopy":True,"rms":rms,"artifactSha256":sha(output),
           "sourceSha256":sha(fixture),"assetManifestSha256":sha(ASSETS/SPEC["asset_manifest"])}
    (ASSETS/SPEC["smoke_proof"]).write_text(json.dumps(proof,indent=2,sort_keys=True))
    return proof
if __name__=="__main__": main(Path(os.environ["DIFFRHYTHM2_SMOKE_AUDIO"]))