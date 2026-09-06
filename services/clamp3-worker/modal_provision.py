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


@app.function(image=image, gpu=GPU, timeout=1800, volumes={"/models/clamp3": volume})
def smoke() -> dict:
    import hashlib
    import json
    import tempfile
    from pathlib import Path

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

    with tempfile.TemporaryDirectory() as directory:
        fixtures = Path(directory)
        (fixtures / "violin.mid").write_bytes(midi(69, 0))
        (fixtures / "drums.mid").write_bytes(midi(36, 9))
        result = run(fixtures)
    inventory = Path("/models/clamp3/asset_inventory.json")
    proof = {
        **result,
        "realInference": True,
        "crossModal": "text-midi",
        "assetInventorySha256": hashlib.sha256(inventory.read_bytes()).hexdigest(),
    }
    Path("/models/clamp3/smoke-proof.json").write_text(
        json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    volume.commit()
    return proof


@app.local_entrypoint()
def main(action: str = "provision") -> None:
    if action == "provision":
        print(provision.remote())
    elif action == "smoke":
        print(smoke.remote())
    else:
        raise ValueError("action must be provision or smoke")