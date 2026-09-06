"""Direct, offline calls into the pinned SheetSage 0.2.1 public API."""
from __future__ import annotations

import hashlib
import math
import os
from importlib.metadata import version
from pathlib import Path
from typing import Any


class InferenceError(RuntimeError):
    pass


def _confidence(logits: Any, onset: int) -> float:
    import numpy as np
    rows = np.concatenate(logits, axis=0)
    if onset < 0 or onset >= len(rows):
        raise InferenceError("SheetSage evidence onset is outside model logits")
    row = rows[onset].astype(float)
    row -= np.max(row)
    probabilities = np.exp(row)
    return float(np.max(probabilities / np.sum(probabilities)))


def _format_output(result: tuple[Any, ...]) -> dict[str, Any]:
    from sheetsage.align import create_beat_to_time_fn

    if len(result) != 6:
        raise InferenceError("SheetSage public API returned unexpected intermediaries")
    lead_sheet, beats, beat_times, _, melody_logits, harmony_logits, = result
    if not melody_logits or not harmony_logits:
        raise InferenceError("SheetSage returned no model confidence logits")
    harmony, melody, total_tertiaries = lead_sheet[3], lead_sheet[4], lead_sheet[5]
    beat_to_time = create_beat_to_time_fn(beats, beat_times)
    tertiary_time = lambda value: float(beat_to_time(value / 4))

    # Reproduce LeadSheet.as_midi's documented octave normalization while
    # retaining per-event confidence from the actual melody logits.
    raw_pitches = [note.as_midi_pitch() for _, _, note in melody]
    octave_shift = max(
        range(-10, 11),
        key=lambda shift: sum(60 <= pitch + shift * 12 <= 71 for pitch in raw_pitches),
        default=0,
    )
    melody_evidence = [{
        "start": tertiary_time(onset),
        "end": tertiary_time(onset + duration),
        "pitch": int(note.as_midi_pitch() + octave_shift * 12),
        "confidence": _confidence(melody_logits, onset),
    } for onset, duration, note in melody]

    qualities = {
        (4, 3): "", (3, 4): "m", (3, 4, 3): "m7", (4, 3, 3): "7",
        (4, 3, 4): "maj7", (5, 2): "sus4", (3, 3): "dim", (4, 4): "aug",
    }
    chord_evidence = []
    for index, (onset, chord) in enumerate(harmony):
        end = harmony[index + 1][0] if index + 1 < len(harmony) else total_tertiaries
        intervals = tuple(int(value) for value in chord[1])
        if chord[0] is None or intervals not in qualities:
            raise InferenceError("SheetSage returned an unsupported chord identity")
        root = chord[0].as_human_pitch_name(enharmonics="b")
        chord_evidence.append({
            "start": tertiary_time(onset), "end": tertiary_time(end),
            "symbol": str(root) + qualities[intervals],
            "confidence": _confidence(harmony_logits, onset),
            "timing": {
                "startSeconds": tertiary_time(onset),
                "endSeconds": tertiary_time(end),
            },
        })
    timing = [{
        "start": float(beat_times[index]),
        "end": float(beat_times[index + 1]),
        "beat": float(beats[index]),
    } for index in range(min(len(beats), len(beat_times)) - 1)
        if beat_times[index + 1] > beat_times[index]]
    confidences = [item["confidence"] for item in melody_evidence + chord_evidence]
    if not melody_evidence or not chord_evidence or not timing or not confidences:
        raise InferenceError("SheetSage returned incomplete lead-sheet evidence")
    overall = float(sum(confidences) / len(confidences))
    if not math.isfinite(overall):
        raise InferenceError("SheetSage returned non-finite confidence")
    return {"melody": melody_evidence, "chords": chord_evidence,
            "timing": timing, "confidence": overall}


def run(audio_source: bytes | Path, asset_root: Path, timeout_seconds: int) -> dict[str, Any]:
    del timeout_seconds  # Modal function timeout is the hard execution boundary.
    size = audio_source.stat().st_size if isinstance(audio_source, Path) else len(audio_source)
    if not size or size > 512 * 1024 * 1024:
        raise InferenceError("audio payload is empty or exceeds 512 MiB")
    if version("sheetsage-infer") != "0.2.1":
        raise InferenceError("installed SheetSage package is not pinned 0.2.1")
    if version("jukebox-infer") != "0.1.2" or version("madmom-infer") != "0.2.0":
        raise InferenceError("SheetSage dependency identity does not match manifest")
    os.environ.update({
        "SHEETSAGE_CACHE_DIR": str(asset_root), "XDG_CACHE_HOME": str(asset_root),
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    })
    try:
        import sheetsage.assets
        import sheetsage.beat_track
        import madmom_infer.models
        from sheetsage.infer import sheetsage as sheetsage_api

        def forbidden_download(*_args: Any, **_kwargs: Any) -> Any:
            raise InferenceError("request-time model download is forbidden")

        def forbidden_fallback(*_args: Any, **_kwargs: Any) -> Any:
            raise InferenceError("madmom model inference failed; fallback is forbidden")

        def offline_madmom_model(model_file: Any, cache_root: Path | None = None,
                                 force: bool = False) -> Path:
            if force:
                raise InferenceError("request-time model download is forbidden")
            cache_root = cache_root or asset_root / "madmom_infer" / "models"
            path = Path(cache_root) / model_file.relpath
            if not path.is_file():
                raise InferenceError("required madmom checkpoint is unavailable")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != model_file.sha256:
                raise InferenceError("required madmom checkpoint hash does not match")
            return path

        sheetsage.assets._download = forbidden_download
        madmom_infer.models.download = offline_madmom_model
        sheetsage.beat_track._librosa_fallback = forbidden_fallback
        result = sheetsage_api(audio_source, use_jukebox=False, detect_melody=True,
                               detect_harmony=True, return_intermediaries=True)
        return _format_output(result)
    except InferenceError:
        raise
    except Exception as exc:
        raise InferenceError(f"official SheetSage inference failed: {type(exc).__name__}") from exc