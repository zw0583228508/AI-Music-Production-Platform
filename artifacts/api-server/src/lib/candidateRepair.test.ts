import assert from "node:assert/strict";
import test from "node:test";
import type { ArrangementPlan, TrackModel } from "@workspace/db";
import {
  applyBoundedRepair,
  normalizeRepairFinding,
  repairTimeBounds,
  validateServerAuthoredRepairFinding,
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
  hierarchy: {
    version: "1.0",
    status: "applied",
    reason: null,
    precedence: ["song", "section", "phrase", "bar", "event"],
    song: { id: "plan", intent: "development_arc", climaxSectionId: "section:chorus:2" },
    sections: [
      { id: "section:verse:1", sourceSection: "verse", startBar: 1, endBar: 4, function: "verse", development: "initial", targetEnergy: .4, targetDensity: .4, phraseIds: [], barIds: ["bar:section:verse:1:1"] },
      { id: "section:chorus:2", sourceSection: "chorus", startBar: 5, endBar: 8, function: "chorus", development: "initial", targetEnergy: .8, targetDensity: .8, phraseIds: ["phrase:section:chorus:2:p1"], barIds: ["bar:section:chorus:2:5", "bar:section:chorus:2:6"] },
    ],
    phrases: [{ id: "phrase:section:chorus:2:p1", sectionId: "section:chorus:2", startBar: 5, endBar: 5, confidence: .9, intent: "protect_vocal_phrase" }],
    bars: [
      { id: "bar:section:verse:1:1", sectionId: "section:verse:1", bar: 1, meter: "4/4", phraseIds: [], vocalSpace: "unknown" },
      { id: "bar:section:chorus:2:5", sectionId: "section:chorus:2", bar: 5, meter: "3/4", phraseIds: ["phrase:section:chorus:2:p1"], vocalSpace: "occupied" },
      { id: "bar:section:chorus:2:6", sectionId: "section:chorus:2", bar: 6, meter: "3/4", phraseIds: [], vocalSpace: "available" },
    ],
    events: [
      { id: "event:section:verse:1:1:piano", sectionId: "section:verse:1", barId: "bar:section:verse:1:1", trackId: "piano", intent: "follow_section", source: "section" },
      { id: "event:section:chorus:2:5:piano", sectionId: "section:chorus:2", barId: "bar:section:chorus:2:5", trackId: "piano", intent: "support_vocal", source: "vocal_phrase" },
    ],
  },
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
    hierarchy: {
      ...plan.hierarchy,
      song: { ...plan.hierarchy.song, climaxSectionId: "section:verse:1" },
      sections: plan.hierarchy.sections.map((section) => ({
        ...section,
        targetEnergy: section.id === "section:chorus:2" ? .7 : .1,
      })),
      bars: plan.hierarchy.bars.map((bar) => bar.id === "bar:section:chorus:2:5"
        ? { ...bar, vocalSpace: "available" as const, phraseIds: [] }
        : bar),
      events: plan.hierarchy.events.map((event) => event.id === "event:section:chorus:2:5:piano"
        ? { ...event, intent: "use_vocal_space" as const, source: "vocal_space" as const }
        : event),
    },
  };
  const result = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate",
      sourceCandidateLabel: "Original Candidate",
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
  assert.equal(result.plan.hierarchy.song.climaxSectionId, "section:chorus:2");
  assert.equal(result.plan.hierarchy.sections[0].targetEnergy, .4);
  assert.equal(result.plan.hierarchy.sections[1].targetEnergy, .8);
  assert.equal(result.plan.hierarchy.bars.find((bar) => bar.id === "bar:section:chorus:2:5")?.vocalSpace, "available");
  assert.deepEqual(result.changedScopes, [
    { level: "bar", id: "bar:section:chorus:2:5" },
    { level: "event", id: "event:section:chorus:2:5:piano" },
  ]);
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

test("repair scope must exactly match the server-authored finding identity", () => {
  const finding = {
    id: "critic-server-owned",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "The chorus piano voicing clashes with the melody.",
  };
  assert.deepEqual(
    validateServerAuthoredRepairFinding(
      finding.id,
      finding,
      [finding],
      plan,
      [track("piano")],
    ),
    finding,
  );
  assert.throws(() => validateServerAuthoredRepairFinding(
    finding.id,
    { ...finding, endBar: 7 },
    [finding],
    plan,
    [track("piano")],
  ), /server-authored/);
  assert.throws(() => validateServerAuthoredRepairFinding(
    "unknown",
    finding,
    [finding],
    plan,
    [track("piano")],
  ), /not available/);
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
      sourceCandidateLabel: "Original Candidate",
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

test("repairing a legacy plan materializes a valid hierarchy and reports every added scope", () => {
  const piano = track("piano");
  const { hierarchy: _removed, ...legacyPlan } = plan;
  const finding = normalizeRepairFinding({
    id: "legacy-upgrade",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "Repair the legacy candidate without returning an invalid plan.",
  }, legacyPlan as ArrangementPlan, [piano]);
  const result = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "legacy",
      sourceCandidateLabel: "Legacy Candidate",
      sourceScore: .4,
      seed: 3,
      maxAttempts: 2,
      finding,
      plan: legacyPlan as ArrangementPlan,
      trackModels: [piano],
    },
    proposedPlan: plan,
    proposedTrackModels: [piano],
    timeBounds: { start: 16, end: 24 },
  });
  assert.equal(result.plan.hierarchy.status, "applied");
  assert.equal(result.changedScopes[0].level, "song");
  assert.ok(result.changedScopes.some((scope) =>
    scope.level === "event" && scope.id === "event:section:chorus:2:5:piano"));
});