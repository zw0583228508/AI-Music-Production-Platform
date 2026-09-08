import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundlePath = `/tmp/music-production-path-verification-${process.pid}.mjs`;
await build({
  stdin: {
    contents: `
      export { buildProductionPathReleaseReport } from "./src/lib/productionPathVerification";
      export { applyMixMasterControls, encodeWav } from "./src/lib/exportEngine";
      export { renderArrangementExport } from "./src/lib/exportEngine";
      export { deriveVocalPhrasing } from "./src/lib/audioSignal";
      export { evaluateCandidateMusicalFit } from "./src/lib/candidateQuality";
      export { applyBoundedRepair } from "./src/lib/candidateRepair";
      export {
        buildArrangementBrain, buildTrackModels, createArrangementPlan,
        createStyleSpec, getInstrumentDefinition
      } from "./src/lib/musicEngines";
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "production-path-verification-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
  external: ["pg-native", "@google-cloud/*", "@google/*"],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});
const {
  applyMixMasterControls,
  applyBoundedRepair,
  buildArrangementBrain,
  buildTrackModels,
  buildProductionPathReleaseReport,
  createArrangementPlan,
  createStyleSpec,
  deriveVocalPhrasing,
  encodeWav,
  evaluateCandidateMusicalFit,
  getInstrumentDefinition,
  renderArrangementExport,
} = await import(pathToFileURL(bundlePath).href);
after(() => unlink(bundlePath).catch(() => undefined));

const hash = (value) => createHash("sha256").update(value).digest("hex");
const hashJson = (value) => hash(JSON.stringify(value));

const fixtureSongModel = {
  contractVersion: "1.0",
  validation: { status: "accepted", issues: [] },
  fusion: { selectedProvider: "VERIFIED_FIXTURE", confidence: 1, decisions: [] },
  audio: {
    name: "representative.wav", contentType: "audio/wav", size: 1,
    durationSeconds: 16, sampleRate: 44_100, channels: 2,
    proxyObjectPath: null, proxyContentType: null,
    analysisStartSeconds: 0, analysisDurationSeconds: 16, analysisCoverage: "full",
  },
  analysisStartSeconds: 0, analysisDurationSeconds: 16, analysisCoverage: 1,
  beats: [], bars: [], dynamics: [0.4, 0.8], waveform: [0.2, 0.7],
  stems: [], sourceStems: [], lyrics: [], confidenceByField: {},
  providerProvenance: [{
    capability: "analysis", provider: "VERIFIED_FIXTURE", version: "1", status: "ready",
  }],
  tempoMap: [{ time: 0, bpm: 120, confidence: 1 }],
  meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
  keyMap: [{ time: 0, key: "C major", confidence: 1 }],
  melody: [{ start: 0, end: 1, pitch: 64, velocity: 90, confidence: 0.9, source: "fixture" }],
  chords: [{ start: 0, end: 8, symbol: "C", roman: "I", quality: "major", confidence: 0.9 }],
  sections: [
    { name: "Verse", startBar: 1, endBar: 2, energy: 0.45 },
    { name: "Chorus", startBar: 3, endBar: 4, energy: 0.85 },
  ],
  energy: [0.45, 0.85],
  vocalEvidence: {
    status: "detected", reason: null, provenance: null, sampleRate: 8_000,
    channels: 1, frameSizeSamples: 160,
    thresholds: { rms: 0.01, peak: 0.02, activitySample: 0.01, activityRatio: 0.1 },
    observedVoicedWindows: [{ start: 0.5, end: 2 }, { start: 2.3, end: 4 }],
    observedSilentWindows: [{ start: 2, end: 2.3 }],
  },
};
const fixtureTracks = [
  { id: "piano", name: "Piano", role: "harmony", instrument: "piano" },
  { id: "bass", name: "Bass", role: "bass", instrument: "bass" },
  { id: "drums", name: "Drums", role: "rhythm", instrument: "drums" },
];
const fixtureTimelineSha256 = hashJson({
  tempoMap: fixtureSongModel.tempoMap,
  meterMap: fixtureSongModel.meterMap,
  sections: fixtureSongModel.sections,
});
const fixturePhrasing = deriveVocalPhrasing({
  status: "detected",
  observedVoicedWindows: fixtureSongModel.vocalEvidence.observedVoicedWindows,
  observedSilentWindows: fixtureSongModel.vocalEvidence.observedSilentWindows,
});
const fixtureStyle = createStyleSpec("cinematic pop", {
  density: 0.65, harmonyComplexity: 6, energy: 0.7, orchestraSize: 0.8,
  rhythmIntensity: 0.7,
});
const fixtureBrain = buildArrangementBrain({
  songModel: fixtureSongModel,
  controls: { energy: 0.7, density: 0.65, orchestraSize: 0.8 },
});
const fixturePlan = createArrangementPlan({
  arrangementId: "arrangement-artifact", version: 1, songModel: fixtureSongModel,
  style: fixtureStyle, tracks: fixtureTracks,
  parameters: { songModelVersion: 1, energy: 0.7, density: 0.65, orchestraSize: 0.8 },
  parentIds: ["song-model-artifact"], arrangementBrain: fixtureBrain,
});
const fixtureTrackModels = buildTrackModels({
  songModel: fixtureSongModel, plan: fixturePlan, tracks: fixtureTracks,
  style: fixtureStyle, seed: 4242,
});
const fixtureCritique = evaluateCandidateMusicalFit({
  songModel: fixtureSongModel, plan: fixturePlan, tracks: fixtureTrackModels,
  harmonyDecisions: [],
});
const fixtureRepair = applyBoundedRepair({
  snapshot: {
    sourceCandidateId: "candidate-artifact", sourceCandidateLabel: "Candidate",
    sourceScore: fixtureCritique.score, seed: 4242, maxAttempts: 2,
    finding: {
      id: "finding-1", affectedSections: ["verse"], startBar: 1, endBar: 2,
      affectedTrackIds: ["piano"], musicalReason: "reduce_density",
    },
    plan: fixturePlan, trackModels: fixtureTrackModels,
  },
  proposedPlan: fixturePlan,
  proposedTrackModels: fixtureTrackModels,
  timeBounds: { start: 0, end: 4 },
});
const actualStageEvidence = {
  analysis: { inputSha256: hash("representative-source"), outputSha256: hashJson(fixtureSongModel), checks: ["canonical-analysis"] },
  phrase_intelligence: { inputSha256: hashJson(fixtureSongModel.vocalEvidence), outputSha256: hashJson(fixturePhrasing), checks: ["verified-vocal-phrases"] },
  hierarchical_planning: { inputSha256: hashJson(fixtureBrain), outputSha256: hashJson(fixturePlan), checks: ["hierarchy-applied"] },
  candidate_generation: { inputSha256: hashJson(fixturePlan), outputSha256: hashJson(fixtureTrackModels), checks: ["deterministic-seed"] },
  critique: { inputSha256: hashJson(fixtureTrackModels), outputSha256: hashJson(fixtureCritique), checks: ["music-critic"] },
  bounded_repair: { inputSha256: hashJson(fixtureCritique), outputSha256: hashJson(fixtureRepair), checks: ["outside-scope-preserved"] },
  performance: { inputSha256: hashJson(fixturePlan), outputSha256: hashJson(fixtureTrackModels.map((track) => ({ notes: track.notes, cc: track.cc, articulations: track.articulations }))), checks: ["expressive-performance"] },
};

function representativeEvidence(overrides = {}) {
  const lineage = [
    "source-artifact", "song-model-artifact", "plan-artifact",
    "candidate-artifact", "repair-artifact", "performance-artifact",
    "mix-artifact", "master-artifact", "export-artifact",
  ];
  const capabilities = [
    "analysis", "phrase_intelligence", "hierarchical_planning", "candidate_generation",
    "critique", "bounded_repair", "performance", "mix", "master", "export",
  ].map((capability) => {
    const evidence = overrides.stageEvidence?.[capability] ?? actualStageEvidence[capability] ?? {
      inputSha256: hash(`${capability}:input`),
      outputSha256: hash(`${capability}:output`),
      checks: [`${capability}-verified`],
    };
    return {
      capability,
      status: overrides.capabilityStatuses?.[capability] ?? "passed",
      evidence,
      artifactIds: lineage,
      provenance: {
        provider: capability === "analysis"
          ? "RETAINED_SONG_MODEL_FIXTURE"
          : "LOCAL_DETERMINISTIC_ENGINE",
        modelVersion: "1",
        runtimeSha256: hash("node-local-production-path-runtime-v1"),
        runtimeIdentity: "node-local-production-path",
        licenseReference: "project-runtime-license",
        decisionId: "decision-accepted",
      },
    };
  });
  capabilities.push({
    capability: "lyrics_alignment",
    status: "abstained",
    evidence: {
      inputSha256: hash("lyrics_alignment:input"),
      outputSha256: hash("lyrics_alignment:abstained"),
      checks: ["honest-abstention"],
    },
    artifactIds: ["song-model-artifact"],
    provenance: {
      provider: "VERIFIED_FIXTURE",
      modelVersion: "1",
      runtimeSha256: hash("node-local-production-path-runtime-v1"),
      runtimeIdentity: "fixture-runtime",
      licenseReference: "commercial-fixture-license",
      decisionId: "decision-accepted",
    },
  });
  const stageOutputAggregateSha256 = hash(JSON.stringify(
    capabilities
      .map((item) => [item.capability, item.evidence.outputSha256])
      .sort(([left], [right]) => left.localeCompare(right)),
  ));
  const masterSha256 = overrides.audio?.masterSha256 ?? "e".repeat(64);
  const exportSha256 = capabilities.find(
    (item) => item.capability === "export",
  ).evidence.outputSha256;
  return {
    fixtureId: "representative-song-v1",
    canonicalTimelineSha256: fixtureTimelineSha256,
    seed: 4242,
    repairScopeSha256: "c".repeat(64),
    lineageArtifactIds: lineage,
    producerDecisionIds: ["decision-accepted"],
    retry: {
      seed: 4242,
      repairScopeSha256: "c".repeat(64),
      canonicalTimelineSha256:
        overrides.retryEvidence?.canonicalTimelineSha256 ?? fixtureTimelineSha256,
      stageOutputAggregateSha256:
        overrides.retryEvidence?.stageOutputAggregateSha256 ?? stageOutputAggregateSha256,
      masterSha256: overrides.retryEvidence?.masterSha256 ?? masterSha256,
      exportSha256: overrides.retryEvidence?.exportSha256 ?? exportSha256,
      lineageArtifactIds: [...lineage],
      producerDecisionIds: ["decision-accepted"],
    },
    capabilities,
    ...overrides,
    stageEvidence: undefined,
    capabilityStatuses: undefined,
    retryEvidence: undefined,
  };
}

function wavSamples(wav) {
  const samples = new Float32Array((wav.length - 44) / 2);
  for (let offset = 44, index = 0; offset + 1 < wav.length; offset += 2, index += 1) {
    samples[index] = wav.readInt16LE(offset) / 32768;
  }
  return samples;
}

test("representative production path stays coherent and blocks preview-only rendering", async () => {
  const controls = (levelDb) => ({
    tracks: Object.fromEntries(fixtureTracks.map((track) => [
      track.id,
      {
        levelDb: track.id === "piano" ? levelDb : -6,
        pan: track.id === "piano" ? (levelDb <= -20 ? -0.9 : 0.9) : 0,
        bus: "MUSIC", sendDb: -80,
        processing: {
          highPassHz: levelDb <= -20 ? 20 : 180,
          compressorRatio: levelDb <= -20 ? 1 : 8,
          saturation: levelDb <= -20 ? 0 : 0.8,
        },
      },
    ])),
    master: {
      targetLufs: levelDb <= -20 ? -30 : -6,
      truePeakDbtp: levelDb <= -20 ? -6 : -0.8,
      processing: {
        limiter: levelDb > -20,
        stereoWidth: levelDb <= -20 ? 0.5 : 1.5,
      },
    },
  });
  const exportInput = {
    projectName: "Representative Song", bpm: 120, key: "C major", meter: "4/4",
    arrangementName: "Verified Arrangement", arrangementVersion: 1,
    masterProfile: "STREAMING", energy: 0.7, density: 0.65, harmonyComplexity: 6,
    sections: fixtureSongModel.sections.map((section) => ({
      name: section.name, energy: section.energy, density: section.energy,
      tracks: fixtureTracks.map((track) => track.name),
    })),
    tracks: fixtureTracks.map((track) => ({
      id: track.id, name: track.name, role: track.role,
      volume: -6, muted: false, solo: false,
    })),
    songModel: fixtureSongModel, plan: fixturePlan,
    trackModels: fixtureRepair.trackModels, styleSpec: fixtureStyle,
    generationProvider: "VERIFIED_FIXTURE", seed: 4242,
    parentIds: ["candidate-artifact", "repair-artifact"],
    planArtifactId: "plan-artifact", planParentIds: ["song-model-artifact"],
    trackModelArtifactIds: Object.fromEntries(
      fixtureTracks.map((track) => [track.id, "performance-artifact"]),
    ),
    includeStems: true, includeMidi: true,
  };
  const baselineFiles = await renderArrangementExport({
    ...exportInput,
    mixMasterControls: controls(-30),
  });
  const exportedFiles = await renderArrangementExport({
    ...exportInput,
    mixMasterControls: controls(0),
  });
  const baselineMaster = baselineFiles.find((file) => file.type === "MASTER");
  const variantMaster = exportedFiles.find((file) => file.type === "MASTER");
  const variantMix = exportedFiles.find((file) => file.type === "PREMASTER");
  assert.ok(baselineMaster && variantMaster && variantMix);
  const baselineSamples = wavSamples(baselineMaster.data);
  const variantSamples = wavSamples(variantMaster.data);
  let peak = 0;
  let active = 0;
  let deltaSquareSum = 0;
  for (const value of variantSamples) {
    peak = Math.max(peak, Math.abs(value));
    if (Math.abs(value) > 0.0005) active += 1;
  }
  for (let index = 0; index < variantSamples.length; index += 1) {
    const delta = variantSamples[index] - baselineSamples[index];
    deltaSquareSum += delta * delta;
  }
  const productionReady = exportedFiles
    .filter((file) => file.type === "STEM")
    .every((file) => file.rendererEvidence?.productionReady === true);
  assert.equal(productionReady, false, "unattested local fallback must remain preview-only");
  const exportedEvidence = exportedFiles
    .filter((file) => file.type !== "METADATA")
    .map((file) => ({
      name: file.name,
      type: file.type,
      sha256: hash(file.data),
    }));
  const stageEvidence = {
    ...actualStageEvidence,
    mix: {
      inputSha256: hashJson(fixtureRepair.trackModels),
      outputSha256: hash(variantMix.data),
      checks: ["non-silent-mix"],
    },
    master: {
      inputSha256: hash(variantMix.data),
      outputSha256: hash(variantMaster.data),
      checks: ["control-sensitive-master"],
    },
    export: {
      inputSha256: hashJson(fixtureRepair.plan),
      outputSha256: hashJson(exportedEvidence),
      checks: ["wav-midi-export"],
    },
  };
  // Execute the deterministic production path a second time; retry evidence is
  // derived from this independent run rather than copied from the first.
  const retryBrain = buildArrangementBrain({
    songModel: fixtureSongModel,
    controls: { energy: 0.7, density: 0.65, orchestraSize: 0.8 },
  });
  const retryPlan = createArrangementPlan({
    arrangementId: "arrangement-artifact", version: 1,
    songModel: fixtureSongModel, style: fixtureStyle, tracks: fixtureTracks,
    parameters: {
      songModelVersion: 1, energy: 0.7, density: 0.65, orchestraSize: 0.8,
    },
    parentIds: ["song-model-artifact"], arrangementBrain: retryBrain,
  });
  const retryTrackModels = buildTrackModels({
    songModel: fixtureSongModel, plan: retryPlan, tracks: fixtureTracks,
    style: fixtureStyle, seed: 4242,
  });
  const retryCritique = evaluateCandidateMusicalFit({
    songModel: fixtureSongModel, plan: retryPlan,
    tracks: retryTrackModels, harmonyDecisions: [],
  });
  const retryRepair = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate-artifact", sourceCandidateLabel: "Candidate",
      sourceScore: retryCritique.score, seed: 4242, maxAttempts: 2,
      finding: {
        id: "finding-1", affectedSections: ["verse"], startBar: 1, endBar: 2,
        affectedTrackIds: ["piano"], musicalReason: "reduce_density",
      },
      plan: retryPlan, trackModels: retryTrackModels,
    },
    proposedPlan: retryPlan, proposedTrackModels: retryTrackModels,
    timeBounds: { start: 0, end: 4 },
  });
  const retryFiles = await renderArrangementExport({
    ...exportInput,
    plan: retryRepair.plan,
    trackModels: retryRepair.trackModels,
    mixMasterControls: controls(0),
  });
  const retryMaster = retryFiles.find((file) => file.type === "MASTER");
  const retryMix = retryFiles.find((file) => file.type === "PREMASTER");
  assert.ok(retryMaster && retryMix);
  const retryExportEvidence = retryFiles
    .filter((file) => file.type !== "METADATA")
    .map((file) => ({ name: file.name, type: file.type, sha256: hash(file.data) }));
  const retryStageEvidence = {
    analysis: actualStageEvidence.analysis,
    phrase_intelligence: actualStageEvidence.phrase_intelligence,
    hierarchical_planning: {
      inputSha256: hashJson(retryBrain), outputSha256: hashJson(retryPlan),
      checks: ["hierarchy-applied"],
    },
    candidate_generation: {
      inputSha256: hashJson(retryPlan), outputSha256: hashJson(retryTrackModels),
      checks: ["deterministic-seed"],
    },
    critique: {
      inputSha256: hashJson(retryTrackModels), outputSha256: hashJson(retryCritique),
      checks: ["music-critic"],
    },
    bounded_repair: {
      inputSha256: hashJson(retryCritique), outputSha256: hashJson(retryRepair),
      checks: ["outside-scope-preserved"],
    },
    performance: {
      inputSha256: hashJson(retryPlan),
      outputSha256: hashJson(retryTrackModels.map((track) => ({
        notes: track.notes, cc: track.cc, articulations: track.articulations,
      }))),
      checks: ["expressive-performance"],
    },
    mix: {
      inputSha256: hashJson(retryRepair.trackModels),
      outputSha256: hash(retryMix.data), checks: ["non-silent-mix"],
    },
    master: {
      inputSha256: hash(retryMix.data),
      outputSha256: hash(retryMaster.data), checks: ["control-sensitive-master"],
    },
    export: {
      inputSha256: hashJson(retryRepair.plan),
      outputSha256: hashJson(retryExportEvidence), checks: ["wav-midi-export"],
    },
    lyrics_alignment: {
      inputSha256: hash("lyrics_alignment:input"),
      outputSha256: hash("lyrics_alignment:abstained"),
      checks: ["honest-abstention"],
    },
  };
  const retryStageOutputAggregateSha256 = hash(JSON.stringify(
    Object.entries(retryStageEvidence)
      .map(([capability, evidence]) => [capability, evidence.outputSha256])
      .sort(([left], [right]) => left.localeCompare(right)),
  ));
  const report = buildProductionPathReleaseReport(representativeEvidence({
    stageEvidence,
    retryEvidence: {
      canonicalTimelineSha256: fixtureTimelineSha256,
      stageOutputAggregateSha256: retryStageOutputAggregateSha256,
      masterSha256: hash(retryMaster.data),
      exportSha256: retryStageEvidence.export.outputSha256,
    },
    capabilityStatuses: productionReady ? {} : { performance: "blocked", export: "blocked" },
    audio: {
      sourceSha256: hash("representative-source"),
      masterSha256: hash(variantMaster.data),
      peak,
      activeFrameRatio: active / variantSamples.length,
      controlBaselineSha256: hash(baselineMaster.data),
      controlVariantSha256: hash(variantMaster.data),
      controlDeltaRms: Math.sqrt(deltaSquareSum / variantSamples.length),
      privateFingerprint: "MUST-NOT-LEAK",
      providerToken: "MUST-NOT-LEAK",
      internalScores: { critic: 0.91 },
    },
    privateEvidence: "MUST-NOT-LEAK",
  }));

  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.summary, { passed: 8, abstained: 1, failed: 0, blocked: 2 });
  assert.ok(report.blockers.includes("Required capability performance is blocked"));
  assert.ok(report.blockers.includes("Required capability export is blocked"));
  assert.ok(
    Object.values(report.invariants).every(Boolean),
    JSON.stringify({
      invariants: report.invariants,
      baseline: hash(baselineMaster.data),
      variant: hash(variantMaster.data),
      delta: Math.sqrt(deltaSquareSum / variantSamples.length),
    }),
  );
  assert.equal(report.verificationId.length, 64);
  assert.equal(JSON.stringify(report).includes("MUST-NOT-LEAK"), false);
  assert.equal(JSON.stringify(report).includes("internalScores"), false);
  const reportPath = new URL("../reports/production-path-release-report.json", import.meta.url);
  if (process.env.MUSIC_WRITE_PRODUCTION_PATH_REPORT === "1") {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } else {
    assert.deepEqual(
      JSON.parse(await readFile(reportPath, "utf8")),
      report,
      "checked-in release report is stale; run generate:production-path-report",
    );
  }
});

test("required unavailable, failed, and blocked stages prevent release claims", () => {
  for (const status of ["abstained", "failed", "blocked"]) {
    const input = representativeEvidence();
    input.audio = {
      sourceSha256: "d".repeat(64),
      masterSha256: "e".repeat(64),
      peak: 0.5,
      activeFrameRatio: 0.8,
      controlBaselineSha256: "f".repeat(64),
      controlVariantSha256: "0".repeat(64),
      controlDeltaRms: 0.2,
    };
    input.capabilities.find((item) => item.capability === "performance").status = status;
    const report = buildProductionPathReleaseReport(input);
    assert.equal(report.releaseReady, false);
    assert.ok(report.blockers.includes(`Required capability performance is ${status}`));
  }
});

test("optional capabilities may abstain but cannot fail or remain blocked", () => {
  const audio = {
    sourceSha256: "1".repeat(64), masterSha256: "2".repeat(64),
    peak: 0.5, activeFrameRatio: 0.8,
    controlBaselineSha256: "3".repeat(64), controlVariantSha256: "4".repeat(64),
    controlDeltaRms: 0.2,
  };
  for (const status of ["failed", "blocked"]) {
    const input = representativeEvidence({ audio });
    input.capabilities.find((item) => item.capability === "lyrics_alignment").status = status;
    const report = buildProductionPathReleaseReport(input);
    assert.equal(report.releaseReady, false);
    assert.ok(report.blockers.includes(`Optional capability lyrics_alignment is ${status}`));
  }
});

test("retry or worker recovery drift in seed, repair scope, lineage, or decisions blocks release", () => {
  const cases = [
    (input) => { input.retry.seed += 1; },
    (input) => { input.retry.repairScopeSha256 = "9".repeat(64); },
    (input) => { input.retry.lineageArtifactIds.pop(); },
    (input) => { input.retry.producerDecisionIds = []; },
  ];
  for (const mutate of cases) {
    const input = representativeEvidence();
    input.audio = {
      sourceSha256: "1".repeat(64),
      masterSha256: "2".repeat(64),
      peak: 0.5,
      activeFrameRatio: 0.8,
      controlBaselineSha256: "3".repeat(64),
      controlVariantSha256: "4".repeat(64),
      controlDeltaRms: 0.2,
    };
    mutate(input);
    assert.equal(buildProductionPathReleaseReport(input).releaseReady, false);
  }
});

test("retry output drift blocks release even when seed, scope, lineage, and decisions match", () => {
  const audio = {
    sourceSha256: "1".repeat(64), masterSha256: "2".repeat(64),
    peak: 0.5, activeFrameRatio: 0.8,
    controlBaselineSha256: "3".repeat(64), controlVariantSha256: "4".repeat(64),
    controlDeltaRms: 0.2,
  };
  for (const mutate of [
    (input) => { input.retry.canonicalTimelineSha256 = "5".repeat(64); },
    (input) => { input.retry.stageOutputAggregateSha256 = "6".repeat(64); },
    (input) => { input.retry.masterSha256 = "7".repeat(64); },
    (input) => { input.retry.exportSha256 = "8".repeat(64); },
  ]) {
    const input = representativeEvidence({ audio });
    mutate(input);
    const report = buildProductionPathReleaseReport(input);
    assert.equal(report.invariants.deterministicRecovery, false);
    assert.equal(report.releaseReady, false);
    assert.ok(report.blockers.includes("Invariant failed: deterministicRecovery"));
  }
});

test("audio measurements cannot be substituted from a different master artifact", () => {
  const audio = {
    sourceSha256: "1".repeat(64), masterSha256: "2".repeat(64),
    peak: 0.5, activeFrameRatio: 0.8,
    controlBaselineSha256: "3".repeat(64), controlVariantSha256: "2".repeat(64),
    controlDeltaRms: 0.2,
  };
  const input = representativeEvidence({ audio });
  input.retry.masterSha256 = audio.masterSha256;
  input.capabilities.find(
    (item) => item.capability === "master",
  ).evidence.outputSha256 = "4".repeat(64);
  const report = buildProductionPathReleaseReport(input);
  assert.equal(report.invariants.masterEvidenceBound, false);
  assert.equal(report.releaseReady, false);
  assert.ok(report.blockers.includes("Invariant failed: masterEvidenceBound"));
});

test("the gate fails closed for missing stages, missing provenance, copied audio, silence, and inaudible controls", () => {
  const validAudio = {
    sourceSha256: "1".repeat(64),
    masterSha256: "2".repeat(64),
    peak: 0.5,
    activeFrameRatio: 0.8,
    controlBaselineSha256: "3".repeat(64),
    controlVariantSha256: "4".repeat(64),
    controlDeltaRms: 0.2,
  };
  const missing = representativeEvidence({ audio: validAudio });
  missing.capabilities = missing.capabilities.filter((item) => item.capability !== "analysis");
  assert.throws(() => buildProductionPathReleaseReport(missing), /Missing required/);

  const noProvenance = representativeEvidence({ audio: validAudio });
  noProvenance.capabilities[0].provenance.provider = "";
  assert.throws(() => buildProductionPathReleaseReport(noProvenance), /unsafe identifier/);

  for (const audio of [
    { ...validAudio, masterSha256: validAudio.sourceSha256 },
    { ...validAudio, peak: 0, activeFrameRatio: 0 },
    { ...validAudio, controlDeltaRms: 0 },
  ]) {
    assert.equal(
      buildProductionPathReleaseReport(representativeEvidence({ audio })).releaseReady,
      false,
    );
  }
});

test("allow-listed fields reject URLs, paths, error text, and credential-shaped values", () => {
  const audio = {
    sourceSha256: "1".repeat(64), masterSha256: "2".repeat(64),
    peak: 0.5, activeFrameRatio: 0.8,
    controlBaselineSha256: "3".repeat(64), controlVariantSha256: "4".repeat(64),
    controlDeltaRms: 0.2,
  };
  for (const unsafe of [
    "https://private.example/object",
    "/private/object/path",
    "Bearer secret-token",
    "provider failed: token=secret",
    "sk-proj-credentialshapedvalue",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signaturebytes",
  ]) {
    const input = representativeEvidence({ audio });
    input.capabilities[0].provenance.runtimeIdentity = unsafe;
    assert.throws(() => buildProductionPathReleaseReport(input), /unsafe identifier/);
  }
  for (const field of ["fixtureId", "lineageArtifactIds", "producerDecisionIds"]) {
    const input = representativeEvidence({ audio });
    if (field === "fixtureId") input.fixtureId = "sk-proj-privatecredential";
    if (field === "lineageArtifactIds") input.lineageArtifactIds[0] = "ghp_privatecredential";
    if (field === "producerDecisionIds") input.producerDecisionIds[0] = "token-private";
    assert.throws(() => buildProductionPathReleaseReport(input), /safe, non-empty lineage/);
  }
});

test("invalid statuses, seeds, and audio ratios are rejected", () => {
  const audio = {
    sourceSha256: "1".repeat(64), masterSha256: "2".repeat(64),
    peak: 0.5, activeFrameRatio: 0.8,
    controlBaselineSha256: "3".repeat(64), controlVariantSha256: "4".repeat(64),
    controlDeltaRms: 0.2,
  };
  const invalidStatus = representativeEvidence({ audio });
  invalidStatus.capabilities[0].status = "unknown";
  assert.throws(() => buildProductionPathReleaseReport(invalidStatus), /invalid capability status/);
  assert.throws(
    () => buildProductionPathReleaseReport(representativeEvidence({ audio, seed: Infinity })),
    /safe, non-empty lineage/,
  );
  assert.throws(
    () => buildProductionPathReleaseReport(representativeEvidence({
      audio: { ...audio, activeFrameRatio: 1.1 },
    })),
    /safe, non-empty lineage/,
  );
});

test("capability evidence cannot escape retained lineage or producer decisions", () => {
  const audio = {
    sourceSha256: "1".repeat(64), masterSha256: "2".repeat(64),
    peak: 0.5, activeFrameRatio: 0.8,
    controlBaselineSha256: "3".repeat(64), controlVariantSha256: "4".repeat(64),
    controlDeltaRms: 0.2,
  };
  const unboundArtifact = representativeEvidence({ audio });
  unboundArtifact.capabilities[0].artifactIds = ["forged-artifact"];
  assert.throws(
    () => buildProductionPathReleaseReport(unboundArtifact),
    /outside release lineage/,
  );
  const unboundDecision = representativeEvidence({ audio });
  unboundDecision.capabilities[0].provenance.decisionId = "unretained-decision";
  assert.throws(
    () => buildProductionPathReleaseReport(unboundDecision),
    /unretained producer decision/,
  );
});