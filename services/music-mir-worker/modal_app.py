"""Modal deployment boundary for the isolated CPU MIR worker.

Deploy: ``modal deploy services/music-mir-worker/modal_app.py``
Provision and smoke use the local entrypoint commands documented below.  They
are deliberately separate from deployment, and are never invoked by HTTP
requests or image startup.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import re
from pathlib import Path

import modal

APP_NAME = "music-mir-worker"
WORKER_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next(
    (parent for parent in (WORKER_ROOT, *WORKER_ROOT.parents)
     if (parent / "pnpm-workspace.yaml").is_file()),
    WORKER_ROOT,
)
ASSET_MOUNT = "/var/lib/music-mir/assets"
PY311_VOLUME_NAME = "music-mir-py311-models-smoke-v1"
PY314_VOLUME_NAME = "music-mir-py314-models-smoke-v1"
RUNTIME_SECRET_NAME = "music-ai-worker-runtime"

app = modal.App(APP_NAME)
py311_image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT)
py314_image = modal.Image.from_dockerfile(WORKER_ROOT / "Dockerfile.essentia", context_dir=REPOSITORY_ROOT)
# create_if_missing permits first-time provisioning but does not bake models into
# an image layer.  The volume is the only durable model/fixture boundary.
py311_assets = modal.Volume.from_name(PY311_VOLUME_NAME, create_if_missing=True)
py314_assets = modal.Volume.from_name(PY314_VOLUME_NAME, create_if_missing=True)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
py311_common = {
    "image": py311_image,
    "volumes": {ASSET_MOUNT: py311_assets},
    "secrets": [runtime_secret],
    "timeout": 1_200,
}
py314_common = {
    "image": py314_image,
    "volumes": {ASSET_MOUNT: py314_assets},
    "secrets": [runtime_secret],
    "timeout": 1_200,
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _relative_fixture(value: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts or not candidate.parts:
        raise ValueError("fixture path must be a relative path inside the model/smoke volume")
    return candidate


def _redacted_tail(value: str, limit: int = 2048) -> str:
    """Keep remote smoke diagnosis useful without relaying credentials/URLs."""
    tail = value[-limit:]
    tail = re.sub(r"(?i)\b(authorization|bearer)\s*[:=]?\s+[^\s\"']+", r"\1 [REDACTED]", tail)
    tail = re.sub(r"(?i)\b[A-Z0-9_]*TOKEN[A-Z0-9_]*\s*=\s*[^\s\"']+", "[REDACTED_TOKEN]", tail)
    tail = re.sub(r"(?i)\b(?:sourceurl|source_url)\s*[:=]\s*[^\s\"']+", "[REDACTED_SOURCE_URL]", tail)
    tail = re.sub(r"https?://[^\s\"']+", "[REDACTED_URL]", tail)
    return tail or "(no output)"


@app.cls(**py311_common)
@modal.concurrent(max_inputs=1)
class MusicMirWorker:
    @modal.asgi_app(label="music-mir")
    def endpoint(self):
        from app import app as fastapi_app
        return fastapi_app


@app.cls(**py314_common)
@modal.concurrent(max_inputs=1)
class MusicMirEssentiaWorker:
    @modal.asgi_app(label="music-mir-essentia")
    def endpoint(self):
        from app import app as fastapi_app
        return fastapi_app


@app.function(**py311_common)
def provision_madmom_assets() -> dict:
    """Preload Madmom in provisioning, hash every resulting byte, then commit.

    Madmom's package owns the cache location.  HOME/XDG are pinned to the
    mounted volume so its documented load path cannot place downloadable model
    bytes in ephemeral container storage.  This function must be run once and
    reviewed before its generated hash manifest can make MADMOM ready.
    """
    root = Path(ASSET_MOUNT)
    root.mkdir(parents=True, exist_ok=True)
    os.environ["XDG_CACHE_HOME"] = str(root / ".cache")
    try:
        from madmom_infer.models import downbeats_blstm
        paths = downbeats_blstm(cache_root=root / ".cache" / "madmom_infer" / "models")
        # This is the actual public Phase-2 RNN model/session constructor, not
        # an import-only assertion. It reopens the freshly hash-verified files.
        from madmom_infer.features.downbeats import RNNDownBeatProcessor
        RNNDownBeatProcessor()
    except Exception as exc:
        raise RuntimeError("MADMOM DOWNBEATS_BLSTM provisioning failed") from exc
    files = sorted(Path(path) for path in paths)
    expected = {
        item["path"]: item["sha256"]
        for item in json.loads((Path("/app") / "assets_manifest.json").read_text())["providers"]["MADMOM"]["model"]["artifacts"]
        if item["location"] == "asset-root"
    }
    records = [
        {"path": path.relative_to(root).as_posix(), "sha256": _sha256(path), "bytes": path.stat().st_size}
        for path in files
    ]
    if {item["path"]: item["sha256"] for item in records} != expected:
        raise RuntimeError("MADMOM downloaded assets do not match the reviewed pin manifest")
    temporary = root / ".madmom-assets.json.tmp"
    temporary.write_text(json.dumps(records, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, root / "madmom-assets.json")
    py311_assets.commit()
    return {"provider": "MADMOM", "assetCount": len(records), "assetsSha256": _sha256(root / "madmom-assets.json")}


def _smoke(volume, providers: tuple[str, ...], fixture_path: str) -> dict:
    """Run only the implementations exposed by this image's Python runtime."""
    fixture = Path(ASSET_MOUNT) / _relative_fixture(fixture_path)
    if not fixture.is_file():
        raise RuntimeError("uploaded real-audio smoke fixture is missing")
    environment = {
        **os.environ,
        "MIR_ASSET_ROOT": ASSET_MOUNT,
        "MIR_SMOKE_AUDIO_PATH": str(fixture),
    }
    process = subprocess.run(
        [sys.executable, "smoke_test.py"],
        cwd="/app",
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=1_100,
    )
    if process.returncode:
        raise RuntimeError(
            "MIR real-audio smoke failed; "
            f"stderr tail: {_redacted_tail(process.stderr)}; "
            f"stdout tail: {_redacted_tail(process.stdout)}"
        )
    proofs = []
    for provider in providers:
        path = Path(ASSET_MOUNT) / ".readiness" / f"{provider.lower()}.json"
        try:
            proof = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"{provider} did not persist a smoke proof") from exc
        if (
            proof.get("schemaVersion") != 2
            or proof.get("provider") != provider
            or proof.get("featureExecutionSucceeded") is not True
            or not isinstance(proof.get("identitySha256"), str)
            or not isinstance(proof.get("resultSha256"), str)
            or proof.get("sourceFixture", {}).get("retained") is not True
            or proof.get("evaluationFixture", {}).get("retained") is not False
        ):
            raise RuntimeError(f"{provider} smoke proof is invalid")
        proofs.append(proof)
    volume.commit()
    return {"status": "ok", "fixture": _relative_fixture(fixture_path).as_posix(), "providers": proofs}


@app.function(**py311_common)
def smoke_py311_remote(fixture_path: str = "_smoke/real-audio.wav") -> dict:
    """Smoke MADMOM, TORCHCREPE, and PYLOUDNORM from the py311 volume."""
    return _smoke(py311_assets, ("MADMOM", "TORCHCREPE", "PYLOUDNORM"), fixture_path)


@app.function(**py314_common)
def smoke_py314_remote(fixture_path: str = "_smoke/real-audio.wav") -> dict:
    """Smoke ESSENTIA and CHROMA from the py314 volume."""
    return _smoke(py314_assets, ("ESSENTIA", "CHROMA"), fixture_path)


@app.local_entrypoint()
def main(action: str = "smoke-py311", fixture_path: str = "_smoke/real-audio.wav") -> None:
    if action == "provision-madmom":
        print(json.dumps(provision_madmom_assets.remote(), sort_keys=True))
    elif action == "smoke-py311":
        print(json.dumps(smoke_py311_remote.remote(fixture_path), sort_keys=True))
    elif action == "smoke-py314":
        print(json.dumps(smoke_py314_remote.remote(fixture_path), sort_keys=True))
    else:
        raise ValueError("action must be 'provision-madmom', 'smoke-py311', or 'smoke-py314'")