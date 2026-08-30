"""Pinned MT3 GPU transcription runner.

This runner uses the official MT3 inference adapter installed from the pinned
revision in requirements-mt3.txt.  The adapter is intentionally a required
dependency: it is not replaced with heuristics, Basic Pitch, or CPU inference.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Protocol

from ._common import RunnerError, attest_checkpoint, fetch_source, finite, provenance, require_gpu, stdin_request

OFFICIAL_SOURCE = "https://github.com/magenta/mt3.git@0c4c67b5a4d12f1b2df73c4ad9de4de4887a4ff8"


class Mt3Backend(Protocol):
    name: str
    def transcribe(self, audio: Path, checkpoint: Path) -> list[dict[str, Any]]: ...


class OfficialMt3Backend:
    name = "magenta-mt3"
    def transcribe(self, audio: Path, checkpoint: Path) -> list[dict[str, Any]]:
        try:
            # This adapter is shipped with our pinned checkout; it loads the
            # official T5X checkpoint locally and always selects CUDA.
            from mt3_gpu_adapter import transcribe_file
        except ImportError as exc:  # pragma: no cover - deployment dependency
            raise RunnerError("pinned official MT3 adapter is not installed") from exc
        events = transcribe_file(str(audio), str(checkpoint), device="cuda")
        if not isinstance(events, list):
            raise RunnerError("official MT3 adapter returned invalid events")
        return events


def normalize_notes(events: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    notes: list[dict[str, Any]] = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise RunnerError(f"MT3 event {index + 1} is not an object")
        start = finite(event.get("start", event.get("onset")), f"MT3 event {index + 1} onset", 0, duration)
        end = finite(event.get("end", event.get("offset")), f"MT3 event {index + 1} offset", 0, duration)
        pitch = event.get("pitch", event.get("midi"))
        velocity = event.get("velocity", 64)
        confidence = finite(event.get("confidence", event.get("score")), f"MT3 event {index + 1} confidence", 0, 1)
        if end <= start or isinstance(pitch, bool) or not isinstance(pitch, int) or not 0 <= pitch <= 127:
            raise RunnerError(f"MT3 event {index + 1} has invalid note bounds")
        if isinstance(velocity, bool) or not isinstance(velocity, int) or not 1 <= velocity <= 127:
            raise RunnerError(f"MT3 event {index + 1} has invalid velocity")
        notes.append({"start": start, "end": end, "pitch": pitch, "velocity": velocity, "confidence": confidence})
    notes.sort(key=lambda note: (note["start"], note["end"], note["pitch"]))
    if any(notes[i]["start"] < notes[i - 1]["start"] for i in range(1, len(notes))):
        raise RunnerError("MT3 notes are not ordered")
    return notes


def run_job(request: dict[str, Any], checkpoint: Path, backend: Mt3Backend | None = None) -> dict[str, Any]:
    require_gpu()
    digest = attest_checkpoint(checkpoint)
    duration = finite(request.get("durationSeconds"), "durationSeconds", 0.001)
    audio, temporary = fetch_source(request)
    try:
        active = backend or OfficialMt3Backend()
        notes = normalize_notes(active.transcribe(audio, checkpoint), duration + 1)
    finally:
        temporary.cleanup()
    overall = min((note["confidence"] for note in notes), default=0.0)
    return {"notes": notes, "confidence": overall, "provenance": provenance(OFFICIAL_SOURCE, digest, active.name)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--smoke", action="store_true")
    mode.add_argument("--job", action="store_true")
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--checkpoint", required=True)
    args = parser.parse_args(argv)
    if args.provider != "MT3" or args.model_version != "mt3-ismir2021":
        raise RunnerError("MT3 provider or model version is not pinned")
    checkpoint = Path(args.checkpoint)
    if args.smoke:
        require_gpu()
        digest = attest_checkpoint(checkpoint)
        smoke = os.getenv("MT3_SMOKE_AUDIO")
        if not smoke or not Path(smoke).is_file():
            raise RunnerError("MT3_SMOKE_AUDIO must reference mounted real audio")
        events = OfficialMt3Backend().transcribe(Path(smoke), checkpoint)
        if not events:
            raise RunnerError("MT3 smoke inference returned no notes")
        print(json.dumps({"smokeTested": True, "provider": "MT3", "modelVersion": args.model_version, "checkpointSha256": digest, "output": {"notes": len(events)}}))
    else:
        print(json.dumps(run_job(stdin_request(), checkpoint), allow_nan=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RunnerError as exc:
        raise SystemExit(f"MT3 runner failed: {exc}")