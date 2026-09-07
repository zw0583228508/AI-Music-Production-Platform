"""Create the deterministic, original Stable Audio 3 smoke input fixture."""
from __future__ import annotations
import hashlib, json, math
from pathlib import Path
import numpy as np
import soundfile as sf

SAMPLE_RATE=44100
def digest(path: Path) -> str:
 h=hashlib.sha256()
 with path.open("rb") as f:
  for b in iter(lambda:f.read(1024*1024),b""): h.update(b)
 return h.hexdigest()
def main(root: Path) -> dict:
 root.mkdir(parents=True,exist_ok=True); out=root/"deterministic-original-multinote.wav"
 t=np.arange(SAMPLE_RATE*8,dtype=np.float64)/SAMPLE_RATE; audio=np.zeros_like(t)
 # Original equal-tempered arpeggio; no external recording or model output.
 for index,frequency in enumerate((220,277.182631,329.627557,440,329.627557,277.182631,246.941651,369.994423)):
  begin=index; active=(t>=begin)&(t<begin+0.9); local=t[active]-begin
  envelope=np.minimum(local/.02,1)*np.exp(-2.8*local)
  audio[active]+=0.22*envelope*np.sin(2*math.pi*frequency*local)
 sf.write(out,audio,SAMPLE_RATE,subtype="PCM_16")
 proof={"schemaVersion":1,"generator":"services/stable-audio3-worker/fixture.py","generatorSha256":digest(Path(__file__)),"authorization":"deterministic original test input only; never a generated-output fallback","sampleRate":SAMPLE_RATE,"durationSeconds":8,"sha256":digest(out),"bytes":out.stat().st_size}
 (root/"fixture-authorization.json").write_text(json.dumps(proof,sort_keys=True,indent=2)); return proof
if __name__=="__main__": print(json.dumps(main(Path("/tmp/stable-audio3-fixture")),sort_keys=True))