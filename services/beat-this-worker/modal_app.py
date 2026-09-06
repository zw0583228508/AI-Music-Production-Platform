"""Modal L4 boundary for the isolated Beat This runtime."""
from __future__ import annotations
import hashlib, json, os, re, subprocess, sys, urllib.request
from pathlib import Path
import modal

APP_NAME = os.environ.get("BEAT_THIS_MODAL_APP_NAME", "beat-this-worker").strip()
ENDPOINT_LABEL = os.environ.get("BEAT_THIS_MODAL_ENDPOINT_LABEL", "beat-this").strip()
if APP_NAME not in {"beat-this-worker", "beat-this-candidate"}:
    raise RuntimeError("invalid Beat This Modal app name")
if not re.fullmatch(r"beat-this(?:-candidate)?", ENDPOINT_LABEL):
    raise RuntimeError("invalid Beat This Modal endpoint label")
ASSET_MOUNT = "/var/lib/beat-this"
VOLUME_NAME = (
    "beat-this-models-smoke-candidate-v1"
    if APP_NAME == "beat-this-candidate"
    else "beat-this-models-smoke-v1"
)
SECRET_NAME = (
    "beat-this-candidate-runtime"
    if APP_NAME == "beat-this-candidate"
    else "music-ai-worker-runtime"
)
IDENTITY_SECRET_NAME = (
    "beat-this-candidate-deployment-identity-v1"
    if APP_NAME == "beat-this-candidate"
    else "beat-this-deployment-identity-v1"
)
SMOKE_TIMEOUT_SECONDS = 300
IMAGE_SMOKE_FIXTURE = "/app/_smoke/real-audio.wav"
ROOT = Path(__file__).resolve().parent
REPO = next((p for p in (ROOT, *ROOT.parents) if (p / "pnpm-workspace.yaml").is_file()), ROOT)
SOURCE_REVISION = os.environ.get("BEAT_THIS_SOURCE_REVISION", "").strip()
if not re.fullmatch(r"[a-f0-9]{40}", SOURCE_REVISION):
    raise RuntimeError(
        "BEAT_THIS_SOURCE_REVISION must be a full Git revision; deploy through deploy.py"
    )
app = modal.App(APP_NAME)
image = modal.Image.from_dockerfile(ROOT / "Dockerfile", context_dir=REPO)
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
secret = modal.Secret.from_name(SECRET_NAME)
identity_secret = modal.Secret.from_name(IDENTITY_SECRET_NAME)
SOURCE_IDENTITY_FILES = (
    "Dockerfile", "app.py", "modal_app.py", "model_manifest.json",
    "requirements.txt", "smoke_test.py",
)

def source_image_digest() -> str:
    digest = hashlib.sha256()
    for name in SOURCE_IDENTITY_FILES:
        path = ROOT / name
        digest.update(name.encode() + b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()

common = {"image": image, "gpu": "L4", "volumes": {ASSET_MOUNT: volume},
          "secrets": [secret, identity_secret], "timeout": 600,
          "env": {
              "BEAT_THIS_MODAL_APP_NAME": APP_NAME,
              "BEAT_THIS_MODAL_ENDPOINT_LABEL": ENDPOINT_LABEL,
              "BEAT_THIS_SOURCE_IMAGE_DIGEST": source_image_digest(),
              "BEAT_THIS_SOURCE_REVISION": SOURCE_REVISION,
          }}

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""): digest.update(block)
    return digest.hexdigest()

def tail(value: str, limit: int = 2048) -> str:
    value = re.sub(r"(?i)bearer\\s+\\S+", "Bearer [REDACTED]", value[-limit:])
    return re.sub(r"https?://\\S+", "[REDACTED_URL]", value) or "(no output)"

@app.cls(**common)
@modal.concurrent(max_inputs=1)
class BeatThisWorker:
    @modal.asgi_app(label=ENDPOINT_LABEL)
    def endpoint(self):
        from app import app as fastapi_app
        return fastapi_app

@app.function(**common)
def provision_final0() -> dict:
    manifest = json.loads((Path("/app") / "model_manifest.json").read_text())
    target = Path(ASSET_MOUNT) / manifest["checkpointPath"]
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    try:
        with urllib.request.urlopen(manifest["checkpointUrl"], timeout=300) as source, temporary.open("wb") as output:
            while block := source.read(1024 * 1024): output.write(block)
        actual = sha256(temporary)
        if actual != manifest["checkpointSha256"]:
            raise RuntimeError("downloaded final0 does not match the reviewed SHA-256")
        os.replace(temporary, target)
    finally: temporary.unlink(missing_ok=True)
    volume.commit()
    return {"provider": "BEAT_THIS", "checkpoint": "final0", "sha256": actual,
            "bytes": target.stat().st_size, "status": "provisioned-not-ready"}

@app.function(**common)
def smoke_real_audio(fixture_path: str = IMAGE_SMOKE_FIXTURE) -> dict:
    fixture = Path(fixture_path)
    if fixture.is_absolute() and fixture.as_posix() != IMAGE_SMOKE_FIXTURE:
        raise ValueError("absolute fixture_path must be the packaged image fixture")
    if ".." in fixture.parts:
        raise ValueError("fixture_path must remain inside the private volume")
    environment = {**os.environ, "BEAT_THIS_SMOKE_FIXTURE": fixture.as_posix()}
    try:
        run = subprocess.run([sys.executable, "smoke_test.py"], cwd="/app", env=environment,
                             capture_output=True, text=True, timeout=SMOKE_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        raise RuntimeError(f"BEAT_THIS smoke timed out; stderr: {tail(stderr)}; stdout: {tail(stdout)}") from exc
    if run.returncode:
        raise RuntimeError(f"BEAT_THIS smoke failed; stderr: {tail(run.stderr)}; stdout: {tail(run.stdout)}")
    proof = json.loads((Path(ASSET_MOUNT) / ".readiness" / "beat_this.json").read_text())
    volume.commit()
    return {"provider": "BEAT_THIS", "status": "smoke-attested",
            "modalImageId": os.environ.get("MODAL_IMAGE_ID", "").strip(),
            "sourceRevision": SOURCE_REVISION,
            "sourceImageDigest": source_image_digest(),
            "proof": proof}

@app.local_entrypoint()
def main(action: str = "smoke", fixture_path: str = IMAGE_SMOKE_FIXTURE) -> None:
    if action == "provision":
        print(json.dumps(provision_final0.remote(), sort_keys=True))
    elif action == "smoke":
        print(json.dumps(smoke_real_audio.remote(fixture_path), sort_keys=True))
    else:
        raise ValueError("action must be 'provision' or 'smoke'")
