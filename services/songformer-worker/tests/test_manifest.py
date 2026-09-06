import json
from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_songformer_model_and_license_identities_are_immutable():
    model = json.loads((ROOT / "model_manifest.json").read_text())
    license_data = json.loads((ROOT / "license_manifest.json").read_text())
    assert model["provider"] == "SONGFORMER"
    assert len(model["source"]["commit"]) == 40
    assert len(model["huggingFace"]["revision"]) == 40
    assert {item["path"] for item in model["assets"]} >= {
        "SongFormer.safetensors", "MusicFM/pretrained_msd.pt", "MusicFM/msd_stats.json"
    }
    assert license_data["modelLicense"] == "CC-BY-4.0"