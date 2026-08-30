import assert from "node:assert/strict";
import test from "node:test";
import type { ArrangementRevisionSnapshot } from "@workspace/db";
import { revisionSummary } from "./arrangementRevisions";

const snapshot = (overrides: Partial<ArrangementRevisionSnapshot> = {}) => ({
  name: "Draft",
  harmonyComplexity: 5,
  energy: 0.6,
  density: 0.55,
  orchestraSize: 0.5,
  rhythmIntensity: 0.6,
  selectedCandidateId: null,
  sections: [{
    name: "Verse",
    startBar: 1,
    endBar: 8,
    energy: 0.6,
    density: 0.55,
    tracks: ["Piano"],
    chords: [{ id: "chord-1", startBeat: 0, durationBeats: 4, symbol: "C", quality: "major", inversion: 0 }],
    midiNotes: [],
    cc: [64],
    midiTracks: {
      Piano: {
        notes: [{ id: "note-1", pitch: 60, start: 0, duration: 1, velocity: 90, articulation: "sustain" }],
        cc: [64],
      },
    },
    markers: [],
    automation: [],
    transposeSemitones: 0,
  }],
  ...overrides,
}) as ArrangementRevisionSnapshot;

test("revision summaries account separately for section, chord, note, CC, membership, and conductor edits", () => {
  const before = snapshot();
  const after = snapshot({
    energy: 0.8,
    sections: [{
      ...before.sections[0],
      endBar: 9,
      tracks: ["Piano", "Bass"],
      chords: [{ ...before.sections[0].chords![0], symbol: "G" }],
      midiTracks: {
        Piano: {
          notes: [{ ...before.sections[0].midiTracks!.Piano.notes[0], pitch: 62 }],
          cc: [72],
        },
      },
    }],
  });
  const summary = revisionSummary(before, after);
  assert.deepEqual(summary.affectedSections, ["Verse"]);
  assert.deepEqual(summary.affectedTracks, ["Bass", "Piano"]);
  assert.equal(summary.trackMembershipChanges, 1);
  assert.equal(summary.chordChanges, 1);
  assert.equal(summary.noteChanges, 1);
  assert.equal(summary.ccChanges, 1);
  assert.deepEqual(summary.conductorControls, ["Energy"]);
});
