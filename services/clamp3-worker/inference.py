"""Offline adapter around the pinned upstream CLaMP 3 feature extractor."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np

MODEL_REVISION = "355625cc1c6f73726bbcd0eb9276ac7152d56426"
SOURCE_REVISION = "9016d2b0c8d12d1aa79c2e0ab201e6822bdc83a8"
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


def _snapshot(repository: str, revision: str) -> Path:
    return _root() / "hf" / f"models--{repository.replace('/', '--')}" / "snapshots" / revision


def readiness() -> tuple[bool, list[str]]:
    problems: list[str] = []
    inventory = _root() / "asset_inventory.json"
    if not inventory.is_file():
        problems.append("asset inventory is absent")
    weight = _snapshot("sander-wood/clamp3", MODEL_REVISION) / WEIGHT_NAME
    if not weight.is_file():
        problems.append("CLaMP 3 checkpoint is absent")
    if not _snapshot("m-a-p/MERT-v1-95M", "12af15fef9d0ac838c3f475bfbbf26d2060dd4f5").is_dir():
        problems.append("MERT dependency snapshot is absent")
    if not _snapshot(
        "FacebookAI/xlm-roberta-base", "e73636d4f797dec63c3081bb6ed5c7b0bb3f2089"
    ).is_dir():
        problems.append("XLM-R dependency snapshot is absent")
    if not (_source() / "clamp3_embd.py").is_file():
        problems.append("pinned upstream source is absent")
    return not problems, problems


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


def _install_weight_link() -> None:
    source_weight = _snapshot("sander-wood/clamp3", MODEL_REVISION) / WEIGHT_NAME
    target = _source() / "code" / WEIGHT_NAME
    # The image creates this link while it is still built as root.  Runtime
    # must never modify the pinned upstream source tree; the link still binds
    # the immutable, offline model volume to the upstream extractor.
    if not target.is_symlink() or target.resolve() != source_weight.resolve():
        raise AssetsUnavailable("pinned checkpoint link is absent or invalid")


def embed(item: dict) -> np.ndarray:
    ready, problems = readiness()
    if not ready:
        raise AssetsUnavailable("; ".join(problems))
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
        _install_weight_link()
        scratch_path = Path(scratch)
        input_dir, output_dir = scratch_path / "input", scratch_path / "output"
        input_dir.mkdir()
        modality = item.get("modality")
        if modality not in EXTENSIONS:
            raise ValueError(f"unsupported modality: {modality!r}")
        item_path = input_dir / f"item{EXTENSIONS[modality]}"
        _materialize(item, item_path)
        completed = subprocess.run(
            ["python", "clamp3_embd.py", str(input_dir), str(output_dir), "--get_global"],
            cwd=_source(),
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
    first, second = embed(left), embed(right)
    denominator = float(np.linalg.norm(first) * np.linalg.norm(second))
    if denominator == 0:
        raise RuntimeError("upstream returned a zero-norm embedding")
    score = float(np.dot(first, second) / denominator)
    return {
        "similarity": max(-1.0, min(1.0, score)),
        "model": "CLaMP3",
        "provenance": {
            "sourceRevision": SOURCE_REVISION,
            "modelRevision": MODEL_REVISION,
            "leftSha256": _input_digest(left),
            "rightSha256": _input_digest(right),
        },
    }


def _input_digest(item: dict) -> str:
    canonical = json.dumps(item, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()