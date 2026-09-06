"""Small, dependency-backed capability checks for the Python worker.

These checks deliberately cover only local symbolic MIDI serialization and
Pedalboard's built-in effects. Native instrument renderers remain separately
attested optional adapters in :mod:`app`; no synthetic renderer is a fallback.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import numpy as np


SYMBOLIC_IMPORTS = ("music21", "mido", "pretty_midi")


def require_symbolic_packages() -> None:
    """Import every package required for the local symbolic MIDI boundary."""
    for module_name in SYMBOLIC_IMPORTS:
        importlib.import_module(module_name)


def smoke_midi_round_trip(directory: Path) -> dict[str, int]:
    """Serialize one note through music21, mido, and pretty_midi.

    The output is parsed again with mido so this is a real Standard MIDI File
    serialization path rather than a constructor-only import check.
    """
    require_symbolic_packages()
    import mido
    import music21
    import pretty_midi

    directory.mkdir(parents=True, exist_ok=True)
    source = directory / "music21-source.mid"
    mido_copy = directory / "mido-copy.mid"
    output = directory / "pretty-midi-output.mid"

    score = music21.stream.Stream()
    score.append(music21.note.Note("C4", quarterLength=1))
    score.write("midi", fp=str(source))

    parsed_by_mido = mido.MidiFile(str(source))
    parsed_by_mido.save(str(mido_copy))

    parsed_by_pretty_midi = pretty_midi.PrettyMIDI(str(mido_copy))
    parsed_by_pretty_midi.write(str(output))
    round_tripped = mido.MidiFile(str(output))
    note_ons = sum(
        1
        for track in round_tripped.tracks
        for message in track
        if message.type == "note_on" and message.velocity > 0
    )
    if note_ons < 1:
        raise AssertionError("MIDI round-trip did not retain a note_on event")
    return {"noteOnEvents": note_ons, "tracks": len(round_tripped.tracks)}


def smoke_pedalboard_builtins() -> dict[str, float | int]:
    """Process non-silent audio with a built-in Pedalboard effect."""
    from pedalboard import Gain, Pedalboard

    input_audio = np.ones((1, 128), dtype=np.float32)
    output_audio = Pedalboard([Gain(gain_db=-6)])(input_audio, 22050)
    peak = float(np.max(np.abs(output_audio)))
    if output_audio.shape != input_audio.shape:
        raise AssertionError("Pedalboard changed the expected channel/frame shape")
    if not np.isfinite(output_audio).all() or not 0 < peak < 1:
        raise AssertionError("Pedalboard built-in Gain did not process finite audio")
    return {"channels": output_audio.shape[0], "frames": output_audio.shape[1], "peak": peak}