import assert from "node:assert/strict";
import test from "node:test";
import type { ArrangementPlan, TrackModel } from "@workspace/db";
import {
  applyBoundedRepair,
  normalizeRepairFinding,
  repairTimeBounds,
} from "./candidateRepair";

const plan = {
  id: "plan",
  version: 1,
  sections: [
    { section: "verse", startBar: 1, endBar: 4, energy: 0.4, density: 0.4, tracks: {}, operations: [] },
    { section: "chorus", startBar: 5, endBar: 8, energy: 0.8, density: 0.8, tracks: {}, operations: [] },
  ],
  style: {},
  songModelVersion: 1,
  parameters: {},
  provenance: {},
} as unknown as ArrangementPlan;
const track = (id: string): TrackModel => ({
  id,
  instrument: "piano",
  role: id,
  notes: [
    { id: `${id}-outside`, start: 2, duration: 1, pitch: 60, velocity: 80 },
    { id: `${id}-inside`, start: 18, duration: 1, pitch: 62, velocity: 80 },
  ],
  cc: [],
  articulations: [],
  automation: [],
  source: "original",
  version: 1,
  provenance: { model: "test", version: "1", parameters: {}, parentIds: [], createdBy: "test" },
} as unknown as TrackModel);

test("bounded repairs preserve every unscoped event and track", () => {
  const bass = track("bass");
  const piano = track("piano");
  const finding = normalizeRepairFinding({
    id: "critic-1",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "The chorus piano voicing clashes with the melody.",
  }, plan, [piano, bass]);
  const proposedPiano = {
    ...piano,
    notes: [
      { id: "rewritten-outside", start: 2, duration: 1, pitch: 20, velocity: 1 },
      { id: "repaired-inside", start: 18, duration: 1, pitch: 67, velocity: 90 },
    ],
    source: "repair",
    version: 2,
  };
  const proposedPlan = {
    ...plan,
    sections: plan.sections.map((section) => ({
      ...section,
      energy: section.section === "chorus" ? 0.7 : 0.1,
    })),
  };
  const result = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate",
      sourceScore: 0.5,
      seed: 123,
      maxAttempts: 2,
      finding,
      plan,
      trackModels: [piano, bass],
    },
    proposedPlan,
    proposedTrackModels: [proposedPiano, { ...bass, source: "wrong" }],
    timeBounds: { start: 16, end: 24 },
  });
  assert.equal(result.outsideScopePreserved, true);
  assert.deepEqual(result.trackModels.find((item) => item.id === "bass"), bass);
  assert.equal(result.trackModels[0].notes[0].id, "piano-outside");
  assert.equal(result.trackModels[0].notes[1].id, "repaired-inside");
  assert.equal(result.plan.sections[0].energy, 0.4);
  assert.equal(result.plan.sections[1].energy, 0.8);
});

test("critic findings must identify concrete known musical scope", () => {
  assert.throws(() => normalizeRepairFinding({
    id: "critic-2",
    affectedSections: [],
    startBar: 5,
    endBar: 4,
    affectedTrackIds: ["missing"],
    musicalReason: "",
  }, plan, [track("piano")]), /critic finding/);
});

test("notes crossing either repair boundary remain byte-for-byte original", () => {
  const piano = track("piano");
  piano.notes = [
    { id: "crosses-start", start: 15, duration: 2, pitch: 60, velocity: 80 },
    { id: "crosses-end", start: 23, duration: 2, pitch: 62, velocity: 80 },
  ];
  const finding = normalizeRepairFinding({
    id: "critic-boundaries",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "Repair the notes fully contained in these bars.",
  }, plan, [piano]);
  const result = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate",
      sourceScore: 0.5,
      seed: 123,
      maxAttempts: 2,
      finding,
      plan,
      trackModels: [piano],
    },
    proposedPlan: plan,
    proposedTrackModels: [{
      ...piano,
      notes: [
        { id: "changed-crosses-start", start: 15, duration: 2, pitch: 20, velocity: 1 },
        { id: "changed-crosses-end", start: 23, duration: 2, pitch: 20, velocity: 1 },
        { id: "contained", start: 18, duration: 1, pitch: 67, velocity: 90 },
      ],
    }],
    timeBounds: { start: 16, end: 24 },
  });
  assert.equal(result.outsideScopePreserved, true);
  assert.deepEqual(result.trackModels[0].notes, [
    piano.notes[0],
    { id: "contained", start: 18, duration: 1, pitch: 67, velocity: 90 },
    piano.notes[1],
  ]);
});

test("repair time bounds follow canonical meter changes", () => {
  const finding = {
    id: "meter-change",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "Repair two bars after the meter change.",
  };
  assert.deepEqual(repairTimeBounds(
    finding,
    [{ time: 0, bpm: 60 }],
    [{ bar: 1, meter: "4/4" }, { bar: 5, meter: "3/4" }],
  ), { start: 16, end: 22 });
});

test("critic bars cannot extend into an unnamed section", () => {
  assert.throws(() => normalizeRepairFinding({
    id: "cross-section",
    affectedSections: ["chorus"],
    startBar: 4,
    endBar: 5,
    affectedTrackIds: ["piano"],
    musicalReason: "This must not rewrite the verse.",
  }, plan, [track("piano")]), /Every repair bar/);
});