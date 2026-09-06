# MIDI-SAG worker

This private, isolated worker provides two identities: `MIDI_SAG` for the
vocal-to-MIDI/arrangement path and `MUSE_CONTROL_LITE` for its controlled neural
backing renderer. `modal_provision.py` is the only bootstrap path; the serving
container is offline, bearer-protected, and fail-closed until byte-hashed assets
and a real valid, nonempty MIDI smoke proof are present.