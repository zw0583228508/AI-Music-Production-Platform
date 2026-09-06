"""Dedicated SongFormer GPU deployment and provisioning boundary.

Run bootstrap/smoke explicitly through Modal; requests and container startup
never download code, checkpoints, MuQ, or MusicFM assets.
"""
from pathlib import Path
import json, os, subprocess, sys
import modal

ROOT = Path(__file__).resolve().parent
app = modal.App("songformer-worker")
assets = modal.Volume.from_name("songformer-assets-v1", create_if_missing=True)
secret = modal.Secret.from_name("music-ai-worker-runtime")
image = modal.Image.from_dockerfile(ROOT / "Dockerfile", context_dir=ROOT)
common = {"image": image, "volumes": {"/var/lib/songformer/assets": assets},
          "secrets": [secret], "gpu": "L40S", "timeout": 3600}

@app.cls(**common)
@modal.concurrent(max_inputs=1)
class SongFormerWorker:
    @modal.asgi_app(label="songformer")
    def endpoint(self):
        from app import app as fastapi_app
        return fastapi_app

@app.function(**common)
def bootstrap() -> dict:
    """Pinned source/submodules/assets only, committed after all hashes verify."""
    run = subprocess.run([sys.executable, "bootstrap_assets.py"], cwd="/app",
                         capture_output=True, text=True, check=False, timeout=3500)
    if run.returncode:
        raise RuntimeError("SongFormer bootstrap failed without exposing command output")
    assets.commit()
    return {"provider": "SONGFORMER", "status": "bootstrapped-not-ready"}

@app.local_entrypoint()
def main(action: str = "bootstrap") -> None:
    if action != "bootstrap":
        raise ValueError("only explicit bootstrap is implemented; smoke requires a reviewed real-audio adapter")
    print(json.dumps(bootstrap.remote(), sort_keys=True))