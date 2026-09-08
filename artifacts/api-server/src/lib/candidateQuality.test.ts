import assert from "node:assert/strict";
import test from "node:test";
import type { ArrangementPlan, SongModelData, TrackModel } from "@workspace/db";
import { evaluateCandidateMusicalFit } from "./candidateQuality";

const plan = {
  id: "plan",
  version: 1,
  sections: [
    {
      section: "verse",
      startBar: 1,
      endBar: 4,
      energy: 0.4,
      density: 0.4,
      tracks: { piano: "harmony", bass: "bass" },
      activeTracks: ["piano", "bass"],
      operations: [],
    },
    {
      section: "chorus",
      startBar: 5,
      endBar: 8,
      energy: 0.5,
      density: 0.5,
      tracks: { piano: "harmony", bass: "bass" },
      activeTracks: ["piano", "bass"],
      operations: [],
    },
  ],
  style: {
    orchestration: { density: 0.5 },
  },
  songModelVersion: 2,
  parameters: {},
  provenance: {},
} as unknown as ArrangementPlan;

const instrumentDefinition = {
  playableRange: { min: 24, max: 96 },
  constraints: { minNoteDuration: 0.05 },
};

const track = (id: string, instrument: string, pitch: number): TrackModel => ({
  id,
  instrument,
  role: id,
  notes: [
    { id: `${id}-1`, start: 17, duration: 1, pitch, velocity: 80 },
    { id: `${id}-2`, start: 19, duration: 1, pitch: pitch + 2, velocity: 80 },
    { id: `${id}-3`, start: 21, duration: 1, pitch: pitch + 4, velocity: 80 },
    { id: `${id}-4`, start: 23, duration: 1, pitch: pitch + 6, velocity: 80 },
  ],
  cc: [],
  articulations: [],
  automation: [],
  instrumentDefinition,
  source: "generated",
  version: 1,
  provenance: {},
} as unknown as TrackModel);

test("critic localizes a register collision to its bar and implicated tracks", () => {
  const report = evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan,
    tracks: [track("piano", "piano", 60), track("bass", "bass", 61)],
    harmonyDecisions: [],
  });

  const [finding] = report.dimensions.registerCollisions.findings;
  assert.ok(finding);
  assert.deepEqual(finding.affectedSections, ["chorus"]);
  assert.equal(finding.startBar, 5);
  assert.equal(finding.endBar, 5);
  assert.deepEqual(finding.affectedTrackIds, ["bass", "piano"]);
  assert.match(finding.musicalReason, /close-register collision/);
  assert.match(finding.id, /^music-critic-v1:registerCollisions:chorus:5-5:/);
});

test("critic returns separate non-overlapping findings in one dimension", () => {
  const separatedTrack = (id: string, instrument: string, pitch: number): TrackModel => ({
    ...track(id, instrument, pitch),
    notes: [
      { id: `${id}-verse`, start: 1, duration: 1, pitch, velocity: 80 },
      { id: `${id}-chorus`, start: 17, duration: 1, pitch, velocity: 80 },
      { id: `${id}-3`, start: 19, duration: 1, pitch: pitch + 6, velocity: 80 },
      { id: `${id}-4`, start: 21, duration: 1, pitch: pitch + 12, velocity: 80 },
    ],
  } as TrackModel);
  const report = evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan,
    tracks: [
      separatedTrack("piano", "piano", 60),
      separatedTrack("bass", "bass", 61),
    ],
    harmonyDecisions: [],
  });

  const findings = report.dimensions.registerCollisions.findings;
  assert.ok(findings.length >= 2);
  assert.ok(findings.some((finding) =>
    finding.affectedSections[0] === "verse" && finding.startBar === 1));
  assert.ok(findings.some((finding) =>
    finding.affectedSections[0] === "chorus" && finding.startBar === 5));
  assert.ok(findings.every((finding, index) =>
    findings.every((other, otherIndex) =>
      index === otherIndex || finding.endBar < other.startBar || other.endBar < finding.startBar)));
});