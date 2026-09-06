import base64
import importlib
import sys


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