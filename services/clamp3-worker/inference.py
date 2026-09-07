"""Offline adapter around the pinned upstream CLaMP 3 feature extractor."""

from __future__ import annotations

import base64
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np

MODEL_REVISION = "355625cc1c6f73726bbcd0eb9276ac7152d56426"
SOURCE_REVISION = "9016d2b0c8d12d1aa79c2e0ab201e6822bdc83a8"
EXPECTED_ASSET_INVENTORY_SHA256 = "7ef3b9b9999a9f5d8c87a6aaade8fb031844c8b7b7f8c4444958aadebcc92103"
EXPECTED_SOURCE_TREE_SHA256 = "3845250edf79a8749f8862bf8683953e801b838614579a9b240c72980a14f54b"
EXPECTED_RUNTIME_IDENTITY_SHA256 = "12fb9b2b668e5d0fb7b86c029ea07c03d7d248371553d1aeba26b7c1ba2f2087"
EXPECTED_CHECKPOINT_SHA256 = "5033f868e3977be3945ee416b5a1718d5589a173c7ba8982231d8c94a6441d80"
EXPECTED_RUNTIME_UID = 10001
EXPECTED_RUNTIME_GID = 10001
EXPECTED_NETWORK_ISOLATION = "modal-block-network-v1"
MERT_REVISION = "12af15fef9d0ac838c3f475bfbbf26d2060dd4f5"
EXPECTED_RUNTIME_ADAPTER_SHA256 = "c59ff9dea565a01b2a81a29fb10030adaed87c81411fa6d2f32a34d5bd9d4112"
MERT_ARGUMENT = "--model_path m-a-p/MERT-v1-95M --mean_features"
EXPECTED_RUNTIME = {
    "python": "3.11.11",
    "packages": {
        "accelerate": "0.34.0",
        "numpy": "1.26.4",
        "torch": "2.4.1",
        "transformers": "4.40.0",
    },
}
WEIGHT_NAME = (
    "weights_clamp3_saas_h_size_768_t_model_FacebookAI_xlm-roberta-base_"
    "t_length_128_a_size_768_a_layers_12_a_length_128_s_size_768_s_layers_"
    "12_p_size_64_p_length_512.pth"
)
EXTENSIONS = {"text": ".txt", "audio": ".wav", "midi": ".mid", "score": ".musicxml"}
_LOCK = threading.Lock()


class AssetsUnavailable(RuntimeError):
    pass


def _root() -> Path:
    return Path(os.environ.get("CLAMP3_ASSET_ROOT", "/models/clamp3"))


def _source() -> Path:
    return Path(os.environ.get("CLAMP3_SOURCE_ROOT", "/opt/clamp3"))


def _scratch() -> Path:
    return Path(os.environ.get("CLAMP3_SCRATCH_ROOT", "/var/tmp/clamp3"))


def _snapshot(repository: str, revision: str) -> Path:
    return _root() / "hf" / f"models--{repository.replace('/', '--')}" / "snapshots" / revision


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_sha256(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _verify_asset_inventory() -> dict:
    root = _root()
    inventory_path = root / "asset_inventory.json"
    if not inventory_path.is_file():
        raise AssetsUnavailable("asset inventory is absent")
    if _sha256(inventory_path) != EXPECTED_ASSET_INVENTORY_SHA256:
        raise AssetsUnavailable("asset inventory identity does not match the approved release")
    try:
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AssetsUnavailable("asset inventory is invalid") from exc
    files = inventory.get("files")
    if (
        inventory.get("schemaVersion") != 1
        or not isinstance(files, list)
        or inventory.get("fileCount") != len(files)
        or inventory.get("totalBytes") != sum(
            item.get("bytes", -1) for item in files if isinstance(item, dict)
        )
    ):
        raise AssetsUnavailable("asset inventory summary is invalid")
    expected: dict[str, dict] = {}
    for item in files:
        if not isinstance(item, dict):
            raise AssetsUnavailable("asset inventory contains an invalid entry")
        relative = item.get("path")
        if (
            not isinstance(relative, str)
            or not relative
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or relative in expected
            or not isinstance(item.get("bytes"), int)
            or not isinstance(item.get("sha256"), str)
        ):
            raise AssetsUnavailable("asset inventory contains an unsafe entry")
        expected[relative] = item
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
        and path.relative_to(root).as_posix()
        not in {"asset_inventory.json", "smoke-proof.json"}
    }
    if actual != set(expected):
        raise AssetsUnavailable("installed asset paths do not match the approved inventory")
    inode_hashes: dict[tuple[int, int, int], str] = {}
    for relative, item in expected.items():
        path = root / relative
        stat = path.stat()
        if stat.st_size != item["bytes"]:
            raise AssetsUnavailable(f"asset size drift detected: {relative}")
        inode = (stat.st_dev, stat.st_ino, stat.st_size)
        if inode not in inode_hashes:
            inode_hashes[inode] = _sha256(path)
        digest = inode_hashes[inode]
        if digest != item["sha256"]:
            raise AssetsUnavailable(f"asset checksum drift detected: {relative}")
    return {
        "assetInventorySha256": EXPECTED_ASSET_INVENTORY_SHA256,
        "assetFileCount": len(files),
        "assetTotalBytes": inventory["totalBytes"],
    }


def _verify_source_tree() -> dict:
    source = _source()
    records = []
    for path in sorted(
        item
        for item in source.rglob("*")
        if item.is_file() and ".git" not in item.relative_to(source).parts
    ):
        relative = path.relative_to(source).as_posix()
        if relative == f"code/{WEIGHT_NAME}":
            continue
        records.append(
            {
                "path": relative,
                "bytes": path.stat().st_size,
                "sha256": _sha256(path),
            }
        )
    digest = _canonical_sha256(records)
    if len(records) != 42 or digest != EXPECTED_SOURCE_TREE_SHA256:
        raise AssetsUnavailable("installed source tree does not match the approved revision")
    redirects = {
        _source() / "preprocessing/audio/logs": _scratch() / "audio-logs",
        _source() / "preprocessing/midi/logs": _scratch() / "midi-logs",
    }
    if any(
        not link.is_symlink()
        or link.resolve() != target.resolve()
        or not target.is_dir()
        for link, target in redirects.items()
    ):
        raise AssetsUnavailable("upstream runtime logs are not isolated from the source tree")
    return {
        "sourceRevision": SOURCE_REVISION,
        "sourceTreeSha256": digest,
    }


def _verify_runtime() -> dict:
    identity = {
        "python": platform.python_version(),
        "packages": {
            package: importlib.metadata.version(package)
            for package in EXPECTED_RUNTIME["packages"]
        },
    }
    if identity != EXPECTED_RUNTIME:
        raise AssetsUnavailable("installed Python runtime does not match the approved release")
    digest = _canonical_sha256(identity)
    if digest != EXPECTED_RUNTIME_IDENTITY_SHA256:
        raise AssetsUnavailable("runtime identity checksum is invalid")
    return {
        "runtimeIdentity": identity,
        "runtimeIdentitySha256": digest,
    }


def _verify_runtime_user() -> dict:
    uid = os.geteuid()
    gid = os.getegid()
    if uid != EXPECTED_RUNTIME_UID or gid != EXPECTED_RUNTIME_GID:
        raise AssetsUnavailable("worker is not running under the approved non-root identity")
    return {"effectiveUid": uid, "effectiveGid": gid, "runtimeUser": "clamp3"}


def _verify_network_isolation() -> dict:
    mechanism = os.environ.get("CLAMP3_NETWORK_ISOLATION")
    if mechanism != EXPECTED_NETWORK_ISOLATION:
        raise AssetsUnavailable("platform network isolation is not configured")
    return {"networkAtRuntime": False, "networkIsolation": mechanism}


def _runtime_adapter_bytes() -> bytes:
    source = (_source() / "utils.py").read_text(encoding="utf-8")
    if source.count(MERT_ARGUMENT) != 1:
        raise AssetsUnavailable("upstream MERT model argument does not match the approved adapter")
    local_argument = (
        f'--model_path "{_snapshot("m-a-p/MERT-v1-95M", MERT_REVISION)}" '
        "--mean_features"
    )
    adapted = source.replace(MERT_ARGUMENT, local_argument).encode()
    if hashlib.sha256(adapted).hexdigest() != EXPECTED_RUNTIME_ADAPTER_SHA256:
        raise AssetsUnavailable("runtime MERT adapter identity drift detected")
    return adapted


def verified_installation_identity() -> dict:
    identity = {
        **_verify_asset_inventory(),
        **_verify_source_tree(),
        **_verify_runtime(),
        **_verify_runtime_user(),
        **_verify_network_isolation(),
        **_verify_weight_link(),
        "runtimeAdapterSha256": hashlib.sha256(_runtime_adapter_bytes()).hexdigest(),
        "modelRevision": MODEL_REVISION,
    }
    return identity


def readiness() -> tuple[bool, list[str]]:
    try:
        verified_installation_identity()
    except (AssetsUnavailable, OSError, ValueError) as exc:
        return False, [str(exc)]
    return True, []


def _materialize(item: dict, path: Path) -> None:
    modality = item.get("modality")
    if modality not in EXTENSIONS:
        raise ValueError(f"unsupported modality: {modality!r}")
    if modality == "text":
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text input must contain non-empty text")
        path.write_text(text, encoding="utf-8")
        return
    encoded = item.get("dataBase64")
    if not isinstance(encoded, str):
        raise ValueError(f"{modality} input requires dataBase64")
    try:
        data = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise ValueError("dataBase64 is invalid") from exc
    if not data or len(data) > 64 * 1024 * 1024:
        raise ValueError("binary input must be between 1 byte and 64 MiB")
    path.write_bytes(data)


def _verify_weight_link() -> dict:
    source_weight = _snapshot("sander-wood/clamp3", MODEL_REVISION) / WEIGHT_NAME
    target = _source() / "code" / WEIGHT_NAME
    # The image creates this link while it is still built as root.  Runtime
    # must never modify the pinned upstream source tree; the link still binds
    # the immutable, offline model volume to the upstream extractor.
    if not target.is_symlink() or target.resolve() != source_weight.resolve():
        raise AssetsUnavailable("pinned checkpoint link is absent or invalid")
    return {"checkpointBindingSha256": EXPECTED_CHECKPOINT_SHA256}


def embed(item: dict, *, verify_identity: bool = True) -> np.ndarray:
    if verify_identity:
        verified_installation_identity()
    env = os.environ.copy()
    env.update(
        {
            "HF_HOME": str(_root() / "hf"),
            "HF_HUB_CACHE": str(_root() / "hf"),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
        }
    )
    with _LOCK, tempfile.TemporaryDirectory(prefix="clamp3-") as scratch:
        _verify_weight_link()
        scratch_path = Path(scratch)
        runtime_source = scratch_path / "source"
        shutil.copytree(_source(), runtime_source, symlinks=True)
        runtime_source.chmod(0o700)
        for directory in runtime_source.rglob("*"):
            if directory.is_dir() and not directory.is_symlink():
                directory.chmod(0o700)
        runtime_utils = runtime_source / "utils.py"
        runtime_utils.chmod(0o600)
        runtime_utils.write_bytes(_runtime_adapter_bytes())
        input_dir, output_dir = scratch_path / "input", scratch_path / "output"
        input_dir.mkdir()
        modality = item.get("modality")
        if modality not in EXTENSIONS:
            raise ValueError(f"unsupported modality: {modality!r}")
        item_path = input_dir / f"item{EXTENSIONS[modality]}"
        _materialize(item, item_path)
        completed = subprocess.run(
            ["python", "clamp3_embd.py", str(input_dir), str(output_dir), "--get_global"],
            cwd=runtime_source,
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=900,
            check=False,
        )
        if completed.returncode:
            message = completed.stderr.strip().splitlines()[-1:] or ["upstream extraction failed"]
            raise RuntimeError(message[0])
        outputs = list(output_dir.rglob("*.npy"))
        if len(outputs) != 1:
            raise RuntimeError(f"expected one embedding, received {len(outputs)}")
        vector = np.asarray(np.load(outputs[0]), dtype=np.float32).reshape(-1)
        if vector.size != 768 or not np.isfinite(vector).all():
            raise RuntimeError("upstream returned an invalid embedding")
        return vector


def similarity(left: dict, right: dict) -> dict:
    identity = verified_installation_identity()
    first = embed(left, verify_identity=False)
    second = embed(right, verify_identity=False)
    denominator = float(np.linalg.norm(first) * np.linalg.norm(second))
    if denominator == 0:
        raise RuntimeError("upstream returned a zero-norm embedding")
    score = float(np.dot(first, second) / denominator)
    return {
        "similarity": max(-1.0, min(1.0, score)),
        "model": "CLaMP3",
        "provenance": {
            **identity,
            "leftSha256": _input_digest(left),
            "rightSha256": _input_digest(right),
        },
    }


def _input_digest(item: dict) -> str:
    canonical = json.dumps(item, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()