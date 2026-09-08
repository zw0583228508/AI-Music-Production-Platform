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
       export { hasCompleteQualityEvidence, isSelectableCandidate, publicCandidateEvaluation, rankEvaluatedCandidates } from "./src/lib/candidateRanking";
       export { evaluateCandidateMusicalFit } from "./src/lib/candidateQuality";
       export { evaluateRenderedPcm } from "./src/lib/perceptualAudioCritic";
       export { audioFindingToRepairFinding } from "./src/lib/candidateRepair";
       export {
         candidateDistance,
         diversityEvidence,
         fingerprintCandidate,
         seedForCandidate,
         strategyForCandidate,
       } from "./src/lib/candidateDiversity";
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
  publicCandidateEvaluation,
   candidateDistance,
   diversityEvidence,
   fingerprintCandidate,
   seedForCandidate,
   strategyForCandidate,
  evaluateCandidateMusicalFit,
   evaluateRenderedPcm,
   audioFindingToRepairFinding,
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

const criticDimensionNames = [
  "vocalFit",
  "harmony",
  "development",
  "contrastAndTransitions",
  "registerCollisions",
  "playability",
  "repetition",
  "styleAndControlAdherence",
];

const musicCritic = (score, overrides = {}) => ({
  version: "music-critic-v1",
  score,
  dimensions: Object.fromEntries(criticDimensionNames.map((name) => [
    name,
    overrides[name] ?? {
      status: "available",
      score,
      evidence: [{
        source: "section_plan",
        summary: `${name} evidence`,
        observations: { observed: true },
      }],
      explanation: `${name} explanation`,
    },
  ])),
});

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
    audio: { name: "test.wav", contentType: "audio/wav", size: 0, durationSeconds: 6, sampleRate: 1_000, channels: 1 },
    tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
    meterMap: [{ bar: 1, meter: "6/8", confidence: 1 }],
    keyMap: [{ time: 0, key: "C", confidence: 1 }],
    chords: [],
    melody: [],
    sections: [
      { name: "A", startBar: 1, endBar: 1, energy: 0.5 },
      { name: "B", startBar: 2, endBar: 2, energy: 0.8 },
    ],
    energy: [0.5, 0.8],
    bars: [
      { bar: 1, start: 0, end: 3, beats: 6, confidence: 1 },
      { bar: 2, start: 3, end: 6, beats: 6, confidence: 1 },
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
  const localAudio = evaluateRenderedPcm({
    pcm: result.master, channels: 2, sampleRate: 1_000,
    artifactId: "local-wav", artifactSha256: "c".repeat(64),
    renderedTracks: result.tracks.map(({ trackModel, samples }) => ({
      id: trackModel.id, pcm: samples, channels: 2, sampleRate: 1_000,
    })),
  });
  // Add a second real renderer buffer to exercise evidence qualification.
  const multitrackAudio = evaluateRenderedPcm({
    ...localAudio, pcm: result.master, channels: 2, sampleRate: 1_000,
    artifactId: "local-wav", artifactSha256: "c".repeat(64),
    renderedTracks: [
      ...result.tracks.map(({ trackModel, samples }) => ({
        id: trackModel.id, pcm: samples, channels: 2, sampleRate: 1_000,
      })),
      { id: "duplicate-render", pcm: result.tracks[0].samples.slice(), channels: 2, sampleRate: 1_000 },
    ],
  });
  assert.equal(multitrackAudio.status, "available");
  assert.equal(multitrackAudio.dimensions.masking.status, "available");
  assert.equal(multitrackAudio.dimensions.balance.status, "available");
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
      musicCritic: musicCritic(score),
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
  assert.equal(isSelectableCandidate({
    status: "validated",
    evaluation: ranked[0].evaluation,
    trackModels: [],
    evaluatedPlan: {},
    evaluatedStyleSpec: {},
  }), false);
});

test("verified provider audio is selectable without inventing symbolic TrackModels", () => {
  const providerPcm = new Float32Array(4_000).fill(.15);
  const providerAudioCritic = evaluateRenderedPcm({
    pcm: providerPcm,
    sampleRate: 1_000,
    channels: 2,
    artifactId: "audio",
    artifactSha256: "d".repeat(64),
    renderedTracks: [],
  });
  assert.equal(providerAudioCritic.status, "available");
  assert.equal(providerAudioCritic.dimensions.vocalFit.status, "unavailable");
  assert.equal(providerAudioCritic.dimensions.masking.status, "unavailable");
  assert.equal(providerAudioCritic.dimensions.balance.status, "unavailable");
  const evaluation = {
    status: "evaluated",
    providerScore: 0.8,
    renderArtifactIds: ["audio"],
    artifacts: [
      {
        id: "audio",
        type: "AUDIO_TRACK",
        label: "Provider audio",
        url: "export-object://audio",
        artifactSha256: "d".repeat(64),
      },
      { id: "quality", type: "QUALITY_REPORT", label: "Quality", url: "export-object://quality" },
    ],
    qualityReport: {
      score: 0.82,
      checks: {
        silence: 1, clipping: 1, notePlayability: 0, timing: 0,
        sectionCoverage: 0, lineage: 1,
      },
      weights: {
        silence: 0.15, clipping: 0.15, notePlayability: 0.2, timing: 0.15,
        sectionCoverage: 0.15, lineage: 0.2,
      },
      strengths: [], weaknesses: [], warnings: [],
      evaluatedAt: "2026-09-01T00:00:00.000Z",
      renderArtifactIds: ["audio"],
      lineageComplete: true,
    },
    musicCritic: musicCritic(0.82, {
      vocalFit: {
        status: "unavailable", score: null,
        evidence: [{ source: "vocal_activity", summary: "Unavailable", observations: {} }],
        explanation: "Unavailable",
      },
      harmony: {
        status: "unavailable", score: null,
        evidence: [{ source: "harmony_decisions", summary: "Unavailable", observations: {} }],
        explanation: "Unavailable",
      },
      registerCollisions: {
        status: "unavailable", score: null,
        evidence: [{ source: "track_notes", summary: "Unavailable", observations: {} }],
        explanation: "Unavailable",
      },
      playability: {
        status: "unavailable", score: null,
        evidence: [{ source: "instrument_constraints", summary: "Unavailable", observations: {} }],
        explanation: "Unavailable",
      },
      repetition: {
        status: "unavailable", score: null,
        evidence: [{ source: "track_notes", summary: "Unavailable", observations: {} }],
        explanation: "Unavailable",
      },
    }),
    audioCritic: providerAudioCritic,
    error: null,
  };
  assert.equal(hasCompleteQualityEvidence(evaluation), true);
  assert.equal(isSelectableCandidate({
    status: "validated",
    evaluation,
    trackModels: [],
    evaluatedPlan: {},
    evaluatedStyleSpec: {},
  }), true);

  const falselyClaimedMidi = {
    ...evaluation,
    renderArtifactIds: ["audio", "midi"],
    qualityReport: {
      ...evaluation.qualityReport,
      renderArtifactIds: ["audio", "midi"],
    },
  };
  assert.equal(hasCompleteQualityEvidence(falselyClaimedMidi), false);
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

test("diversity-rejected candidates are neither ranked nor selectable", () => {
  const evaluation = {
    status: "evaluated", providerScore: 1, renderArtifactIds: ["audio"],
    artifacts: [
      { id: "audio", type: "AUDIO_TRACK", label: "Audio", url: "export-object://audio" },
      { id: "quality", type: "QUALITY_REPORT", label: "Quality", url: "export-object://quality" },
    ],
    qualityReport: {
      score: 1,
      checks: { silence: 1, clipping: 1, notePlayability: 1, timing: 1, sectionCoverage: 1, lineage: 1 },
      weights: { silence: .15, clipping: .15, notePlayability: .2, timing: .15, sectionCoverage: .15, lineage: .2 },
      strengths: [], weaknesses: [], warnings: [], evaluatedAt: "2026-08-30T00:00:00.000Z",
      renderArtifactIds: ["audio"], lineageComplete: true,
    },
    error: null,
    diversity: { rejected: true },
  };
  assert.equal(rankEvaluatedCandidates([{ score: 1, evaluation }])[0].rank, null);
  assert.equal(isSelectableCandidate({
    status: "diversity_rejected", evaluation, trackModels: [], evaluatedPlan: {}, evaluatedStyleSpec: {},
  }), false);
});

test("music critic reports every rubric dimension with typed unavailable evidence", () => {
  const songModel = {
    audio: { name: "test.wav", contentType: "audio/wav", size: 0, durationSeconds: 8, sampleRate: 1_000, channels: 1 },
    tempoMap: [{ time: 0, bpm: 120, confidence: 1 }],
    meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    keyMap: [{ time: 0, key: "C", confidence: 1 }],
    melody: [],
    chords: [],
    sections: [],
    energy: [],
    vocalEvidence: {
      status: "not_available",
      reason: "No verified vocal stem",
      provenance: null,
      sampleRate: null,
      channels: null,
      frameSizeSamples: null,
      thresholds: null,
      observedVoicedWindows: [],
      observedSilentWindows: [],
    },
  };
  const report = evaluateCandidateMusicalFit({
    songModel,
    plan: {
      ...plan,
      style: {
        genre: "orchestral", subgenre: "cinematic", era: "modern",
        tempoCharacter: "steady",
        rhythm: { swing: 0, syncopation: 0.2, subdivision: "eighth" },
        harmony: { complexity: 0.5, tension: 0.4, voicing: "open" },
        instrumentation: { preferredFamilies: ["keys"], avoid: [] },
        orchestration: { density: 0.5, registerSpread: 0.5, dynamics: "shaped" },
        production: { stereoWidth: 0.5, room: "hall", mixProfile: "balanced" },
        dynamics: { range: 0.5, accentStrength: 0.5 },
      },
    },
    tracks: [track],
    harmonyDecisions: [],
  });
  assert.deepEqual(Object.keys(report.dimensions), criticDimensionNames);
  assert.equal(report.dimensions.vocalFit.status, "unavailable");
  assert.equal(report.dimensions.vocalFit.score, null);
  assert.equal(report.dimensions.harmony.status, "unavailable");
  assert.ok(Number.isFinite(report.score));
  for (const result of Object.values(report.dimensions)) {
    assert.ok(result.evidence.length > 0);
    assert.equal(typeof result.explanation, "string");
  }
});

test("perceptual audio critic is deterministic, privacy-bounded, and localizes PCM defects", () => {
  const pcm = new Float32Array(4_000).fill(.2);
  for (let index = 1_000; index < 1_500; index++) pcm[index] = 1;
  const input = {
    pcm: new Float32Array(pcm.length * 2).map((_, index) => pcm[Math.floor(index / 2)]), sampleRate: 1_000, channels: 2, artifactId: "audio",
    artifactSha256: "a".repeat(64), renderedTracks: [
      { id: "solo", pcm: pcm.slice(), channels: 1, sampleRate: 1_000 }, { id: "support", pcm: pcm.slice(), channels: 1, sampleRate: 1_000 },
    ],
  };
  const first = evaluateRenderedPcm(input);
  const second = evaluateRenderedPcm(input);
  assert.deepEqual(first, second);
  assert.equal(first.status, "available");
  assert.equal(first.coverage.sufficient, true);
  assert.equal(first.dimensions.vocalFit.status, "unavailable");
  const clipping = first.dimensions.artifactsAndDistortion.findings[0];
  assert.deepEqual(
    { startSeconds: clipping.startSeconds, endSeconds: clipping.endSeconds, affectedTrackIds: clipping.affectedTrackIds },
    { startSeconds: 1, endSeconds: 1.5, affectedTrackIds: undefined },
  );
  assert.equal("pcm" in first.evidence, false);
  assert.equal(evaluateRenderedPcm({ ...input, pcm: null }).status, "unavailable");
  assert.equal(evaluateRenderedPcm({ ...input, pcm: new Float32Array(10) }).status, "insufficient");
  assert.equal(evaluateRenderedPcm({ ...input, artifactSha256: "not-a-hash" }).status, "failed");
  const providerOnly = evaluateRenderedPcm({ ...input, renderedTracks: [] });
  assert.equal(providerOnly.status, "available");
  assert.equal(providerOnly.coverage.sufficient, true);
  assert.equal(providerOnly.dimensions.masking.status, "unavailable");
  assert.equal(providerOnly.dimensions.balance.status, "unavailable");
  const validVocalEvidence = {
    status: "detected", reason: null, sampleRate: 1_000, channels: 1, frameSizeSamples: 500, thresholds: null,
    provenance: { sourceStemRole: "vocals", objectPath: "private/source.wav", provider: "test", contentChecksum: "b".repeat(64) },
    observedVoicedWindows: [{ start: 0, end: .5 }], observedSilentWindows: [],
  };
  const verifiedVocals = evaluateRenderedPcm({
    ...input,
    analyzedDurationSeconds: 4,
    vocalEvidence: validVocalEvidence,
  });
  assert.equal(verifiedVocals.status, "available");
  assert.equal(verifiedVocals.dimensions.vocalFit.status, "available");
  assert.equal(evaluateRenderedPcm({
    ...input, analyzedDurationSeconds: 4,
    vocalEvidence: { ...validVocalEvidence, provenance: { sourceStemRole: "", objectPath: "", provider: "" },
      observedVoicedWindows: [{ start: 0, end: 5 }], observedSilentWindows: [] },
  }).dimensions.vocalFit.status, "unavailable");
  assert.equal(evaluateRenderedPcm({
    ...input, analyzedDurationSeconds: 20,
    vocalEvidence: { ...validVocalEvidence, observedVoicedWindows: [{ start: 3.8, end: 5 }] },
  }).dimensions.vocalFit.status, "unavailable", "source duration cannot extend the rendered PCM");
  assert.equal(evaluateRenderedPcm({
    ...input,
    vocalEvidence: {
      ...validVocalEvidence,
      provenance: { ...validVocalEvidence.provenance, sourceStemRole: "drums" },
    },
  }).dimensions.vocalFit.status, "unavailable");
});

test("perceptual audio critic scans large multitrack PCM without boxed array copies", () => {
  const sampleRate = 8_000;
  const seconds = 30;
  const frames = sampleRate * seconds;
  const stereo = new Float32Array(frames * 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.sin(frame / 19) * .12;
    stereo[frame * 2] = sample;
    stereo[frame * 2 + 1] = sample * .9;
    left[frame] = sample;
    right[frame] = sample * .6;
  }
  const report = evaluateRenderedPcm({
    pcm: stereo,
    sampleRate,
    channels: 2,
    artifactId: "large-audio",
    artifactSha256: "c".repeat(64),
    renderedTracks: [
      { id: "left", pcm: left, channels: 1, sampleRate },
      { id: "right", pcm: right, channels: 1, sampleRate },
    ],
  });
  assert.equal(report.status, "available");
  assert.equal(report.dimensions.masking.status, "available");
  assert.equal(report.dimensions.balance.status, "available");
});

test("audio findings map seconds to canonical bounded repair scopes and reject fabrication", () => {
  const finding = {
    id: "pcm-finding", startSeconds: 3.1, endSeconds: 5.9, affectedTrackIds: ["piano-track"],
    confidence: .9, provenance: "rendered_pcm", recommendation: "Repair the second bar.",
  };
  const repaired = audioFindingToRepairFinding({
    finding,
    plan: { ...plan, sections: [{ ...plan.sections[0], startBar: 1, endBar: 2 }] },
    trackModels: [track],
    tempoMap: [{ time: 0, bpm: 60 }],
    meterMap: [{ bar: 1, meter: "6/8" }],
  });
  assert.deepEqual(
    { startBar: repaired.startBar, endBar: repaired.endBar, tracks: repaired.affectedTrackIds },
    { startBar: 2, endBar: 2, tracks: ["piano-track"] },
  );
  assert.throws(() => audioFindingToRepairFinding({
    finding: { ...finding, affectedTrackIds: ["fabricated"] },
    plan, trackModels: [track], tempoMap: [{ time: 0, bpm: 60 }], meterMap: [{ bar: 1, meter: "6/8" }],
  }));
});

test("a failed critic dimension fences quality evidence", () => {
  const evaluated = {
    status: "evaluated",
    providerScore: 1,
    renderArtifactIds: ["audio"],
    artifacts: [
      { id: "audio", type: "AUDIO_TRACK", label: "Audio", url: "export-object://audio" },
      { id: "quality", type: "QUALITY_REPORT", label: "Quality", url: "export-object://quality" },
    ],
    qualityReport: {
      score: 1,
      checks: { silence: 1, clipping: 1, notePlayability: 1, timing: 1, sectionCoverage: 1, lineage: 1 },
      weights: { silence: .15, clipping: .15, notePlayability: .2, timing: .15, sectionCoverage: .15, lineage: .2 },
      strengths: [], weaknesses: [], warnings: [], evaluatedAt: "2026-08-30T00:00:00.000Z",
      renderArtifactIds: ["audio"], lineageComplete: true,
    },
    musicCritic: musicCritic(0.9, {
      playability: {
        status: "failed", score: null,
        evidence: [{ source: "instrument_constraints", summary: "Malformed constraints", observations: {} }],
        explanation: "Malformed constraints",
      },
    }),
    error: null,
  };
  assert.equal(hasCompleteQualityEvidence(evaluated), false);
});

test("public candidate evidence hides internal diversity fingerprints and normalizes historical critics", () => {
  const evaluation = {
    status: "evaluated",
    providerScore: 0.8,
    renderArtifactIds: [],
    artifacts: [],
    qualityReport: null,
    error: null,
    diversity: {
      fingerprint: {
        activeTracks: ["secret-track"],
        densityEnergy: [{ density: 0.5, energy: 0.5 }],
        harmonySequence: ["secret-harmony"],
        trackRoleInstruments: ["secret-role"],
        noteShape: [1, 2, 3],
      },
      comparedToCandidateId: "baseline",
      distance: 0.1,
      threshold: 0.25,
      rejected: true,
      reason: "near_duplicate",
    },
  };
  const publicEvaluation = publicCandidateEvaluation(evaluation);
  assert.equal(publicEvaluation.musicCritic, null);
  assert.equal("fingerprint" in publicEvaluation.diversity, false);
  assert.equal(publicEvaluation.diversity.reason, "near_duplicate");
});

test("critic dimensions outrank provider preference and ties are stable by candidate id", () => {
  const makeCandidate = (id, criticScore, providerScore) => ({
    id,
    score: criticScore,
    evaluation: {
      status: "evaluated",
      providerScore,
      renderArtifactIds: [`audio-${id}`],
      artifacts: [
        { id: `audio-${id}`, type: "AUDIO_TRACK", label: "Audio", url: `export-object://audio-${id}` },
        { id: `quality-${id}`, type: "QUALITY_REPORT", label: "Quality", url: `export-object://quality-${id}` },
      ],
      qualityReport: {
        score: 1,
        checks: { silence: 1, clipping: 1, notePlayability: 1, timing: 1, sectionCoverage: 1, lineage: 1 },
        weights: { silence: .15, clipping: .15, notePlayability: .2, timing: .15, sectionCoverage: .15, lineage: .2 },
        strengths: [], weaknesses: [], warnings: [], evaluatedAt: "2026-08-30T00:00:00.000Z",
        renderArtifactIds: [`audio-${id}`], lineageComplete: true,
      },
      musicCritic: musicCritic(criticScore),
      error: null,
    },
  });
  const highProvider = makeCandidate("z-provider", 0.7, 1);
  const musicalFit = makeCandidate("m-fit", 0.9, 0.1);
  const tieA = makeCandidate("a-tie", 0.7, 1);
  assert.deepEqual(
    rankEvaluatedCandidates([highProvider, musicalFit, tieA]).map(({ id }) => id),
    ["m-fit", "a-tie", "z-provider"],
  );
  assert.deepEqual(
    rankEvaluatedCandidates([tieA, highProvider, musicalFit]).map(({ id }) => id),
    ["m-fit", "a-tie", "z-provider"],
  );
});

test("canonical diversity fingerprints use deterministic strategies, seeds, and the weighted duplicate threshold", () => {
  assert.deepEqual(
    Array.from({ length: 6 }, (_, index) => strategyForCandidate(index)),
    ["sparse", "balanced", "rhythmic", "harmonic", "orchestral", "sparse"],
  );
  assert.deepEqual([0, 1, 2].map((index) => seedForCandidate(2_147_483_646, index)),
    [2_147_483_646, 0, 1]);
  const canonicalPlan = {
    sections: [{
      section: "verse", startBar: 1, endBar: 4, energy: .5, density: .4,
      tracks: { piano: "main_harmony" }, activeTracks: ["piano"], operations: [],
    }],
  };
  const canonicalTracks = [{
    id: "piano", role: "harmony", instrument: "piano",
    notes: [{ start: 0, duration: 1, pitch: 60 }],
  }];
  const baseline = fingerprintCandidate(canonicalPlan, canonicalTracks);
  assert.equal(candidateDistance(baseline, fingerprintCandidate(canonicalPlan, canonicalTracks)), 0);
  assert.equal(
    diversityEvidence(baseline, [{ id: "baseline", fingerprint: baseline }]).rejected,
    true,
  );
  const distinct = fingerprintCandidate({
    ...canonicalPlan,
    sections: [{
      ...canonicalPlan.sections[0], energy: 1, density: 1,
      tracks: { drums: "rhythm" }, activeTracks: ["drums"],
    }],
  }, [{ id: "drums", role: "rhythm", instrument: "drums", notes: [] }]);
  assert.equal(
    diversityEvidence(distinct, [{ id: "baseline", fingerprint: baseline }]).rejected,
    false,
  );
});
