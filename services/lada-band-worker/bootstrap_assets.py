"""Network-enabled provisioning only: create a hashed immutable gated snapshot."""
from __future__ import annotations
import hashlib,json,os
from pathlib import Path
ROOT=Path(__file__).parent; SPEC=json.loads((ROOT/"model_manifest.json").read_text()); LICENSE=json.loads((ROOT/"license_manifest.json").read_text())
ASSETS=Path(os.getenv("LADA_BAND_ASSET_ROOT",SPEC["asset_root"]))
def digest(path):
 h=hashlib.sha256()
 with path.open("rb") as f:
  for b in iter(lambda:f.read(1048576),b""): h.update(b)
 return h.hexdigest()
def main():
 if os.getenv(LICENSE["acceptance_environment"])!=LICENSE["required_value"]: raise RuntimeError("LaDA-Band non-commercial research acceptance is required")
 token=os.getenv(LICENSE["access_token_environment"])
 if not token: raise RuntimeError("LaDA-Band gated Hugging Face token is required only for bootstrap")
 from huggingface_hub import snapshot_download
 dst=ASSETS/"snapshot"; dst.mkdir(parents=True,exist_ok=True)
 snapshot_download(SPEC["model"]["repository"],revision=SPEC["model"]["revision"],token=token,local_dir=dst,local_dir_use_symlinks=False)
 for tree in SPEC["model"]["required_trees"]:
  if not (dst/tree).is_dir(): raise RuntimeError(f"required LaDA-Band asset tree is missing: {tree}")
 files=[{"path":p.relative_to(dst).as_posix(),"bytes":p.stat().st_size,"sha256":digest(p)} for p in sorted(dst.rglob("*")) if p.is_file()]
 if not files: raise RuntimeError("LaDA-Band snapshot is empty")
 tree_sha=hashlib.sha256("\n".join(f'{x["path"]}\0{x["sha256"]}' for x in files).encode()).hexdigest()
 (ASSETS/SPEC["asset_manifest"]).write_text(json.dumps({"provider":"LADA_BAND","source":SPEC["source"],"model":SPEC["model"],"path":"snapshot","files":files,"treeSha256":tree_sha},indent=2,sort_keys=True))
if __name__=="__main__": main()