"""Pinned MT3 GPU transcription runner.

This runner uses the official MT3 inference adapter installed from the pinned
revision in requirements-mt3.txt.  The adapter is intentionally a required
dependency: it is not replaced with heuristics, Basic Pitch, or CPU inference.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Protocol

from .common import (
    RunnerError, attest_checkpoint, durable_job_dir, emit, finite_number,
    materialize_source, request_value, require_cuda, require_distribution_version,
    runtime_provenance,
)

# This revision has not been independently verified in this repository.  It is
# configuration documentation, not an attestation of an installed source tree.
BACKEND_DISTRIBUTION = "mt3-infer"
BACKEND_VERSION = "0.2.0"
BACKEND_SOURCE_REVISION = "openmirlab/mt3-infer@331519f1951d3d198aef01664bb0406512f97c77"
UPSTREAM_SOURCE_REVISION = "magenta/mt3@fa53e12321ac417d3baf01f43e6796a7d0775f55"
PROVIDER = "MT3"
MODEL_VERSION = "mt3-ismir2021"


class Mt3Backend(Protocol):
    name: str
    def transcribe(self, audio: Path, checkpoint: Path) -> list[dict[str, Any]]: ...


class OfficialMt3Backend:
    name = BACKEND_DISTRIBUTION
    def transcribe(self, audio: Path, checkpoint: Path) -> list[dict[str, Any]]:
        require_distribution_version(BACKEND_DISTRIBUTION, BACKEND_VERSION)
        try:
            import soundfile as sf
            from mt3_infer import transcribe
        except ImportError as exc:  # pragma: no cover - deployment dependency
            raise RunnerError("mt3-infer==0.2.0 is not installed") from exc
        samples, sample_rate = sf.read(str(audio), dtype="float32")
        midi = transcribe(
            samples, sr=sample_rate, model=os.getenv("MT3_INFER_MODEL", "mt3_pytorch"),
            checkpoint_path=str(checkpoint), device="cuda", auto_download=False,
        )
        events = _midi_notes(midi)
        return events


def _midi_notes(midi: Any) -> list[dict[str, Any]]:
    """Convert mido's timed MIDI evidence without synthesising note events."""
    try:
        import mido
        messages = mido.merge_tracks(midi.tracks)
    except (ImportError, AttributeError) as exc:
        raise RunnerError("mt3-infer returned an invalid MIDI object") from exc
    tempo, elapsed = 500000, 0.0
    active: dict[tuple[int, int], list[tuple[float, int]]] = {}
    notes: list[dict[str, Any]] = []
    for message in messages:
        elapsed += mido.tick2second(message.time, midi.ticks_per_beat, tempo)
        if message.type == "set_tempo":
            tempo = message.tempo
        if message.type == "note_on" and message.velocity > 0:
            active.setdefault((getattr(message, "channel", 0), message.note), []).append((elapsed, message.velocity))
        elif message.type in {"note_off", "note_on"}:
            key = (getattr(message, "channel", 0), message.note)
            if active.get(key):
                start, velocity = active[key].pop(0)
                # mt3-infer's public output is MIDI and exposes no posterior;
                # normalized MIDI velocity is retained as confidence evidence.
                notes.append({"start": start, "end": elapsed, "pitch": message.note,
                              "velocity": velocity, "confidence": velocity / 127})
    if any(active.values()):
        raise RunnerError("mt3-infer returned unterminated MIDI notes")
    return notes


def normalize_notes(events: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    notes: list[dict[str, Any]] = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise RunnerError(f"MT3 event {index + 1} is not an object")
        start = finite_number(event.get("start", event.get("onset")), f"MT3 event {index + 1} onset", 0, duration)
        end = finite_number(event.get("end", event.get("offset")), f"MT3 event {index + 1} offset", 0, duration)
        pitch = event.get("pitch", event.get("midi"))
        velocity = event.get("velocity", 64)
        confidence = finite_number(event.get("confidence", event.get("score")), f"MT3 event {index + 1} confidence", 0, 1)
        if end <= start or isinstance(pitch, bool) or not isinstance(pitch, int) or not 0 <= pitch <= 127:
            raise RunnerError(f"MT3 event {index + 1} has invalid note bounds")
        if isinstance(velocity, bool) or not isinstance(velocity, int) or not 1 <= velocity <= 127:
            raise RunnerError(f"MT3 event {index + 1} has invalid velocity")
        notes.append({"start": start, "end": end, "pitch": pitch, "velocity": velocity, "confidence": confidence})
    notes.sort(key=lambda note: (note["start"], note["end"], note["pitch"]))
    if any(notes[i]["start"] < notes[i - 1]["start"] for i in range(1, len(notes))):
        raise RunnerError("MT3 notes are not ordered")
    return notes


def run_job(request: dict[str, Any], checkpoint: Path, backend: Mt3Backend | None = None,
            *, smoke: bool = False) -> dict[str, Any]:
    require_cuda()
    digest = attest_checkpoint(checkpoint, PROVIDER)
    duration = finite_number(request_value(request, "durationSeconds"), "durationSeconds", 0.001)
    work = durable_job_dir(request, PROVIDER)
    audio = materialize_source(request, work / "source.wav", checkpoint, smoke)
    active = backend or OfficialMt3Backend()
    notes = normalize_notes(active.transcribe(audio, checkpoint), duration + 1)
    overall = min((note["confidence"] for note in notes), default=0.0)
    return {"version": MODEL_VERSION, "modelVersion": MODEL_VERSION, "notes": notes, "confidence": overall,
            "provenance": {"provider": PROVIDER, "modelVersion": MODEL_VERSION,
                           "checkpointSha256": digest, "backend": active.name,
                           "backendVersion": BACKEND_VERSION,
                            "revision": BACKEND_SOURCE_REVISION,
                           "sourceRevision": BACKEND_SOURCE_REVISION,
                           "upstreamSourceRevision": UPSTREAM_SOURCE_REVISION,
                            "confidenceBasis": "midi-velocity/127", "device": "cuda",
                            **runtime_provenance()}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--smoke", action="store_true")
    mode.add_argument("--job", action="store_true")
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--checkpoint", required=True)
    args = parser.parse_args(argv)
    if args.provider != PROVIDER or args.model_version != MODEL_VERSION:
        raise RunnerError("MT3 provider or model version is not pinned")
    checkpoint = Path(args.checkpoint)
    if args.smoke:
        require_cuda()
        digest = attest_checkpoint(checkpoint, PROVIDER)
        result = run_job({"requestId": f"smoke-mt3-{os.urandom(8).hex()}"},
                         checkpoint, smoke=True)
        if not result["notes"]:
            raise RunnerError("MT3 smoke inference returned no notes")
        proof_provenance = result["provenance"]
        emit({"smokeTested": True, "provider": PROVIDER, "modelVersion": args.model_version,
              "version": args.model_version, "checkpointSha256": digest,
              "backend": OfficialMt3Backend.name, "backendVersion": BACKEND_VERSION,
              "sourceRevision": BACKEND_SOURCE_REVISION,
              "upstreamSourceRevision": UPSTREAM_SOURCE_REVISION,
              "device": "cuda", "provenance": proof_provenance,
              "output": {"notes": len(result["notes"])}})
    else:
        import sys
        payload = json.load(sys.stdin)
        emit(run_job(payload, checkpoint))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RunnerError as exc:
        raise SystemExit(f"MT3 runner failed: {exc}")