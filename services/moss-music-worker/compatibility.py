"""Retain exact dependency and native-media evidence before model provisioning."""
from __future__ import annotations

import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import subprocess

from preflight import run_preflight

ROOT = Path(__file__).parent
SPEC = json.loads((ROOT / "model_manifest.json").read_text())
SMOKE_ROOT = Path(os.getenv("MOSS_MUSIC_SMOKE_ROOT", "/var/lib/moss-music/smoke"))


def _revision(path: str) -> str:
    return subprocess.run(
        ["git", "-C", path, "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _torchcodec_wheel_evidence() -> dict[str, str]:
    reviewed = SPEC["runtime"]["torchcodec_wheel"]
    direct_url_text = metadata.distribution("torchcodec").read_text("direct_url.json")
    if not direct_url_text:
        raise RuntimeError("installed TorchCodec lacks direct-wheel provenance")
    direct_url = json.loads(direct_url_text)
    archive_info = direct_url.get("archive_info", {})
    archive_sha256 = archive_info.get("hashes", {}).get("sha256")
    if not archive_sha256:
        archive_hash = archive_info.get("hash", "")
        archive_sha256 = (
            archive_hash.removeprefix("sha256=")
            if archive_hash.startswith("sha256=")
            else None
        )
    if (
        archive_sha256 != reviewed["sha256"]
        or not direct_url.get("url", "").endswith(reviewed["filename"])
    ):
        raise RuntimeError("installed TorchCodec wheel differs from the reviewed CPU artifact")
    return {
        "variant": reviewed["variant"],
        "filename": reviewed["filename"],
        "sha256": archive_sha256,
    }


def _assert_runtime(evidence: dict[str, object]) -> None:
    runtime = SPEC["runtime"]
    packages = evidence["mediaPreflight"]["packages"]
    expected = {
        "torch": runtime["torch"],
        "torchaudio": runtime["torchaudio"],
        "torchcodec": runtime["torchcodec"],
        "transformers": runtime["transformers"],
        "accelerate": runtime["accelerate"],
        "huggingfaceHub": runtime["huggingfaceHub"],
        "gradio": runtime["gradio"],
        "pydantic": runtime["pydantic"],
        "fastapi": runtime["fastapi"],
    }
    if packages != expected:
        raise RuntimeError("installed MOSS package identity differs from the reviewed matrix")
    if not evidence["mediaPreflight"]["ffmpeg"].startswith(f"ffmpeg version {runtime['ffmpeg']}"):
        raise RuntimeError("installed FFmpeg identity differs from the reviewed matrix")
    if evidence["source"]["revision"] != SPEC["source"]["revision"]:
        raise RuntimeError("MOSS-Music source revision differs from the reviewed matrix")
    if evidence["sglang"]["revision"] != SPEC["sglang"]["revision"]:
        raise RuntimeError("MOSS SGLang revision differs from the reviewed matrix")
    if evidence["torchcodecWheel"] != runtime["torchcodec_wheel"]:
        raise RuntimeError("installed TorchCodec provenance differs from the reviewed matrix")


def build_evidence() -> dict[str, object]:
    pip_check = subprocess.run(
        ["/opt/moss-venv/bin/python", "-m", "pip", "check"],
        check=True,
        capture_output=True,
        text=True,
    )
    evidence = {
        "schemaVersion": 2,
        "providerFamily": SPEC["provider_family"],
        "imageEvidence": os.getenv("MOSS_MUSIC_IMAGE_EVIDENCE"),
        "source": {
            **SPEC["source"],
            "revision": _revision("/opt/moss-music"),
            "install": "base-package-without-torch-runtime-extra",
        },
        "sglang": {
            **SPEC["sglang"],
            "revision": _revision("/opt/moss-sglang"),
            "install": "python[all]",
        },
        "runtime": SPEC["runtime"],
        "torchcodecWheel": _torchcodec_wheel_evidence(),
        "pipCheck": {
            "passed": True,
            "output": pip_check.stdout.strip(),
        },
        "mediaPreflight": run_preflight(),
        "installedDistributions": {
            "moss-music": metadata.version("moss-music"),
            "sglang": metadata.version("sglang"),
        },
    }
    _assert_runtime(evidence)
    return evidence


def write_evidence() -> Path:
    evidence = build_evidence()
    SMOKE_ROOT.mkdir(parents=True, exist_ok=True)
    destination = SMOKE_ROOT / SPEC["compatibility_evidence"]
    serialized = json.dumps(evidence, indent=2, sort_keys=True)
    temporary = destination.with_name(destination.name + f".{os.getpid()}.tmp")
    temporary.write_text(serialized)
    os.replace(temporary, destination)
    print(json.dumps({
        "compatibilityEvidence": str(destination),
        "sha256": hashlib.sha256(serialized.encode()).hexdigest(),
        "evidence": evidence,
    }, sort_keys=True))
    return destination


if __name__ == "__main__":
    write_evidence()