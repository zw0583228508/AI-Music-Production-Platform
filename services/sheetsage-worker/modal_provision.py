"""Remote asset provisioning and real-fixture smoke for SheetSage Modal."""
from __future__ import annotations

import os
from pathlib import Path
import sys
import importlib

_PACKAGE_ROOT = Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent
sys.path.insert(0, str(_PACKAGE_ROOT))

import modal

from modal_config import (
    APP_NAME, LICENSE_SECRET_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME, REPOSITORY_ROOT, RUNTIME_SECRET_NAME,
    SMOKE_MOUNT, SMOKE_VOLUME_NAME, WORKER_ROOT, image_build_args, worker_environment,
)

app = modal.App(f"{APP_NAME}-provision")
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT, build_args=image_build_args()
)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
smoke_volume = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=False)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
license_secret = modal.Secret.from_name(LICENSE_SECRET_NAME)


@app.function(
    image=image, secrets=[runtime_secret, license_secret],
    volumes={MODEL_MOUNT: model_volume, SMOKE_MOUNT: smoke_volume},
    timeout=24 * 60 * 60, max_containers=1, env=worker_environment(),
)
def provision_assets() -> dict:
    """Preload package-declared handcrafted and downbeat assets directly."""
    os.environ["HF_HUB_OFFLINE"] = "0"
    os.environ["TRANSFORMERS_OFFLINE"] = "0"
    from bootstrap_assets import main
    main()
    from app import asset_state
    verified, message, inventory = asset_state()
    if not verified or not inventory:
        raise RuntimeError(f"asset verification failed: {message}")
    model_volume.commit()
    return {"assets": len(inventory["assets"]), "verified": True}


@app.function(
    image=image, secrets=[runtime_secret, license_secret],
    volumes={MODEL_MOUNT: model_volume},
    timeout=24 * 60 * 60, max_containers=1, env=worker_environment(),
)
def restore_assets() -> dict:
    """Restore all licensed assets from the owner's private recovery archive."""
    from bootstrap_assets import restore_from_recovery_source
    restore_from_recovery_source()
    from app import asset_state
    verified, message, inventory = asset_state()
    if not verified or not inventory:
        raise RuntimeError(f"restored asset verification failed: {message}")
    model_volume.commit()
    return {"assets": len(inventory["assets"]), "verified": True, "restored": True}


@app.function(
    image=image, secrets=[runtime_secret, license_secret],
    volumes={MODEL_MOUNT: model_volume, SMOKE_MOUNT: smoke_volume},
    timeout=600, max_containers=1, env=worker_environment(),
)
def smoke_remote(fixture_name: str) -> dict:
    """Run actual inference on an uploaded licensed fixture and persist proof."""
    candidate = Path(SMOKE_MOUNT) / Path(fixture_name).name
    if not candidate.is_file():
        raise RuntimeError("uploaded real-audio smoke fixture is unavailable")
    os.environ["SHEETSAGE_SMOKE_AUDIO"] = str(candidate)
    try:
        run_real_smoke()
        proof = Path(MODEL_MOUNT) / "smoke-proof.json"
        if not proof.is_file():
            raise RuntimeError("real inference smoke did not persist proof")
        from app import ASSET_MANIFEST, _digest
        return {
            "smokeProof": str(proof),
            "fixture": candidate.name,
            "manifestSha256": _digest(ASSET_MANIFEST),
        }
    finally:
        model_volume.commit()


@app.local_entrypoint()
def main(
    action: str = "provision",
    fixture: str = "",
) -> None:
    if action == "provision":
        print(provision_assets.remote())
    elif action == "restore":
        print(restore_assets.remote())
    elif action == "drill":
        print(drill_recovery_assets.remote())
    elif action == "smoke":
        if not fixture:
            raise ValueError("fixture must name a previously uploaded volume file")
        print(smoke_remote.remote(fixture))
    else:
        raise ValueError("action must be provision, restore, drill, or smoke")

def run_real_smoke() -> None:
    """Execute inference on every release, including in a reused container."""
    loaded = sys.modules.get("smoke")
    if loaded is None:
        importlib.import_module("smoke")
    else:
        importlib.reload(loaded)

@app.function(
    image=image, secrets=[runtime_secret, license_secret],
    schedule=modal.Cron("0 9 * * 1"),
    timeout=60 * 60, max_containers=1, env=worker_environment(),
)
def drill_recovery_assets() -> dict:
    """Verify recovery readiness without mounting or committing the model volume."""
    try:
        from bootstrap_assets import drill_recovery_source
        result = drill_recovery_source()
    except Exception:
        raise RuntimeError(
            "SheetSage recovery drill failed; verify the private archive, its access, "
            "the configured archive checksum, and the committed asset manifest"
        ) from None
    return {
        "verified": result["verified"],
        "assets": result["assets"],
        "archiveSha256": result["archiveSha256"],
        "productionVolumeMounted": False,
    }
