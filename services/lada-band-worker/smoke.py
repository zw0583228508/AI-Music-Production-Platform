"""Persist evidence only after upstream inference on a real vocal WAV."""
from __future__ import annotations
import hashlib,json,os
from pathlib import Path
from inference import infer
from license_gate import require_authorization
ROOT=Path(__file__).parent;SPEC=json.loads((ROOT/"model_manifest.json").read_text());A=Path(os.getenv("LADA_BAND_ASSET_ROOT",SPEC["asset_root"]));S=Path(os.getenv("LADA_BAND_SMOKE_ROOT","/var/lib/lada-band/smoke"))
def main():
 require_authorization("LaDA-Band smoke")
 fixture=Path("/opt/lada-band/assets/smoke_vocal.wav")
 if not fixture.is_file(): raise RuntimeError("official real vocal smoke fixture is unavailable")
 S.mkdir(mode=0o750,parents=True,exist_ok=True); output=S/"real-accompaniment.wav";infer(fixture.read_bytes(),output,A,None,None)
 if output.stat().st_size<128: raise RuntimeError("LaDA-Band real-audio smoke output is invalid")
 S.joinpath(SPEC["smoke_proof"]).write_text(json.dumps({"provider":"LADA_BAND","realInference":True,"inputSha256":hashlib.sha256(fixture.read_bytes()).hexdigest(),"outputSha256":hashlib.sha256(output.read_bytes()).hexdigest(),"assetManifestSha256":hashlib.sha256((A/SPEC["asset_manifest"]).read_bytes()).hexdigest()},indent=2,sort_keys=True))
if __name__=="__main__":main()