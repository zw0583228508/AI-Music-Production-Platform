"""Transactional real Stable Audio 3 four-mode smoke; writes proof only on success."""
from __future__ import annotations
import hashlib,json,math,os,socket,tempfile
from pathlib import Path
import numpy as np
import soundfile as sf
from inference import run

ROOT=Path(__file__).parent; SPEC=json.loads((ROOT/"model_manifest.json").read_text()); ASSETS=Path(os.environ["STABLE_AUDIO3_ASSET_ROOT"])
def sha(p):
 h=hashlib.sha256()
 with open(p,"rb") as f:
  for b in iter(lambda:f.read(1048576),b""):h.update(b)
 return h.hexdigest()
def fixture(path):
 sr=44100;t=np.arange(sr*4)/sr;x=np.zeros_like(t)
 for i,f in enumerate((220,277.182631,329.627557,440)):
  m=(t>=i)&(t<i+.8);u=t[m]-i;x[m]=.25*np.minimum(u/.02,1)*np.exp(-3*u)*np.sin(2*np.pi*f*u)
 sf.write(path,x,sr,subtype="PCM_16")
 return {"sha256":sha(path),"bytes":path.stat().st_size,"sampleRate":sr,"durationSeconds":4,"generatorSha256":sha(ROOT/"fixture.py")}
def metrics(path):
 x,sr=sf.read(path,always_2d=True); return {"sha256":sha(path),"bytes":path.stat().st_size,"sampleRate":sr,"channels":x.shape[1],"durationSeconds":len(x)/sr,"peak":float(abs(x).max()),"rms":float((x*x).mean()**.5)}
def main():
 with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as probe:
  probe.settimeout(.5)
  if probe.connect_ex(("1.1.1.1",443)) == 0:
   raise RuntimeError("Stable Audio 3 smoke unexpectedly has network egress")
 with tempfile.TemporaryDirectory() as d:
  d=Path(d); inp=d/"input.wav"; input_proof=fixture(inp); models={}
  for identity in SPEC["models"]:
   modes={}
   for name,noise,start,end,duration in (("textToAudio",0,None,None,2),("audioToAudio",.8,None,None,2),("continuation",.3,None,None,6),("inpainting",0,1,2,4)):
    out=d/f"{identity}-{name}.wav"; run(identity,"original melodic instrumental smoke",duration,inp if name!="textToAudio" else None,noise,start,end,None,1,out,ASSETS)
    m=metrics(out)
    if m["peak"]<1e-5 or m["rms"]<1e-7 or m["sha256"]==input_proof["sha256"]: raise RuntimeError(f"{identity} {name} invalid output")
    if name=="inpainting":
     source,_=sf.read(inp,always_2d=True); result,_=sf.read(out,always_2d=True)
     n=min(len(source),len(result)); a,b=44100,88200
     # Exact PCM preservation is required by this task, not inferred similarity.
     if not np.array_equal(source[:a],result[:a]) or not np.array_equal(source[b:n],result[b:n]): raise RuntimeError("inpainting altered samples outside mask")
     if np.array_equal(source[a:b],result[a:b]): raise RuntimeError("inpainting did not alter masked samples")
     m["outsideMaskBitExact"]=True;m["maskedRegionChanged"]=True
    if name=="continuation":
     result,_=sf.read(out,always_2d=True); tail=result[4*44100:]
     tail_rms=float((tail*tail).mean()**.5) if len(tail) else 0
     if m["durationSeconds"]<5.9 or tail_rms<1e-7: raise RuntimeError("continuation did not generate a non-silent extension")
     m["sourceDurationSeconds"]=4;m["generatedTailRms"]=tail_rms;m["extendedBeyondSource"]=True
    modes[name]=m
   models[identity]={"realInference":True,"nonSilent":True,"modes":modes}
   proof={"schemaVersion":2,"networkAccessDenied":True,"assetManifestSha256":sha(ASSETS/SPEC["asset_manifest"]),"input":input_proof,"models":models}
  (ASSETS/SPEC["smoke_proof"]).write_text(json.dumps(proof,sort_keys=True,indent=2))
  return proof
if __name__=="__main__": print(json.dumps(main(),sort_keys=True))