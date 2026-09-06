"""Credential-free Modal configuration for the isolated SheetSage service."""
from __future__ import annotations

from pathlib import Path

APP_NAME = "sheetsage-worker"
ENDPOINT_LABEL = "sheetsage"
CANDIDATE_ENDPOINT_LABEL = "sheetsage-candidate"
RUNTIME_SECRET_NAME = "music-ai-worker-runtime"
LICENSE_SECRET_NAME = "sheetsage-noncommercial-license-v1"
MODEL_VOLUME_NAME = "sheetsage-models-v1"
SMOKE_VOLUME_NAME = "sheetsage-smoke-v1"
RECOVERY_DRILL_STATE_NAME = "sheetsage-recovery-drill-state-v1"
MODEL_MOUNT = "/var/lib/sheetsage/assets"
SMOKE_MOUNT = "/var/lib/sheetsage/smoke"
MIB = 1024 * 1024
MAX_AUDIO_BYTES = 512 * MIB
TEMP_DISK_HEADROOM_BYTES = 256 * MIB
EPHEMERAL_DISK_MIB = 2048
# Modal 1.5 serializes this resource request in KiB even though capacity policy
# is easier to reason about in MiB. Keep both units explicit.
EPHEMERAL_DISK_KIB = EPHEMERAL_DISK_MIB * 1024
MAX_SPOOLED_ANALYSES = 1
MAX_CONCURRENT_INPUTS = 2
WORKER_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = next(
    (item for item in (WORKER_ROOT, *WORKER_ROOT.parents) if (item / "pnpm-workspace.yaml").is_file()),
    WORKER_ROOT,
)


def image_build_args() -> dict[str, str]:
    # The project owner explicitly accepted the non-commercial weight licenses.
    return {"SHEETSAGE_ACCEPT_MODEL_LICENSE": "1"}


def worker_environment() -> dict[str, str]:
    return {
        "SHEETSAGE_ASSET_ROOT": MODEL_MOUNT,
        "SHEETSAGE_CACHE_DIR": MODEL_MOUNT,
        "SHEETSAGE_MAX_AUDIO_BYTES": str(MAX_AUDIO_BYTES),
        "SHEETSAGE_MAX_SPOOLED_ANALYSES": str(MAX_SPOOLED_ANALYSES),
        "SHEETSAGE_TEMP_DISK_HEADROOM_BYTES": str(TEMP_DISK_HEADROOM_BYTES),
        "XDG_CACHE_HOME": MODEL_MOUNT,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "PYTHONUNBUFFERED": "1",
    }


def validate_worker_capacity(
    environment: dict[str, str],
    *,
    ephemeral_disk_mib: int,
    max_concurrent_inputs: int,
) -> None:
    """Reject a Modal blueprint whose admission policy cannot fit its disk."""
    try:
        max_audio_bytes = int(environment["SHEETSAGE_MAX_AUDIO_BYTES"])
        headroom_bytes = int(environment["SHEETSAGE_TEMP_DISK_HEADROOM_BYTES"])
        max_spooled_analyses = int(environment["SHEETSAGE_MAX_SPOOLED_ANALYSES"])
    except (KeyError, ValueError) as exc:
        raise ValueError("SheetSage capacity environment must contain integer limits") from exc

    if min(max_audio_bytes, ephemeral_disk_mib, max_concurrent_inputs, max_spooled_analyses) < 1:
        raise ValueError("SheetSage capacity limits must be positive")
    if headroom_bytes < 0:
        raise ValueError("SheetSage temporary disk headroom cannot be negative")
    if max_spooled_analyses > max_concurrent_inputs:
        raise ValueError("SheetSage spooled analyses exceed Modal input concurrency")

    available_bytes = ephemeral_disk_mib * MIB
    required_bytes = max_audio_bytes + headroom_bytes
    if required_bytes > available_bytes:
        raise ValueError(
            "SheetSage upload plus temporary disk headroom exceeds Modal ephemeral disk"
        )
