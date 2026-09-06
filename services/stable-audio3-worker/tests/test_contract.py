import json
from pathlib import Path

SPEC = json.loads((Path(__file__).parents[1] / "model_manifest.json").read_text())
def test_two_distinct_immutable_gated_models():
    assert set(SPEC["models"]) == {"STABLE_AUDIO_3_SMALL_MUSIC", "STABLE_AUDIO_3_MEDIUM"}
    assert all(len(item["revision"]) == 40 for item in SPEC["models"].values())
    assert SPEC["models"]["STABLE_AUDIO_3_SMALL_MUSIC"]["revision"] != SPEC["models"]["STABLE_AUDIO_3_MEDIUM"]["revision"]
    assert len(SPEC["source"]["revision"]) == 40