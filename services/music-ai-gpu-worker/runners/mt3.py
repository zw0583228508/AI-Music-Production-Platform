"""Pinned MT3 GPU transcription runner.

This runner uses the pinned mt3-infer adapter and a separately attested
converted MT3 checkpoint. The adapter is intentionally a required dependency:
it is not replaced with heuristics, Basic Pitch, or CPU inference.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Protocol

from .common import (
    RunnerError, attest_checkpoint, durable_job_dir, emit, finite_number,
    materialize_source, request_value, require_cuda, require_distribution_version,
    runtime_provenance, validate_audio,
)

BACKEND_DISTRIBUTION = "mt3-infer"
BACKEND_VERSION = "0.1.3"
BACKEND_SOURCE_REVISION = "openmirlab/mt3-infer@280a95817a67da0ae46987ddbb18c946963afffe"
BACKEND_PATCH = "Dockerfile.mt3:checkpoint-import-relocation"
UPSTREAM_SOURCE_REVISION = "magenta/mt3@63e58268d9279cf91d9902bbdc166ab6d3c20c97"
CHECKPOINT_SOURCE_REVISION = "gs://mt3/checkpoints/mt3@inventory-sha256:117ba05b5fac97d2fa7c9d0452691607ec49903efcf5393c374541eca828c60b;kunato/mt3-pytorch@03a06ef7f288f64e7cd25f17c3f37bcf9fe111bc#pretrained"
CONVERSION_SOURCE_REVISION = "kunato/mt3-pytorch@03a06ef7f288f64e7cd25f17c3f37bcf9fe111bc#tools/convert_weight.py"
CHECKPOINT_LICENSE = "Apache-2.0"
PROVIDER = "MT3"
MODEL_VERSION = "mt3-pytorch-multitrack"


class Mt3Backend(Protocol):
    name: str
    def transcribe(self, audio: Path, checkpoint: Path) -> list[dict[str, Any]]: ...


class OfficialMt3Backend:
    name = BACKEND_DISTRIBUTION
    def transcribe(self, audio: Path, checkpoint: Path) -> list[dict[str, Any]]:
        require_distribution_version(BACKEND_DISTRIBUTION, BACKEND_VERSION)
        try:
            from mt3_infer import get_model_info, transcribe
            from mt3_infer.utils.audio import load_audio
        except ImportError as exc:  # pragma: no cover - deployment dependency
            raise RunnerError("mt3-infer==0.1.3 is not installed") from exc
        model_name = os.getenv("MT3_INFER_MODEL", "mt3_pytorch")
        model_info = get_model_info(model_name)
        expected_rate = model_info.get("metadata", {}).get("sample_rate")
        if (isinstance(expected_rate, bool) or not isinstance(expected_rate, int)
                or expected_rate <= 0):
            raise RunnerError(f"mt3-infer model {model_name} has no valid sample rate")
        # Use the pinned toolkit's official loader so model registry metadata,
        # mono conversion, and automatic resampling remain one reviewed path.
        samples, sample_rate = load_audio(str(audio), sr=expected_rate)
        if sample_rate != expected_rate:
            raise RunnerError(
                f"mt3-infer audio loader returned {sample_rate}Hz; expected {expected_rate}Hz"
            )
        midi = transcribe(
            samples, sr=sample_rate, model=model_name,
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


def retained_note_output(notes: list[dict[str, Any]]) -> dict[str, Any]:
    """Retain bounded canonical note events so smoke termination is auditable."""
    if not notes or len(notes) > 4096:
        raise RunnerError("MT3 smoke note evidence must contain 1 to 4096 notes")
    encoded = json.dumps(
        notes, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode()
    return {
        "notes": len(notes),
        "terminatedNotes": len(notes),
        "allNotesTerminated": True,
        "noteEvents": notes,
        "noteEventsSha256": hashlib.sha256(encoded).hexdigest(),
    }


def run_job(request: dict[str, Any], checkpoint: Path, backend: Mt3Backend | None = None,
            *, smoke: bool = False) -> dict[str, Any]:
    require_cuda()
    digest = attest_checkpoint(checkpoint, PROVIDER)
    work = durable_job_dir(request, PROVIDER)
    audio = materialize_source(
        request, work / "source.wav", checkpoint, PROVIDER, smoke,
    )
    duration_value = request_value(request, "durationSeconds")
    if duration_value is not None:
        duration = finite_number(duration_value, "durationSeconds", 0.001)
    elif smoke:
        duration = float(validate_audio(audio)["durationSeconds"])
    else:
        duration = finite_number(duration_value, "durationSeconds", 0.001)
    active = backend or OfficialMt3Backend()
    notes = normalize_notes(active.transcribe(audio, checkpoint), duration + 1)
    overall = min((note["confidence"] for note in notes), default=0.0)
    return {"version": MODEL_VERSION, "modelVersion": MODEL_VERSION, "notes": notes, "confidence": overall,
            "provenance": {"provider": PROVIDER, "modelVersion": MODEL_VERSION,
                           "checkpointSha256": digest, "backend": active.name,
                           "backendVersion": BACKEND_VERSION,
                            "revision": CHECKPOINT_SOURCE_REVISION,
                           "sourceRevision": BACKEND_SOURCE_REVISION,
                            "sourcePatch": BACKEND_PATCH,
                           "upstreamSourceRevision": UPSTREAM_SOURCE_REVISION,
                            "conversionSourceRevision": CONVERSION_SOURCE_REVISION,
                            "checkpointLicense": CHECKPOINT_LICENSE,
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
               "revision": CHECKPOINT_SOURCE_REVISION,
              "sourceRevision": BACKEND_SOURCE_REVISION,
               "sourcePatch": BACKEND_PATCH,
              "upstreamSourceRevision": UPSTREAM_SOURCE_REVISION,
               "conversionSourceRevision": CONVERSION_SOURCE_REVISION,
               "checkpointLicense": CHECKPOINT_LICENSE,
              "device": "cuda", "provenance": proof_provenance,
              "output": retained_note_output(result["notes"])})
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