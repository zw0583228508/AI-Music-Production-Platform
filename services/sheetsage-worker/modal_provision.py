"""Remote asset provisioning and real-fixture smoke for SheetSage Modal."""
from __future__ import annotations

import os
from pathlib import Path
import sys
import importlib
import json
from datetime import datetime, timezone

_PACKAGE_ROOT = Path("/app") if Path("/app/modal_config.py").is_file() else Path(__file__).resolve().parent
sys.path.insert(0, str(_PACKAGE_ROOT))

import modal

from modal_config import (
    APP_NAME, LICENSE_SECRET_NAME, MODEL_MOUNT, MODEL_VOLUME_NAME, RECOVERY_DRILL_STATE_NAME,
    REPOSITORY_ROOT, RUNTIME_SECRET_NAME, SMOKE_MOUNT, SMOKE_VOLUME_NAME, WORKER_ROOT,
    image_build_args, worker_environment,
)

app = modal.App(f"{APP_NAME}-provision")
image = modal.Image.from_dockerfile(
    WORKER_ROOT / "Dockerfile", context_dir=REPOSITORY_ROOT, build_args=image_build_args()
)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
smoke_volume = modal.Volume.from_name(SMOKE_VOLUME_NAME, create_if_missing=False)
runtime_secret = modal.Secret.from_name(RUNTIME_SECRET_NAME)
license_secret = modal.Secret.from_name(LICENSE_SECRET_NAME)
recovery_drill_state = modal.Dict.from_name(
    RECOVERY_DRILL_STATE_NAME, create_if_missing=True
)
with (WORKER_ROOT / "model_manifest.json").open() as manifest_file:
    RECOVERY_SPEC = json.load(manifest_file)["recovery"]
RECOVERY_SUCCESS_MAX_AGE_SECONDS = (
    int(RECOVERY_SPEC["drill_success_max_age_hours"]) * 60 * 60
)
RECOVERY_SUCCESS_KEY = "last_success"


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
    completed_at = datetime.now(timezone.utc)
    verification = {
        "verified": result["verified"],
        "assetCount": result["assets"],
        "productionVolumeMounted": False,
    }
    recovery_drill_state[RECOVERY_SUCCESS_KEY] = {
        "completedAt": completed_at.isoformat(),
        "verification": verification,
    }
    return {
        "verified": result["verified"],
        "assets": result["assets"],
        "archiveSha256": result["archiveSha256"],
        "productionVolumeMounted": False,
        "completedAt": completed_at.isoformat(),
    }


def require_fresh_recovery_drill(
    record: object, now: datetime | None = None
) -> dict:
    """Reject missing, malformed, or stale success records without exposing secrets."""
    checked_at = now or datetime.now(timezone.utc)
    try:
        if not isinstance(record, dict):
            raise ValueError
        completed_at = datetime.fromisoformat(str(record["completedAt"]))
        if completed_at.tzinfo is None:
            raise ValueError
        age_seconds = (checked_at - completed_at).total_seconds()
        verification = record["verification"]
        if (
            not isinstance(verification, dict)
            or verification.get("verified") is not True
            or not isinstance(verification.get("assetCount"), int)
            or verification.get("productionVolumeMounted") is not False
        ):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise RuntimeError(
            "SheetSage recovery drill has no valid successful heartbeat; "
            "verify the scheduled drill and Modal deployment"
        ) from None
    if age_seconds < 0 or age_seconds > RECOVERY_SUCCESS_MAX_AGE_SECONDS:
        raise RuntimeError(
            "SheetSage recovery drill success heartbeat is stale; "
            f"last success was {completed_at.isoformat()}; "
            "verify the scheduled drill and Modal deployment"
        )
    return {
        "healthy": True,
        "lastSuccessAt": completed_at.isoformat(),
        "assetCount": verification["assetCount"],
    }


@app.function(
    image=image,
    schedule=modal.Cron("0 12 * * *"),
    timeout=5 * 60,
    max_containers=1,
)
def monitor_recovery_drill_freshness() -> dict:
    """Alert through Modal when the durable recovery success heartbeat is stale."""
    return require_fresh_recovery_drill(
        recovery_drill_state.get(RECOVERY_SUCCESS_KEY)
    )
