from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def parser(kind: str) -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--track-model", required=True, type=Path)
    value.add_argument("--sample-rate", required=True, type=int)
    value.add_argument("--duration-seconds", required=True, type=float)
    value.add_argument("--output", required=True, type=Path)
    value.add_argument("--attestation", required=True, type=Path)
    value.add_argument("--asset-identity", required=True)
    value.add_argument("--plugin" if kind == "vst3" else "--library", required=True, type=Path)
    return value


def sha256_tree(path: Path) -> str:
    digest = hashlib.sha256()
    if path.is_file():
        digest.update(path.read_bytes())
        return digest.hexdigest()
    files = sorted(value for value in path.rglob("*") if value.is_file())
    if not files:
        raise ValueError("asset contains no files")
    for value in files:
        digest.update(str(value.relative_to(path)).encode())
        digest.update(b"\0")
        with value.open("rb") as handle:
            while block := handle.read(1024 * 1024):
                digest.update(block)
    return digest.hexdigest()


def load_request(path: Path) -> tuple[dict, dict]:
    request = json.loads(path.read_text())
    track = request["trackModel"]
    return request, track


def midi_events(track: dict) -> list[tuple[bytes, float]]:
    events: list[tuple[bytes, float]] = []
    for note in track["notes"]:
        pitch = max(0, min(127, round(note["pitch"])))
        velocity = max(1, min(127, round(note["velocity"])))
        events.append((bytes((0x90, pitch, velocity)), float(note["start"])))
        events.append((bytes((0x80, pitch, 0)), float(note["start"] + note["duration"])))
    for event in track["cc"]:
        events.append((
            bytes((0xB0, max(0, min(127, round(event["controller"]))),
                   max(0, min(127, round(event["value"]))))),
            float(event["time"]),
        ))
    # Named articulations require an asset-specific mapping. Staged assets must
    # provide MIDI data explicitly; silently inventing keyswitches would be a
    # false native-render readiness claim.
    for event in track["articulations"]:
        if "midiNote" not in event:
            continue
        events.append((
            bytes((0x90, max(0, min(127, round(event["midiNote"]))),
                   max(1, min(127, round(127 * event.get("intensity", 1)))))),
            float(event["time"]),
        ))
    return sorted(events, key=lambda value: value[1])


def write_attestation(
    kind: str,
    args: argparse.Namespace,
    track: dict,
    asset: Path,
    renderer: Path,
) -> None:
    value = {
        "provider": kind,
        "assetIdentity": args.asset_identity,
        "assetSha256": sha256_tree(asset),
        "rendererSha256": sha256_tree(renderer),
        "trackModelSha256": sha256_tree(args.track_model),
        "eventCounts": {
            "notes": len(track["notes"]),
            "cc": len(track["cc"]),
            "articulations": len(track["articulations"]),
            "automation": len(track["automation"]),
        },
        "outputSha256": sha256_tree(args.output),
    }
    args.attestation.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")))