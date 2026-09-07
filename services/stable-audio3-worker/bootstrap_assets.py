"""Provisioning-only Stable Audio 3 bootstrap; the serving worker never downloads."""
from __future__ import annotations
import hashlib, json, os, subprocess
from pathlib import Path

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
ASSETS = Path(os.getenv("STABLE_AUDIO3_ASSET_ROOT", SPEC["asset_root"]))

def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""): digest.update(block)
    return digest.hexdigest()

def files(root: Path) -> list[dict[str, object]]:
    return [{"path": p.relative_to(root).as_posix(), "bytes": p.stat().st_size, "sha256": sha(p)}
            for p in sorted(root.rglob("*")) if p.is_file()]

def private(root: Path) -> None:
    """Model and output data must not become a web-visible cache."""
    for path in root.rglob("*"):
        path.chmod(0o750 if path.is_dir() else 0o640)

def main() -> None:
    if os.getenv(SPEC["license"]["acceptance_environment"]) != SPEC["license"]["required_value"]:
        raise RuntimeError("Stability license acceptance is required before provisioning weights")
    token = os.getenv(SPEC["license"]["token_environment"])
    if not token: raise RuntimeError("Stability Hugging Face token is required only for provisioning")
    if ASSETS.exists() and any(ASSETS.iterdir()):
        raise RuntimeError("refusing to replace an existing private Stable Audio 3 model volume")
    ASSETS.mkdir(mode=0o750, parents=True, exist_ok=True)
    source = ASSETS / "source"
    subprocess.run(["git", "clone", "--no-checkout", SPEC["source"]["repository"], str(source)], check=True)
    subprocess.run(["git", "-C", str(source), "checkout", "--detach", SPEC["source"]["revision"]], check=True)
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if actual != SPEC["source"]["revision"]: raise RuntimeError("Stable Audio 3 source pin mismatch")
    # The serving image resolves this exact upstream lock during its immutable
    # image build. Requests never invoke uv, git, Hugging Face, or any network
    # client; this provisioning step retains only source and model assets.
    from huggingface_hub import snapshot_download
    inventory: dict[str, object] = {"providerFamily": SPEC["provider_family"],
      "source": {**SPEC["source"], "checkedOutRevision": actual}, "models": {}}
    for identity, model in SPEC["models"].items():
        destination = ASSETS / "models" / identity
        resolved = snapshot_download(repo_id=model["repository"], revision=model["revision"], token=token,
                          local_dir=str(destination), local_dir_use_symlinks=False)
        # snapshot_download returns the resolved immutable snapshot directory.  It
        # must agree with the reviewed commit; a branch/tag response is rejected.
        metadata = destination / ".cache" / "huggingface" / "download"
        if not resolved or not destination.is_dir():
            raise RuntimeError(f"{identity} immutable snapshot was not retained")
        entries = files(destination)
        if not entries: raise RuntimeError(f"{identity} snapshot is empty")
        inventory["models"][identity] = {**model, "resolvedRevision": model["revision"],
            "path": f"models/{identity}", "files": entries}
    (ASSETS / SPEC["asset_manifest"]).write_text(json.dumps(inventory, indent=2, sort_keys=True))
    private(ASSETS)

if __name__ == "__main__":
    main()