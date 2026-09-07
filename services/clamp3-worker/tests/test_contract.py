import base64
import hashlib
import importlib
import json
import sys

import pytest


def _load(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAMP3_ASSET_ROOT", str(tmp_path / "assets"))
    monkeypatch.setenv("CLAMP3_SOURCE_ROOT", str(tmp_path / "source"))
    sys.path.insert(0, str(__file__).rsplit("/tests/", 1)[0])
    return importlib.import_module("inference")


def test_readiness_is_false_without_assets(monkeypatch, tmp_path):
    inference = _load(monkeypatch, tmp_path)
    ready, blockers = inference.readiness()
    assert ready is False
    assert "asset inventory is absent" in blockers


def test_binary_payload_rejects_invalid_base64(monkeypatch, tmp_path):
    inference = _load(monkeypatch, tmp_path)
    target = tmp_path / "x.mid"
    try:
        inference._materialize({"modality": "midi", "dataBase64": "not base64!"}, target)
    except ValueError as exc:
        assert "invalid" in str(exc)
    else:
        raise AssertionError("invalid base64 was accepted")


def test_binary_payload_materializes_exact_bytes(monkeypatch, tmp_path):
    inference = _load(monkeypatch, tmp_path)
    target = tmp_path / "x.mid"
    inference._materialize(
        {"modality": "midi", "dataBase64": base64.b64encode(b"MThd").decode()}, target
    )
    assert target.read_bytes() == b"MThd"


def test_complete_asset_inventory_detects_same_size_content_drift(monkeypatch, tmp_path):
    inference = _load(monkeypatch, tmp_path)
    assets = tmp_path / "assets"
    assets.mkdir()
    model = assets / "model.bin"
    model.write_bytes(b"approved")
    inventory = {
        "schemaVersion": 1,
        "fileCount": 1,
        "totalBytes": model.stat().st_size,
        "files": [{
            "path": "model.bin",
            "bytes": model.stat().st_size,
            "sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
        }],
    }
    inventory_path = assets / "asset_inventory.json"
    inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
    monkeypatch.setattr(
        inference,
        "EXPECTED_ASSET_INVENTORY_SHA256",
        hashlib.sha256(inventory_path.read_bytes()).hexdigest(),
    )
    assert inference._verify_asset_inventory()["assetFileCount"] == 1
    model.write_bytes(b"drifted!")
    with pytest.raises(inference.AssetsUnavailable, match="checksum drift"):
        inference._verify_asset_inventory()


def test_source_and_runtime_identity_drift_fail_closed(monkeypatch, tmp_path):
    inference = _load(monkeypatch, tmp_path)
    monkeypatch.setenv("CLAMP3_SCRATCH_ROOT", str(tmp_path / "scratch"))
    source = tmp_path / "source"
    source.mkdir()
    scratch = tmp_path / "scratch"
    (scratch / "audio-logs").mkdir(parents=True)
    (scratch / "midi-logs").mkdir()
    (source / "preprocessing/audio").mkdir(parents=True)
    (source / "preprocessing/midi").mkdir(parents=True)
    (source / "preprocessing/audio/logs").symlink_to(scratch / "audio-logs")
    (source / "preprocessing/midi/logs").symlink_to(scratch / "midi-logs")
    source_file = source / "clamp3_embd.py"
    source_file.write_text("approved", encoding="utf-8")
    for index in range(41):
        (source / f"source-{index:02d}.txt").write_text("approved", encoding="utf-8")
    records = []
    for path in sorted(item for item in source.rglob("*") if item.is_file()):
        records.append({
            "path": path.relative_to(source).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    monkeypatch.setattr(
        inference,
        "EXPECTED_SOURCE_TREE_SHA256",
        inference._canonical_sha256(records),
    )
    assert inference._verify_source_tree()["sourceRevision"] == inference.SOURCE_REVISION
    source_file.write_text("drifted!", encoding="utf-8")
    with pytest.raises(inference.AssetsUnavailable, match="source tree"):
        inference._verify_source_tree()
    monkeypatch.setattr(
        inference.importlib.metadata,
        "version",
        lambda package: inference.EXPECTED_RUNTIME["packages"][package],
    )
    monkeypatch.setattr(inference.platform, "python_version", lambda: "0.0.0")
    with pytest.raises(inference.AssetsUnavailable, match="Python runtime"):
        inference._verify_runtime()


def test_checkpoint_link_drift_fails_closed(monkeypatch, tmp_path):
    inference = _load(monkeypatch, tmp_path)
    source_weight = (
        tmp_path / "assets/hf/models--sander-wood--clamp3/snapshots"
        / inference.MODEL_REVISION / inference.WEIGHT_NAME
    )
    source_weight.parent.mkdir(parents=True)
    source_weight.write_bytes(b"approved checkpoint")
    target = tmp_path / "source/code" / inference.WEIGHT_NAME
    target.parent.mkdir(parents=True)
    target.symlink_to(source_weight)
    assert (
        inference._verify_weight_link()["checkpointBindingSha256"]
        == inference.EXPECTED_CHECKPOINT_SHA256
    )
    target.unlink()
    target.symlink_to(tmp_path / "wrong-checkpoint")
    with pytest.raises(inference.AssetsUnavailable, match="checkpoint link"):
        inference._verify_weight_link()


def test_runtime_user_identity_fails_closed(monkeypatch, tmp_path):
    inference = _load(monkeypatch, tmp_path)
    monkeypatch.setattr(inference.os, "geteuid", lambda: 10001)
    monkeypatch.setattr(inference.os, "getegid", lambda: 10001)
    assert inference._verify_runtime_user()["runtimeUser"] == "clamp3"
    monkeypatch.setattr(inference.os, "geteuid", lambda: 0)
    with pytest.raises(inference.AssetsUnavailable, match="non-root identity"):
        inference._verify_runtime_user()


def test_network_isolation_identity_fails_closed(monkeypatch, tmp_path):
    inference = _load(monkeypatch, tmp_path)
    monkeypatch.setenv("CLAMP3_NETWORK_ISOLATION", "modal-block-network-v1")
    assert inference._verify_network_isolation()["networkAtRuntime"] is False
    monkeypatch.delenv("CLAMP3_NETWORK_ISOLATION")
    with pytest.raises(inference.AssetsUnavailable, match="network isolation"):
        inference._verify_network_isolation()


def test_runtime_adapter_rejects_upstream_drift(monkeypatch, tmp_path):
    inference = _load(monkeypatch, tmp_path)
    source = tmp_path / "source"
    source.mkdir()
    approved = "before --model_path m-a-p/MERT-v1-95M --mean_features after"
    (source / "utils.py").write_text(approved)
    adapted = approved.replace(
        inference.MERT_ARGUMENT,
        f'--model_path "{inference._snapshot("m-a-p/MERT-v1-95M", inference.MERT_REVISION)}" --mean_features',
    ).encode()
    monkeypatch.setattr(
        inference,
        "EXPECTED_RUNTIME_ADAPTER_SHA256",
        inference.hashlib.sha256(adapted).hexdigest(),
    )
    assert inference._runtime_adapter_bytes() == adapted
    (source / "utils.py").write_text("drifted")
    with pytest.raises(inference.AssetsUnavailable, match="approved adapter"):
        inference._runtime_adapter_bytes()