"""Explicit provisioning-only downloader for Wave 2 mt3-infer backends.

This module is deliberately not imported by the HTTP worker.  It is intended
for a one-shot, authenticated provisioning image after the exact upstream
model revisions have been reviewed.  The resulting evidence is informational;
the serving health gate still requires a SHA-256 pinned in model_manifest.json
and a signed deployment promotion record.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import math
import struct
import uuid
import urllib.request
import wave
from pathlib import Path


ADAPTER_VERSION = "0.1.3"
ADAPTER_REVISION = "openmirlab/mt3-infer@280a95817a67da0ae46987ddbb18c946963afffe"
# Exact registry IDs and paths from mt3-infer 0.1.3's
# mt3_infer/config/checkpoints.yaml at adapter revision 280a958…. The CLI's
# MT3_CHECKPOINT_DIR handling strips the leading ".mt3_checkpoints/" segment.
PROVIDERS = {
    "MR_MT3": {
        "model_version": "mr-mt3",
        "toolkit_id": "mr_mt3",
        "checkpoint": "mr_mt3/mt3.pth",
        "license": "MIT",
    },
    "YOUR_MT3": {
        "model_version": "your-mt3",
        "toolkit_id": "yourmt3",
        "checkpoint": (
            "yourmt3/mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops/"
            "last.ckpt"
        ),
        "license": "Apache-2.0",
        "checkpoint_url": (
            "https://huggingface.co/mimbres/YourMT3/resolve/"
            "e45ebd70398682d54b7bb1901a5216e18f3b1824/logs/2024/"
            "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops/"
            "checkpoints/last.ckpt"
        ),
        "checkpoint_bytes": 561_544_628,
        "checkpoint_sha256": "ae38e415c79efd5592dcb9b658cdb99ddb11d4c4e1eaa364cab04a052473fc25",
        "smoke_input_sha256": "d32d6565800021f93f7904cf576c696c0f5d0f45bb8dc7b1badd0dc53cab69b7",
    },
}
MAX_INVENTORY_FILES = 512
MAX_DIAGNOSTIC_CHARS = 2048
RUNNER_DIAGNOSTIC_CHARS = 8192
MODEL_LAYOUT_ROOTS = {"mr_mt3", "mt3_pytorch", "yourmt3"}


def tree_sha256(path: Path) -> str:
    is_file = path.is_file()
    files = [path] if is_file else sorted(item for item in path.rglob("*") if item.is_file())
    if not files:
        raise RuntimeError("mt3-infer bootstrap produced no checkpoint files")
    digest = hashlib.sha256()
    for item in files:
        if not is_file:
            digest.update(item.relative_to(path).as_posix().encode())
        with item.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    return digest.hexdigest()


def write_structured_smoke_fixture(checkpoint_root: Path) -> Path:
    """Atomically persist the reviewed 32-second non-silent smoke input."""
    fixture = checkpoint_root / "_smoke" / "structured-click-track-32s.wav"
    fixture.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary = fixture.with_name(f".{fixture.name}.{uuid.uuid4().hex}")
    sample_rate, seconds = 44_100, 32
    with wave.open(str(temporary), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        frames = bytearray()
        for index in range(sample_rate * seconds):
            time = index / sample_rate
            beat = time % 0.5
            chord = (130.81, 164.81, 196.0) if int(time / 8) % 2 == 0 else (110.0, 130.81, 164.81)
            sample = (
                0.12 * sum(math.sin(2 * math.pi * frequency * time) for frequency in chord)
                + 0.40 * math.exp(-20 * beat) * math.sin(2 * math.pi * 72 * beat)
            )
            frames.extend(struct.pack("<h", int(max(-0.95, min(0.95, sample)) * 32767)))
            if len(frames) >= 8192:
                output.writeframesraw(frames)
                frames.clear()
        if frames:
            output.writeframesraw(frames)
    os.replace(temporary, fixture)
    with wave.open(str(fixture), "rb") as verified:
        if (verified.getframerate() != sample_rate or verified.getnframes() != sample_rate * seconds
                or verified.getnchannels() != 1 or verified.getsampwidth() != 2):
            raise RuntimeError("structured smoke fixture failed exact 32-second validation")
    return fixture


def write_your_mt3_smoke_fixture(checkpoint_root: Path) -> Path:
    """Create an original note-on/off phrase in YourMT3's native audio domain."""
    fixture = checkpoint_root / "_smoke" / "structured-melodic-phrase-12s.wav"
    fixture.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary = fixture.with_name(f".{fixture.name}.{uuid.uuid4().hex}")
    sample_rate, seconds = 16_000, 12
    chords = ((48, 55, 60), (53, 57, 60), (55, 59, 62), (48, 55, 64))
    melody = (
        72, 74, 76, 79, 76, 74, 72, 67, 69, 72, 76, 74,
        71, 74, 79, 76, 72, 71, 69, 67, 64, 67, 72, 76,
    )
    events: list[tuple[float, float, int, float]] = []
    for bar in range(6):
        events.extend((bar * 2.0, 1.75, note, 0.32) for note in chords[bar % len(chords)])
    events.extend((index * 0.5, 0.42, note, 0.42) for index, note in enumerate(melody))

    def frequency(note: int) -> float:
        return 440.0 * 2 ** ((note - 69) / 12)

    samples: list[float] = []
    for index in range(sample_rate * seconds):
        time = index / sample_rate
        sample = 0.0
        for onset, duration, note, amplitude in events:
            age = time - onset
            if age < 0 or age > duration:
                continue
            attack = min(1.0, age / 0.012)
            release = min(1.0, (duration - age) / 0.06)
            envelope = attack * release * math.exp(-2.1 * age)
            fundamental = frequency(note)
            tone = sum(
                math.sin(2 * math.pi * fundamental * harmonic * age + 0.09 * harmonic * harmonic)
                / harmonic ** 1.35
                for harmonic in range(1, 9)
            )
            sample += amplitude * envelope * tone
        samples.append(sample)
    peak = max(abs(sample) for sample in samples)
    scale = 0.62 / peak
    with wave.open(str(temporary), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(b"".join(
            struct.pack("<h", int(max(-0.98, min(0.98, sample * scale)) * 32767))
            for sample in samples
        ))
    os.replace(temporary, fixture)
    with wave.open(str(fixture), "rb") as verified:
        if (
            verified.getframerate() != sample_rate
            or verified.getnframes() != sample_rate * seconds
            or verified.getnchannels() != 1
            or verified.getsampwidth() != 2
        ):
            raise RuntimeError("YourMT3 smoke fixture failed exact validation")
    return fixture


def write_smoke_fixture(provider: str, checkpoint_root: Path) -> Path:
    if provider == "YOUR_MT3":
        return write_your_mt3_smoke_fixture(checkpoint_root)
    return write_structured_smoke_fixture(checkpoint_root)


def run_smoke(provider: str, checkpoint_root: Path, checkpoint: Path, digest: str) -> dict[str, object]:
    model_version = str(PROVIDERS[provider]["model_version"])
    fixture = write_smoke_fixture(provider, checkpoint_root)
    fixture_sha256 = tree_sha256(fixture)
    fixture_pin = PROVIDERS[provider].get("smoke_input_sha256")
    pinned_environment = {}
    if fixture_pin is not None:
        if (
            not isinstance(fixture_pin, str)
            or not re.fullmatch(r"[a-f0-9]{64}", fixture_pin)
        ):
            raise RuntimeError(f"{provider} smoke fixture pin is not an exact SHA-256")
        if not hmac.compare_digest(fixture_sha256, fixture_pin):
            raise RuntimeError(f"{provider} generated smoke fixture SHA-256 mismatch")
        pinned_environment[
            f"MUSIC_PROVIDER_{provider}_SMOKE_INPUT_SHA256"
        ] = fixture_pin
    environment = {
        **os.environ,
        "MUSIC_GPU_CHECKPOINT_ROOT": str(checkpoint_root),
        "MT3_CHECKPOINT_DIR": str(checkpoint_root),
        "MUSIC_GPU_SMOKE_INPUT_PATH": str(fixture),
        "MUSIC_GPU_JOB_OUTPUT_ROOT": str(checkpoint_root / "_provision-jobs"),
        f"MUSIC_PROVIDER_{provider}_CHECKPOINT_SHA256": digest,
        **pinned_environment,
    }
    process = subprocess.run(
        ["python", "-m", f"runners.{provider.lower()}", "--smoke", "--provider",
         provider, "--model-version", model_version, "--checkpoint", str(checkpoint)],
        cwd=Path(__file__).resolve().parent,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10 * 60,
        check=False,
    )
    if process.returncode:
        diagnostic = bounded_diagnostic(
            process.stderr, limit=RUNNER_DIAGNOSTIC_CHARS
        )
        raise RuntimeError(
            f"{provider} CUDA smoke failed (runner exit {process.returncode}): {diagnostic}"
        )
    try:
        proof = json.loads(process.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        raise RuntimeError(f"{provider} CUDA smoke emitted invalid evidence") from exc
    if (proof.get("smokeTested") is not True or proof.get("provider") != provider
            or proof.get("checkpointSha256", "").lower() != digest
            or not isinstance(proof.get("output"), dict)
            or not isinstance(proof["output"].get("notes"), int)
            or proof["output"]["notes"] < 1):
        raise RuntimeError(f"{provider} CUDA smoke evidence failed validation")
    return {
        "fixture": fixture.relative_to(checkpoint_root).as_posix(),
        "fixtureSha256": fixture_sha256,
        "notes": proof["output"]["notes"],
        "device": "cuda",
    }


def bounded_diagnostic(
    value: str, *, limit: int = MAX_DIAGNOSTIC_CHARS
) -> str:
    """Keep useful subprocess diagnostics without leaking credentials/control bytes."""
    printable = "".join(character if character.isprintable() or character in "\n\t" else "?"
                        for character in value)
    redacted = re.sub(
        r"(?i)\b(token|authorization|password|secret)\s*[:=]\s*\S+",
        r"\1=[REDACTED]",
        printable,
    )
    compact = " ".join(redacted.split())
    return compact[:limit] or "(no stderr)"


def observed_inventory(checkpoint_root: Path) -> list[dict[str, object]]:
    """Record all toolkit-produced assets, excluding bootstrap evidence/cache."""
    ignored_roots = {"_attestations", "_smoke", "_provision-jobs", ".hf"}
    files = sorted(
        item for item in checkpoint_root.rglob("*")
        if item.is_file() and not item.is_symlink()
        and not any(part in ignored_roots for part in item.relative_to(checkpoint_root).parts)
    )
    if not files or len(files) > MAX_INVENTORY_FILES:
        raise RuntimeError("mt3-infer observed layout has an invalid inventory size")
    return [{
        "path": item.relative_to(checkpoint_root).as_posix(),
        "bytes": item.stat().st_size,
        "sha256": tree_sha256(item),
    } for item in files]


def selected_checkpoint(provider: str, checkpoint_root: Path, inventory: list[dict[str, object]]) -> Path:
    expected = str(PROVIDERS[provider]["checkpoint"])
    target = checkpoint_root / expected
    observed = [str(item["path"]) for item in inventory]
    expected_root = expected.split("/", 1)[0]
    other_provider_files = [
        path for path in observed
        if path.split("/", 1)[0] in MODEL_LAYOUT_ROOTS
        and path.split("/", 1)[0] != expected_root
    ]
    if (not target.is_file() or target.is_symlink() or target.stat().st_size <= 0
            or expected not in observed or other_provider_files):
        diagnostic = json.dumps({
            "expected": expected,
            "observed": observed[:32],
            "unexpectedOtherProviderFiles": other_provider_files[:32],
        }, separators=(",", ":"))
        raise RuntimeError(
            f"{provider} mt3-infer observed-layout mismatch: "
            f"{diagnostic[:MAX_DIAGNOSTIC_CHARS]}"
        )
    return target


def provision_checkpoint(provider: str, checkpoint_root: Path) -> None:
    """Materialize one reviewed checkpoint, reusing exact bytes when present."""
    metadata = PROVIDERS[provider]
    immutable_url = metadata.get("checkpoint_url")
    if not isinstance(immutable_url, str):
        environment = {
            **os.environ,
            "MT3_CHECKPOINT_DIR": str(checkpoint_root),
            "HF_HOME": str(checkpoint_root / ".hf"),
        }
        completed = subprocess.run(
            ["mt3-infer", "download", str(metadata["toolkit_id"])],
            cwd=checkpoint_root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60 * 60,
            check=False,
        )
        if completed.returncode:
            raise RuntimeError(
                "mt3-infer provisioning download failed: "
                f"{bounded_diagnostic(completed.stderr)}"
            )
        return

    target = checkpoint_root / str(metadata["checkpoint"])
    expected_bytes = int(metadata["checkpoint_bytes"])
    expected_sha256 = str(metadata["checkpoint_sha256"])
    if (
        target.is_file()
        and not target.is_symlink()
        and target.stat().st_size == expected_bytes
        and tree_sha256(target) == expected_sha256
    ):
        return
    target.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}")
    try:
        request = urllib.request.Request(
            immutable_url, headers={"User-Agent": f"music-ai-bootstrap/{ADAPTER_VERSION}"},
        )
        with urllib.request.urlopen(request, timeout=60 * 60) as response, temporary.open("wb") as output:
            copied = 0
            for block in iter(lambda: response.read(1024 * 1024), b""):
                copied += len(block)
                if copied > expected_bytes:
                    raise RuntimeError("immutable checkpoint download exceeded reviewed size")
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        if copied != expected_bytes or tree_sha256(temporary) != expected_sha256:
            raise RuntimeError("immutable checkpoint download failed identity validation")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def bootstrap(provider: str, checkpoint_root: Path) -> dict[str, object]:
    """Download only during explicit bootstrap and record observed evidence."""
    metadata = PROVIDERS[provider]
    model_version = str(metadata["model_version"])
    license_name = str(metadata["license"])
    checkpoint_root.mkdir(mode=0o750, parents=True, exist_ok=True)
    provision_checkpoint(provider, checkpoint_root)
    inventory = observed_inventory(checkpoint_root)
    checkpoint = selected_checkpoint(provider, checkpoint_root, inventory)
    # The serving pin covers exactly the requested provider file.
    digest = tree_sha256(checkpoint)
    smoke = run_smoke(provider, checkpoint_root, checkpoint, digest)
    evidence = {
        "provider": provider,
        "modelVersion": model_version,
        "license": license_name,
        "adapterVersion": ADAPTER_VERSION,
        "adapterRevision": ADAPTER_REVISION,
        "toolkitModelId": metadata["toolkit_id"],
        "checkpointPath": checkpoint.relative_to(checkpoint_root).as_posix(),
        "checkpointSha256": digest,
        "inventory": inventory,
        "smoke": smoke,
    }
    destination = checkpoint_root / "_attestations" / f"{model_version}.json"
    destination.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    destination.write_text(json.dumps(evidence, sort_keys=True) + "\n", encoding="utf-8")
    # This is intentionally bounded and safe for CI logs/promotion handoff.
    return evidence


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, choices=sorted(PROVIDERS))
    parser.add_argument("--checkpoint-root", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(bootstrap(args.provider, args.checkpoint_root), sort_keys=True))