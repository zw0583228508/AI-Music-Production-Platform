import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const bundlePath = `/tmp/candidate-quality-${process.pid}.mjs`;
await build({
  stdin: {
    contents: `
      export {
        QualityEngine,
        createStyleSpec,
        renderMusicPipeline,
      } from "./src/lib/musicEngines";
      export { hasCompleteQualityEvidence, isSelectableCandidate, rankEvaluatedCandidates } from "./src/lib/candidateRanking";
    `,
    resolveDir: apiDirectory,
    sourcefile: "candidate-quality-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
});
const {
  QualityEngine,
  createStyleSpec,
  renderMusicPipeline,
  rankEvaluatedCandidates,
  hasCompleteQualityEvidence,
  isSelectableCandidate,
} =
  await import(pathToFileURL(bundlePath).href);
after(() => unlink(bundlePath).catch(() => undefined));

const instrumentDefinition = {
  id: "piano",
  family: "keys",
  playableRange: { min: 21, max: 108 },
  comfortableRange: { min: 36, max: 96 },
  registers: [],
  polyphonic: true,
  maxVoices: 10,
  articulations: ["sustain"],
  constraints: {
    maxLeap: 24,
    minNoteDuration: 0.05,
    maxSimultaneousNotes: 10,
  },
  controls: {
    dynamics: [1],
    expression: [11],
    sustain: 64,
    pitchBend: true,
    aftertouch: false,
  },
};

const plan = {
  id: "quality-plan",
  version: 1,
  style: {
    orchestration: {
      density: 0.5,
    },
  },
  sections: [
    { section: "verse", startBar: 1, endBar: 2, tracks: {}, energy: 0.5, density: 0.5 },
    { section: "chorus", startBar: 3, endBar: 4, tracks: {}, energy: 0.8, density: 0.8 },
  ],
};

const track = {
  id: "piano-track",
  instrument: "Piano",
  instrumentDefinition,
  role: "harmony",
  notes: [
    { id: "n1", start: 0, duration: 0.5, pitch: 60, velocity: 90 },
    { id: "n2", start: 1, duration: 0.5, pitch: 64, velocity: 90 },
    { id: "n3", start: 1.5, duration: 0.5, pitch: 67, velocity: 90 },
    { id: "n4", start: 5, duration: 0.5, pitch: 72, velocity: 90 },
  ],
  cc: [],
  articulations: [],
  automation: [],
  source: "TEST",
  version: 1,
  provenance: {
    model: "TEST",
    version: "1",
    parameters: {},
    parentIds: [],
    createdBy: "test",
  },
};

test("quality analysis reports every required weighted dimension", () => {
  const audibleMix = new Float32Array(8_000).fill(0.2);
  const report = new QualityEngine().assess(
    [track],
    audibleMix,
    plan,
    {
      lineageComplete: true,
      renderArtifactIds: ["audio", "midi"],
      evaluatedAt: "2026-08-30T00:00:00.000Z",
      bpm: 120,
      meter: "4/4",
    },
  );
  const dimensions = [
    "silence",
    "clipping",
    "notePlayability",
    "timing",
    "sectionCoverage",
    "lineage",
  ];
  assert.deepEqual(Object.keys(report.weights).sort(), dimensions.sort());
  for (const dimension of dimensions) {
    assert.ok(Number.isFinite(report.checks[dimension]), dimension);
  }
  assert.equal(
    Number(Object.values(report.weights).reduce((sum, weight) => sum + weight, 0).toFixed(3)),
    1,
  );
  assert.deepEqual(report.renderArtifactIds, ["audio", "midi"]);
  assert.equal(report.lineageComplete, true);
  assert.equal(report.checks.sectionCoverage, 1);
  assert.equal(report.strengths.length, 2);
  assert.equal(report.weaknesses.length, 2);
});

test("silence, clipping, and missing lineage reduce independent quality", () => {
  const clean = new QualityEngine().assess(
    [track],
    new Float32Array(8_000).fill(0.2),
    plan,
    { lineageComplete: true, bpm: 120 },
  );
  const failedEvidence = new QualityEngine().assess(
    [track],
    new Float32Array(8_000).fill(1),
    plan,
    { lineageComplete: false, bpm: 120 },
  );
  const silent = new QualityEngine().assess(
    [track],
    new Float32Array(8_000),
    plan,
    { lineageComplete: true, bpm: 120 },
  );
  assert.equal(failedEvidence.checks.clipping, 0);
  assert.equal(failedEvidence.checks.lineage, 0);
  assert.equal(silent.checks.silence, 0);
  assert.ok(clean.score > failedEvidence.score);
  assert.ok(clean.score > silent.score);
});

test("section coverage uses the planned bar timeline instead of stretching early notes", () => {
  const earlyOnlyTrack = {
    ...track,
    notes: track.notes.filter((note) => note.start < 4),
  };
  const report = new QualityEngine().assess(
    [earlyOnlyTrack],
    new Float32Array(8_000).fill(0.2),
    plan,
    { lineageComplete: true, bpm: 120, meter: "4/4" },
  );
  assert.equal(report.checks.sectionCoverage, 0.5);
  assert.ok(report.warnings.some((warning) => warning.includes("sections")));
});

test("6/8 section coverage honors the denominator at a section boundary", () => {
  const compoundPlan = {
    ...plan,
    sections: [
      { section: "a", startBar: 1, endBar: 1, tracks: {}, energy: 0.5, density: 0.5 },
      { section: "b", startBar: 2, endBar: 2, tracks: {}, energy: 0.7, density: 0.7 },
    ],
  };
  const boundaryTrack = {
    ...track,
    notes: [
      { id: "boundary", start: 2.8, duration: 0.4, pitch: 60, velocity: 90 },
    ],
  };
  const report = new QualityEngine().assess(
    [boundaryTrack],
    new Float32Array(8_000).fill(0.2),
    compoundPlan,
    { lineageComplete: true, bpm: 60, meter: "6/8" },
  );
  assert.equal(report.checks.sectionCoverage, 1);
});

test("6/8 candidate generation and render quality share one bar timeline", () => {
  const songModel = {
    tempoMap: [{ start: 0, end: 6, bpm: 60, confidence: 1 }],
    meterMap: [{ start: 0, end: 6, meter: "6/8", confidence: 1 }],
    keyMap: [{ start: 0, end: 6, key: "C", mode: "major", confidence: 1 }],
    chords: [],
    melody: [],
    sections: [
      { name: "A", startBar: 1, endBar: 1, energy: 0.5 },
      { name: "B", startBar: 2, endBar: 2, energy: 0.8 },
    ],
  };
  const style = createStyleSpec(
    "orchestral",
    {
    harmonyComplexity: 5,
    energy: 0.6,
    density: 0.6,
    },
  );
  const pipelinePlan = {
    ...plan,
    style,
    sections: [
      { section: "a", startBar: 1, endBar: 1, tracks: { Piano: "main_harmony" }, energy: 0.5, density: 0.5, operations: [] },
      { section: "b", startBar: 2, endBar: 2, tracks: { Piano: "main_harmony" }, energy: 0.8, density: 0.8, operations: [] },
    ],
    provenance: track.provenance,
  };
  const result = renderMusicPipeline({
    songModel,
    plan: pipelinePlan,
    tracks: [{ id: "piano-track", name: "Piano", role: "harmony" }],
    style,
    masterProfile: "streaming",
    sampleRate: 1_000,
    quality: { lineageComplete: true },
  });
  const secondSectionNotes = result.tracks[0].trackModel.notes.filter(
    (note) => note.start >= 3 && note.start < 6,
  );
  assert.ok(secondSectionNotes.length > 0);
  assert.equal(result.quality.checks.sectionCoverage, 1);
  assert.ok(result.durationSeconds <= 7);
});

test("failed quality evidence is unranked regardless of provider score", () => {
  const evaluated = (label, score, providerScore) => ({
    label,
    score,
    evaluation: {
      status: "evaluated",
      providerScore,
      renderArtifactIds: ["audio", "midi"],
      artifacts: [
        { id: "audio", type: "AUDIO_TRACK", label: "Audio", url: "export-object://audio" },
        { id: "midi", type: "MIDI", label: "MIDI", url: "export-object://midi" },
        { id: "quality", type: "QUALITY_REPORT", label: "Quality", url: "export-object://quality" },
      ],
      qualityReport: {
        score,
        checks: {
          silence: 1, clipping: 1, notePlayability: 1, timing: 1,
          sectionCoverage: 1, lineage: 1,
        },
        weights: {
          silence: 0.15, clipping: 0.15, notePlayability: 0.2, timing: 0.15,
          sectionCoverage: 0.15, lineage: 0.2,
        },
        strengths: [], weaknesses: [], warnings: [],
        evaluatedAt: "2026-08-30T00:00:00.000Z",
        renderArtifactIds: ["audio", "midi"],
        lineageComplete: true,
      },
      error: null,
    },
  });
  const failed = {
    label: "provider favorite without evidence",
    score: 0.99,
    evaluation: {
      status: "analysis_failed",
      providerScore: 0.99,
      renderArtifactIds: [],
      artifacts: [
        { id: "audio", type: "AUDIO_TRACK", label: "Audio", url: "export-object://audio" },
        { id: "midi", type: "MIDI", label: "MIDI", url: "export-object://midi" },
        { id: "quality", type: "QUALITY_REPORT", label: "Quality", url: "export-object://quality" },
      ],
      qualityReport: null,
      error: "quality unavailable",
    },
  };
  const ranked = rankEvaluatedCandidates([
    failed,
    evaluated("measured second", 0.72, 0.4),
    evaluated("measured first", 0.91, 0.2),
  ]);
  assert.deepEqual(
    ranked.map(({ label, rank }) => ({ label, rank })),
    [
      { label: "measured first", rank: 1 },
      { label: "measured second", rank: 2 },
      { label: "provider favorite without evidence", rank: null },
    ],
  );
});

test("an evaluated row without complete quality evidence is unranked", () => {
  const incomplete = {
    status: "evaluated",
    providerScore: 1,
    renderArtifactIds: ["audio", "midi"],
    artifacts: [
      { id: "audio", type: "AUDIO_TRACK", label: "Audio", url: "export-object://audio" },
      { id: "midi", type: "MIDI", label: "MIDI", url: "export-object://midi" },
    ],
    qualityReport: {
      score: 1, checks: {}, weights: {}, strengths: [], weaknesses: [], warnings: [],
      evaluatedAt: "2026-08-30T00:00:00.000Z", renderArtifactIds: ["audio", "midi"],
      lineageComplete: false,
    },
    error: null,
  };
  assert.equal(hasCompleteQualityEvidence(incomplete), false);
  assert.equal(rankEvaluatedCandidates([{ score: 1, evaluation: incomplete }])[0].rank, null);
  assert.equal(isSelectableCandidate({
    status: "validated",
    evaluation: incomplete,
    trackModels: [],
    evaluatedPlan: {},
    evaluatedStyleSpec: {},
  }), false);
});