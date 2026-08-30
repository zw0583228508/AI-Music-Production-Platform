"""Pinned All-In-One Music Structure Analysis GPU runner.

The output is the strict ALL_IN_ONE contract consumed by analysisProviders.ts.
No estimated beat grid is manufactured when the installed model does not
expose the corresponding evidence.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Protocol

from .common import (
    RunnerError, attest_checkpoint, download_source, durable_job_dir, emit,
    finite_number, request_value, require_cuda, require_distribution_version, runtime_provenance, validate_audio,
)

# This source revision is deliberately marked unverified until deployment
# records an audited immutable checkout and checkpoint provenance.
BACKEND_DISTRIBUTION = "all-in-one-infer"
BACKEND_VERSION = "3.1.0"
BACKEND_SOURCE_REVISION = "openmirlab/all-in-one-infer@3c93b4ae389328544dd5955af7497030cb1bca3a"
UPSTREAM_SOURCE_REVISION = "mir-aidj/all-in-one@18e78903c0365147a2c5d4e5e57ebf88cb7d800e"
PROVIDER = "ALL_IN_ONE"
MODEL_VERSION = "all-in-one-infer-3.1.0"


class AllInOneBackend(Protocol):
    name: str
    def analyze(self, audio: Path, checkpoint: Path) -> dict[str, Any]: ...


class OfficialAllInOneBackend:
    name = BACKEND_DISTRIBUTION

    def analyze(self, audio: Path, checkpoint: Path) -> dict[str, Any]:
        require_distribution_version(BACKEND_DISTRIBUTION, BACKEND_VERSION)
        try:
            from allin1_infer import AllInOneSession
        except ImportError as exc:  # pragma: no cover - deployment dependency
            raise RunnerError("all-in-one-infer==3.1.0 is not installed") from exc
        model = os.getenv("ALL_IN_ONE_MODEL", "harmonix-fold0")
        if not checkpoint.is_file():
            raise RunnerError("All-In-One generic checkpoint override requires a checkpoint file")
        digest = attest_checkpoint(checkpoint, PROVIDER)
        try:
            with AllInOneSession(
                model=model, device="cuda", cache_dir=checkpoint.parent,
                checkpoint_overrides={
                    "checkpoint_url": checkpoint.resolve().as_uri(),
                    "checkpoint_sha256": digest,
                },
            ) as session:
                result = session.infer(str(audio))
        except Exception as exc:
            raise RunnerError(f"All-In-One inference failed: {type(exc).__name__}") from exc
        if isinstance(result, list):
            if len(result) != 1:
                raise RunnerError("All-In-One returned an unexpected result count")
            result = result[0]
        return _official_evidence(result, audio)


def _official_evidence(result: Any, audio: Path) -> dict[str, Any]:
    """Map the documented AnalysisResult fields to strict structural evidence."""
    try:
        beats = [float(value) for value in result.beats]
        positions = [int(value) for value in result.beat_positions]
        downbeats = [float(value) for value in result.downbeats]
        bpm = float(result.bpm)
        segments = list(result.segments)
    except (AttributeError, TypeError, ValueError) as exc:
        raise RunnerError("All-In-One returned an invalid AnalysisResult") from exc
    if len(beats) != len(positions) or not positions or positions[0] != 1:
        raise RunnerError("All-In-One beat positions are incomplete")
    meter_count = max(positions)
    canonical_beats, bar = [], 0
    for time, position in zip(beats, positions):
        if position == 1:
            bar += 1
        canonical_beats.append({"time": time, "beat": position, "bar": bar, "confidence": 1.0})
    duration = validate_audio(audio)["durationSeconds"]
    bars = []
    for number in range(1, bar + 1):
        group = [item for item in canonical_beats if item["bar"] == number]
        next_start = next((item["time"] for item in canonical_beats if item["bar"] == number + 1), duration)
        bars.append({"bar": number, "start": group[0]["time"], "end": next_start,
                     "beats": len(group), "confidence": 1.0})
    canonical_sections = []
    for segment in segments:
        start_time, end_time = float(segment.start), float(segment.end)
        covered = [item["bar"] for item in canonical_beats if start_time <= item["time"] < end_time]
        if covered:
            canonical_sections.append({"name": str(segment.label), "startBar": min(covered),
                                       "endBar": max(covered), "energy": 1.0})
    return {"confidence": 1.0, "tempo": {"bpm": bpm, "confidence": 1.0},
            "meter": {"meter": f"{meter_count}/4", "confidence": 1.0},
            "beats": canonical_beats, "downbeats": downbeats, "bars": bars,
            "sections": canonical_sections}


def _confidence(value: Any, label: str) -> float:
    return finite_number(value, label, 0, 1)


def normalize_structure(raw: dict[str, Any], duration: float) -> dict[str, Any]:
    """Validate and map official model evidence to the API's canonical schema."""
    if not isinstance(raw, dict):
        raise RunnerError("All-In-One backend output must be an object")
    overall = _confidence(raw.get("confidence"), "ALL_IN_ONE confidence")
    tempo = raw.get("tempo")
    meter = raw.get("meter")
    if not isinstance(tempo, dict) or not isinstance(meter, dict):
        raise RunnerError("All-In-One must provide tempo and meter evidence")
    bpm = finite_number(tempo.get("bpm"), "tempo bpm", 20, 400)
    meter_text = meter.get("meter")
    if not isinstance(meter_text, str) or not __import__("re").fullmatch(r"[1-9]\d*/[1-9]\d*", meter_text):
        raise RunnerError("All-In-One meter is invalid")
    tempo_map = raw.get("tempoMap", [{"time": 0, "bpm": bpm, "confidence": _confidence(tempo.get("confidence"), "tempo confidence")}])
    meter_map = raw.get("meterMap", [{"bar": 1, "meter": meter_text, "confidence": _confidence(meter.get("confidence"), "meter confidence")}])
    if not isinstance(tempo_map, list) or not isinstance(meter_map, list) or not tempo_map or not meter_map:
        raise RunnerError("All-In-One tempo and meter maps are required")
    normalized_tempo = []
    for i, item in enumerate(tempo_map):
        if not isinstance(item, dict):
            raise RunnerError(f"tempo map event {i + 1} is invalid")
        normalized_tempo.append({"time": finite_number(item.get("time"), "tempo time", 0, duration),
                                 "bpm": finite_number(item.get("bpm"), "tempo bpm", 20, 400),
                                 "confidence": _confidence(item.get("confidence"), "tempo confidence")})
    if normalized_tempo[0]["time"] != 0 or any(normalized_tempo[i]["time"] <= normalized_tempo[i-1]["time"] for i in range(1, len(normalized_tempo))):
        raise RunnerError("tempo map must begin at zero and be strictly ordered")
    normalized_meter = []
    for i, item in enumerate(meter_map):
        if not isinstance(item, dict) or not isinstance(item.get("bar"), int) or item["bar"] < 1:
            raise RunnerError(f"meter map event {i + 1} is invalid")
        value = item.get("meter")
        if not isinstance(value, str) or not __import__("re").fullmatch(r"[1-9]\d*/[1-9]\d*", value):
            raise RunnerError(f"meter map event {i + 1} is invalid")
        normalized_meter.append({"bar": item["bar"], "meter": value, "confidence": _confidence(item.get("confidence"), "meter confidence")})
    if normalized_meter[0]["bar"] != 1 or any(normalized_meter[i]["bar"] <= normalized_meter[i-1]["bar"] for i in range(1, len(normalized_meter))):
        raise RunnerError("meter map must begin at bar one and be strictly ordered")
    beats = raw.get("beats")
    downbeats = raw.get("downbeats")
    if not isinstance(beats, list) or not beats or not isinstance(downbeats, list) or not downbeats:
        raise RunnerError("All-In-One must provide beat and downbeat evidence")
    normalized_beats = []
    for i, item in enumerate(beats):
        if not isinstance(item, dict):
            raise RunnerError(f"beat {i + 1} is invalid")
        time = finite_number(item.get("time"), "beat time", 0, duration + 1)
        beat, bar = item.get("beat"), item.get("bar")
        if not isinstance(beat, int) or not isinstance(bar, int) or beat < 1 or bar < 1:
            raise RunnerError(f"beat {i + 1} lacks canonical bar/beat ordinals")
        normalized_beats.append({"time": time, "beat": beat, "bar": bar, "confidence": _confidence(item.get("confidence"), "beat confidence")})
    if any(normalized_beats[i]["time"] <= normalized_beats[i-1]["time"] for i in range(1, len(normalized_beats))):
        raise RunnerError("beats must be strictly ordered")
    for i, item in enumerate(normalized_beats):
        previous = normalized_beats[i - 1] if i else None
        active = next((entry["meter"] for entry in reversed(normalized_meter) if entry["bar"] <= item["bar"]), normalized_meter[0]["meter"])
        if item["beat"] > int(active.split("/")[0]):
            raise RunnerError("beat ordinal exceeds active meter")
        if previous is None:
            if item["bar"] != 1 or item["beat"] != 1:
                raise RunnerError("beat grid must begin at bar 1 beat 1")
        elif item["bar"] == previous["bar"]:
            if item["beat"] != previous["beat"] + 1:
                raise RunnerError("beats must be sequential within bars")
        elif item["bar"] != previous["bar"] + 1 or item["beat"] != 1:
            raise RunnerError("bars must be sequential")
    normalized_downbeats = [{"time": finite_number(x.get("time") if isinstance(x, dict) else x, "downbeat time", 0, duration + 1)} for x in downbeats]
    expected = [item["time"] for item in normalized_beats if item["beat"] == 1]
    if len(expected) != len(normalized_downbeats) or any(abs(expected[i] - normalized_downbeats[i]["time"]) > .05 for i in range(len(expected))):
        raise RunnerError("downbeats do not match canonical beat grid")
    bars = raw.get("bars")
    if not isinstance(bars, list) or not bars:
        raise RunnerError("All-In-One must provide bar evidence")
    normalized_bars = []
    for i, item in enumerate(bars):
        if not isinstance(item, dict):
            raise RunnerError(f"bar {i + 1} is invalid")
        number, start, end, count = item.get("bar"), item.get("start"), item.get("end"), item.get("beats")
        if (not isinstance(number, int) or number != i + 1 or
                not isinstance(count, int) or count < 1):
            raise RunnerError(f"bar {i + 1} is invalid")
        normalized_bars.append({"bar": number, "start": finite_number(start, "bar start", 0, duration),
                                "end": finite_number(end, "bar end", 0, duration),
                                "beats": count, "confidence": _confidence(item.get("confidence"), "bar confidence")})
        if normalized_bars[-1]["end"] <= normalized_bars[-1]["start"]:
            raise RunnerError(f"bar {i + 1} has non-positive duration")
    if len(normalized_bars) != normalized_beats[-1]["bar"]:
        raise RunnerError("bar evidence does not cover beat grid")
    sections = raw.get("sections")
    if not isinstance(sections, list) or not sections:
        raise RunnerError("All-In-One must provide labeled section evidence")
    result_sections = []
    last_end = 0
    final_bar = normalized_beats[-1]["bar"]
    for i, item in enumerate(sections):
        if not isinstance(item, dict):
            raise RunnerError(f"section {i + 1} is invalid")
        name = item.get("name", item.get("label"))
        start, end = item.get("startBar"), item.get("endBar")
        if not isinstance(name, str) or not name.strip() or not isinstance(start, int) or not isinstance(end, int) or start < 1 or end < start or end > final_bar or start <= last_end:
            raise RunnerError(f"section {i + 1} is invalid or unordered")
        result_sections.append({"name": name.strip(), "startBar": start, "endBar": end, "energy": _confidence(item.get("energy"), "section energy")})
        last_end = end
    return {"bpm": bpm, "meter": meter_text, "tempoMap": normalized_tempo, "meterMap": normalized_meter,
            "beats": normalized_beats, "downbeats": normalized_downbeats, "bars": normalized_bars,
            "sections": result_sections, "confidence": overall}


def run_job(request: dict[str, Any], checkpoint: Path, backend: AllInOneBackend | None = None) -> dict[str, Any]:
    require_cuda()
    digest = attest_checkpoint(checkpoint, PROVIDER)
    duration = finite_number(request_value(request, "durationSeconds"), "durationSeconds", .001)
    work = durable_job_dir(request, PROVIDER)
    audio = download_source(request_value(request, "sourceUrl"), work / "source.wav")
    validate_audio(audio)
    active = backend or OfficialAllInOneBackend()
    output = normalize_structure(active.analyze(audio, checkpoint), duration)
    output.update({"version": MODEL_VERSION, "modelVersion": MODEL_VERSION,
                   "provenance": {"provider": PROVIDER, "modelVersion": MODEL_VERSION,
                                  "checkpointSha256": digest, "backend": active.name,
                                  "backendVersion": BACKEND_VERSION,
                                  "revision": BACKEND_SOURCE_REVISION,
                                  "sourceRevision": BACKEND_SOURCE_REVISION,
                                  "upstreamSourceRevision": UPSTREAM_SOURCE_REVISION,
                                  "confidenceBasis": "decoder-grid-validity",
                                  "device": "cuda", **runtime_provenance()}})
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True); mode.add_argument("--smoke", action="store_true"); mode.add_argument("--job", action="store_true")
    parser.add_argument("--provider", required=True); parser.add_argument("--model-version", required=True); parser.add_argument("--checkpoint", required=True)
    args = parser.parse_args(argv)
    if args.provider != PROVIDER or args.model_version != MODEL_VERSION:
        raise RunnerError("provider or model version does not match this runner")
    checkpoint = Path(args.checkpoint)
    if args.smoke:
        require_cuda(); digest = attest_checkpoint(checkpoint, PROVIDER)
        audio = os.getenv("ALL_IN_ONE_SMOKE_AUDIO")
        if not audio or not Path(audio).is_file(): raise RunnerError("ALL_IN_ONE_SMOKE_AUDIO must reference mounted real audio")
        result = normalize_structure(OfficialAllInOneBackend().analyze(Path(audio), checkpoint), float("inf"))
        proof_provenance = {"provider": PROVIDER, "modelVersion": MODEL_VERSION,
              "checkpointSha256": digest, "backend": OfficialAllInOneBackend.name,
              "backendVersion": BACKEND_VERSION, "revision": BACKEND_SOURCE_REVISION,
              "sourceRevision": BACKEND_SOURCE_REVISION,
              "upstreamSourceRevision": UPSTREAM_SOURCE_REVISION, "device": "cuda"}
        proof_provenance.update(runtime_provenance())
        emit({"smokeTested": True, "provider": PROVIDER, "modelVersion": args.model_version,
              "version": args.model_version, "checkpointSha256": digest,
              "backend": OfficialAllInOneBackend.name,
              "backendVersion": BACKEND_VERSION,
              "sourceRevision": BACKEND_SOURCE_REVISION,
              "upstreamSourceRevision": UPSTREAM_SOURCE_REVISION, "device": "cuda",
              "provenance": proof_provenance,
              "output": {"beats": len(result["beats"]), "sections": len(result["sections"])}})
    else:
        import sys
        emit(run_job(json.load(sys.stdin), checkpoint))
    return 0


if __name__ == "__main__":
    try: raise SystemExit(main())
    except RunnerError as exc: raise SystemExit(f"ALL_IN_ONE runner failed: {exc}")