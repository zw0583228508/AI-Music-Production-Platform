from __future__ import annotations
import hashlib,json,os
from pathlib import Path
from inference import infer
ROOT=Path(__file__).parent;SPEC=json.loads((ROOT/"model_manifest.json").read_text());A=Path(os.getenv("HAFM_ASSET_ROOT",SPEC["asset_root"]));S=Path(os.getenv("HAFM_SMOKE_ROOT","/var/lib/hafm/smoke"))
def main():
 S.mkdir(mode=0o750,parents=True,exist_ok=True);proof=S/SPEC["smoke_proof"];proof.unlink(missing_ok=True)
 source=S/SPEC["smoke_fixture"]
 if not source.is_file():raise RuntimeError(f"independently sourced real vocal smoke fixture is required at {source}")
 out=S/"real-instrumental.wav";infer(source.read_bytes(),out,A)
 if out.stat().st_size<128:raise RuntimeError("HAFM real-audio smoke output is invalid")
 proof.write_text(json.dumps({"provider":"HAFM","realInference":True,"inputSha256":hashlib.sha256(source.read_bytes()).hexdigest(),"outputSha256":hashlib.sha256(out.read_bytes()).hexdigest(),"assetManifestSha256":hashlib.sha256((A/SPEC["asset_manifest"]).read_bytes()).hexdigest()},indent=2,sort_keys=True))
if __name__=="__main__":main()