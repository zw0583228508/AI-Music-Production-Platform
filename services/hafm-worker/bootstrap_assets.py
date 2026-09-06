"""Network is permitted only during this immutable-model provisioning step."""
from __future__ import annotations
import hashlib,json,os
from pathlib import Path
ROOT=Path(__file__).parent;SPEC=json.loads((ROOT/"model_manifest.json").read_text());A=Path(os.getenv("HAFM_ASSET_ROOT",SPEC["asset_root"]))
def sha(p):
 h=hashlib.sha256()
 with p.open("rb") as f:
  for b in iter(lambda:f.read(1048576),b""):h.update(b)
 return h.hexdigest()
def main():
 from huggingface_hub import snapshot_download
 dest=A/"snapshot";dest.mkdir(parents=True,exist_ok=True);snapshot_download(SPEC["model"]["repository"],revision=SPEC["model"]["revision"],local_dir=dest,local_dir_use_symlinks=False)
 files=[{"path":p.relative_to(dest).as_posix(),"bytes":p.stat().st_size,"sha256":sha(p)} for p in sorted(dest.rglob("*")) if p.is_file()]
 if not files:raise RuntimeError("HAFM snapshot is empty")
 tree=hashlib.sha256("\n".join(f'{x["path"]}\0{x["sha256"]}' for x in files).encode()).hexdigest()
 (A/SPEC["asset_manifest"]).write_text(json.dumps({"provider":"HAFM","source":SPEC["source"],"model":SPEC["model"],"path":"snapshot","files":files,"treeSha256":tree},indent=2,sort_keys=True))
if __name__=="__main__":main()