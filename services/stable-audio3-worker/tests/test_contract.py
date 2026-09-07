import json
import hashlib
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
def test_two_distinct_immutable_gated_models():
    assert set(SPEC["models"]) == {"STABLE_AUDIO_3_SMALL_MUSIC", "STABLE_AUDIO_3_MEDIUM"}
    assert all(len(item["revision"]) == 40 for item in SPEC["models"].values())
    assert SPEC["models"]["STABLE_AUDIO_3_SMALL_MUSIC"]["revision"] != SPEC["models"]["STABLE_AUDIO_3_MEDIUM"]["revision"]
    assert len(SPEC["source"]["revision"]) == 40

def test_retained_real_four_mode_evidence_matches_inventory():
    evidence = ROOT / "release-evidence"
    proof = json.loads((evidence / "smoke-proof.json").read_text())
    assert proof["schemaVersion"] == 2
    assert proof["networkAccessDenied"] is True
    inventory = evidence / "asset-inventory.json"
    assert proof["assetManifestSha256"] == hashlib.sha256(inventory.read_bytes()).hexdigest()
    for identity in SPEC["models"]:
        model = proof["models"][identity]
        assert model["realInference"] is True
        assert model["nonSilent"] is True
        assert set(model["modes"]) == {"textToAudio", "audioToAudio", "continuation", "inpainting"}
        continuation = model["modes"]["continuation"]
        assert continuation["extendedBeyondSource"] is True
        assert continuation["durationSeconds"] > continuation["sourceDurationSeconds"]
        assert continuation["generatedTailRms"] > 1e-7
        assert model["modes"]["inpainting"]["outsideMaskBitExact"] is True
        assert model["modes"]["inpainting"]["maskedRegionChanged"] is True

def test_retained_live_health_binds_each_exact_identity():
    evidence = ROOT / "release-evidence"
    for suffix, identity in (("small", "STABLE_AUDIO_3_SMALL_MUSIC"), ("medium", "STABLE_AUDIO_3_MEDIUM")):
        health = json.loads((evidence / f"live-health-{suffix}.json").read_text())
        assert health["provider"] == identity
        assert health["modelVersion"] == SPEC["models"][identity]["revision"]
        assert health["status"] == "ready"
        assert health["healthy"] is True
        assert health["smokeTested"] is True
        assert health["networkAccessDenied"] is True
        assert health["checkpointSha256"] == "e80417495444e51b8a0053233d015a4d3a29652e0fc6d91e6b90a03a59fad654"

def test_public_api_does_not_accept_unreviewed_lora_paths():
    app_source = (ROOT / "app.py").read_text()
    assert "loraPath:" not in app_source
    assert "payload.loraPath" not in app_source
    modal_source = (ROOT / "modal_app.py").read_text()
    assert modal_source.count("block_network=True") == 2