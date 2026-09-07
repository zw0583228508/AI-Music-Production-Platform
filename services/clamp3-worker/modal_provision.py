import os
from pathlib import Path

import modal

from modal_config import APP_NAME, ASSET_VOLUME, GPU

ROOT = Path(__file__).resolve().parent
app = modal.App(f"{APP_NAME}-provision")
volume = modal.Volume.from_name(ASSET_VOLUME, create_if_missing=True)
image = modal.Image.from_dockerfile(ROOT / "Dockerfile", context_dir=ROOT)


@app.function(
    image=image,
    timeout=86400,
    volumes={"/models/clamp3": volume},
    env={"HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "0", "HF_DATASETS_OFFLINE": "0"},
)
def provision() -> dict:
    from bootstrap_assets import provision as run

    result = run(Path("/models/clamp3"))
    volume.commit()
    return {"fileCount": result["fileCount"], "totalBytes": result["totalBytes"]}


@app.function(
    image=image,
    gpu=GPU,
    timeout=1800,
    volumes={"/models/clamp3": volume},
    env={"CLAMP3_NETWORK_ISOLATION": "modal-block-network-v1"},
    block_network=True,
)
def smoke() -> dict:
    import hashlib
    import json
    import tempfile
    from pathlib import Path

    import torch
    from accelerate import Accelerator

    from runtime_user import drop_runtime_privileges
    drop_runtime_privileges()

    from inference import verified_installation_identity
    from smoke import run

    def midi(note: int, channel: int) -> bytes:
        track = bytes([
            0x00, 0xC0 | channel, 0x00,
            0x00, 0x90 | channel, note, 0x64,
            0x83, 0x60, 0x80 | channel, note, 0x00,
            0x00, 0xFF, 0x2F, 0x00,
        ])
        return b"MThd" + (6).to_bytes(4, "big") + b"\x00\x00\x00\x01\x01\xe0" + \
            b"MTrk" + len(track).to_bytes(4, "big") + track

    if not torch.cuda.is_available():
        raise RuntimeError("CLaMP3 real smoke requires CUDA")
    accelerator_device = str(Accelerator().device)
    if not accelerator_device.startswith("cuda"):
        raise RuntimeError(f"CLaMP3 extractor resolved non-CUDA device {accelerator_device}")
    with tempfile.TemporaryDirectory() as directory:
        fixtures = Path(directory)
        (fixtures / "violin.mid").write_bytes(midi(69, 0))
        (fixtures / "drums.mid").write_bytes(midi(36, 9))
        result = run(fixtures)
    inventory = Path("/models/clamp3/asset_inventory.json")
    proof = {
        **result,
        "realInference": True,
        "crossModal": ["text-audio", "midi-audio"],
        "device": {
            "type": "cuda",
            "accelerateDevice": accelerator_device,
            "name": torch.cuda.get_device_name(0),
            "count": torch.cuda.device_count(),
        },
        "installationIdentity": verified_installation_identity(),
        "assetInventorySha256": hashlib.sha256(inventory.read_bytes()).hexdigest(),
    }
    Path("/models/clamp3/smoke-proof.json").write_text(
        json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    volume.commit()
    return proof


@app.function(image=image, timeout=300, volumes={"/models/clamp3": volume})
def prepare_runtime_permissions() -> dict:
    proof = Path("/models/clamp3/smoke-proof.json")
    if not proof.is_file():
        raise RuntimeError("retained CLaMP3 smoke proof is absent")
    os.chown(proof, 10001, 10001)
    proof.chmod(0o600)
    volume.commit()
    stat = proof.stat()
    return {"uid": stat.st_uid, "gid": stat.st_gid, "mode": oct(stat.st_mode & 0o777)}


@app.local_entrypoint()
def main(action: str = "provision") -> None:
    if action == "provision":
        print(provision.remote())
    elif action == "smoke":
        print(smoke.remote())
    elif action == "prepare-runtime":
        print(prepare_runtime_permissions.remote())
    else:
        raise ValueError("action must be provision, prepare-runtime, or smoke")