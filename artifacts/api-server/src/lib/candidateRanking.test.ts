import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  CandidateEvaluation,
  CandidateEvaluationStatus,
} from "@workspace/db";
import { ListGenerationCandidatesResponse } from "@workspace/api-zod";
import { hasCompleteQualityEvidence, publicCandidateEvaluation } from "./candidateRanking";

const supportedStatuses = {
  plan_received: true,
  rendering: true,
  render_succeeded: true,
  analyzing: true,
  evaluated: true,
  render_failed: true,
  analysis_failed: true,
  diversity_rejected: true,
  repair_not_improved: true,
  repair_scope_violated: true,
} satisfies Record<CandidateEvaluationStatus, true>;

const musicCritic: CandidateEvaluation["musicCritic"] = {
  version: "music-critic-v1",
  score: 0.84,
  coverage: {
    availableDimensions: 0,
    totalDimensions: 8,
    sparse: true,
  },
  dimensions: {
    vocalFit: { status: "unavailable", score: null, evidence: [], explanation: "safe-vocal-summary", findings: [] },
    harmony: { status: "unavailable", score: null, evidence: [], explanation: "safe-harmony-summary", findings: [] },
    development: { status: "unavailable", score: null, evidence: [], explanation: "safe-development-summary", findings: [] },
    contrastAndTransitions: { status: "unavailable", score: null, evidence: [], explanation: "safe-transition-summary", findings: [] },
    registerCollisions: { status: "unavailable", score: null, evidence: [], explanation: "safe-register-summary", findings: [] },
    playability: { status: "unavailable", score: null, evidence: [], explanation: "safe-playability-summary", findings: [] },
    repetition: { status: "unavailable", score: null, evidence: [], explanation: "safe-repetition-summary", findings: [] },
    styleAndControlAdherence: { status: "unavailable", score: null, evidence: [], explanation: "safe-style-summary", findings: [] },
  },
};

const privateFingerprintSentinels = [
  "private-active-track",
  "private-harmony",
  "private-track-role",
  987654321,
] as const;
const futurePrivateSentinel = "future-private-evaluation-sentinel";

for (const status of Object.keys(supportedStatuses) as CandidateEvaluationStatus[]) {
  test(`public candidate evaluation sanitizes ${status} status`, () => {
    const evaluation: CandidateEvaluation & {
      futureInternalEvaluation: { detail: string };
    } = {
      status,
      providerScore: 0.77,
      futureInternalEvaluation: { detail: futurePrivateSentinel },
      renderArtifactIds: [],
      artifacts: [],
      qualityReport: null,
      musicCritic,
      audioCritic: null,
      error: null,
      diversity: {
        fingerprint: {
          activeTracks: [privateFingerprintSentinels[0]],
          densityEnergy: [{ density: privateFingerprintSentinels[3], energy: 0.25 }],
          harmonySequence: [privateFingerprintSentinels[1]],
          trackRoleInstruments: [privateFingerprintSentinels[2]],
          noteShape: [privateFingerprintSentinels[3]],
        },
        comparedToCandidateId: "producer-safe-baseline",
        distance: 0.17,
        threshold: 0.25,
        rejected: status === "diversity_rejected",
        reason: status === "diversity_rejected"
          ? "near_duplicate"
          : "sufficiently_distinct",
      },
      repair: {
        sourceCandidateId: "archived-source-candidate",
        sourceCandidateLabel: "Original Groove",
        findingId: "critic-groove",
        seed: 42,
        attempt: 1,
        maxAttempts: 2,
        scope: {
          affectedSections: ["Chorus"],
          startBar: 9,
          endBar: 16,
          affectedTrackIds: ["drums"],
        },
        musicalReason: "The chorus rushes the backbeat.",
        outsideScopePreserved: true,
        changedScopes: [],
        sourceQualityScore: 0.7,
        repairedQualityScore: 0.84,
        improved: true,
      },
    };

    const publicEvaluation = publicCandidateEvaluation(evaluation);
    assert.deepEqual(publicEvaluation.musicCritic, musicCritic);
    assert.deepEqual(publicEvaluation.diversity, {
      comparedToCandidateId: "producer-safe-baseline",
      distance: 0.17,
      threshold: 0.25,
      rejected: status === "diversity_rejected",
      reason: status === "diversity_rejected"
        ? "near_duplicate"
        : "sufficiently_distinct",
    });
    assert.equal(publicEvaluation.repair?.sourceCandidateLabel, "Original Groove");

    const serialized = JSON.stringify(publicEvaluation);
    assert.equal(serialized.includes('"fingerprint"'), false);
    assert.equal(serialized.includes(futurePrivateSentinel), false);
    assert.equal("futureInternalEvaluation" in publicEvaluation, false);
    for (const sentinel of privateFingerprintSentinels) {
      assert.equal(serialized.includes(String(sentinel)), false);
    }
  });
}

const repairEvidence = {
  sourceCandidateId: "source",
  sourceCandidateLabel: "Original Groove",
  findingId: "finding",
  seed: 10,
  attempt: 1,
  maxAttempts: 2,
  scope: {
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
  },
  musicalReason: "Repair the chorus accompaniment.",
  outsideScopePreserved: true,
  changedScopes: [
    { level: "bar" as const, id: "bar:section:chorus:2:5" },
    { level: "event" as const, id: "event:section:chorus:2:5:piano" },
  ],
  sourceQualityScore: .5,
  repairedQualityScore: .7,
  improved: true,
};

const repairedCandidateResponse = (evaluation: ReturnType<typeof publicCandidateEvaluation>) => ({
  id: "candidate",
  jobId: "job",
  provider: "ACE_STEP",
  modelVersion: "1",
  reportedModelVersion: null,
  providerRequestId: null,
  seed: 10,
  rank: 1,
  label: "Repaired",
  score: .7,
  confidence: .8,
  summary: "Repaired candidate",
  status: "validated",
  parameters: {},
  harmonyDecisions: [],
  parentArtifactIds: [],
  plan: { sections: [] },
  trackModels: [],
  evaluation,
  createdAt: "2026-09-08T00:00:00.000Z",
});

test("candidate response parser retains new repair changed scopes", () => {
  const evaluation: CandidateEvaluation = {
    status: "evaluated",
    providerScore: .7,
    renderArtifactIds: [],
    artifacts: [],
    qualityReport: null,
    musicCritic: null,
    audioCritic: null,
    error: null,
    repair: repairEvidence,
  };
  const parsed = ListGenerationCandidatesResponse.parse([
    repairedCandidateResponse(publicCandidateEvaluation(evaluation)),
  ]);
  assert.deepEqual(parsed[0].evaluation.repair?.changedScopes, repairEvidence.changedScopes);
  assert.equal(parsed[0].evaluation.repair?.sourceCandidateLabel, "Original Groove");
});

test("candidate response parser upgrades historical repair evidence with empty changed scopes", () => {
  const { changedScopes: _removed, ...legacyRepair } = repairEvidence;
  const evaluation = {
    status: "evaluated",
    providerScore: .7,
    renderArtifactIds: [],
    artifacts: [],
    qualityReport: null,
    musicCritic: null,
    error: null,
    repair: legacyRepair,
  } as unknown as CandidateEvaluation;
  const parsed = ListGenerationCandidatesResponse.parse([
    repairedCandidateResponse(publicCandidateEvaluation(evaluation)),
  ]);
  assert.deepEqual(parsed[0].evaluation.repair?.changedScopes, []);
});

test("complete historical v1 critic remains rankable and parses through the public schema", () => {
  const checks = {
    silence: 1, clipping: 1, notePlayability: 1, timing: 1, sectionCoverage: 1, lineage: 1,
  };
  const evaluation = {
    status: "evaluated", providerScore: .7, renderArtifactIds: ["audio", "midi"],
    artifacts: [
      { id: "audio", type: "AUDIO_TRACK", label: "Audio", url: "/audio.wav" },
      { id: "midi", type: "MIDI", label: "MIDI", url: "/notes.mid" },
      { id: "quality", type: "QUALITY_REPORT", label: "Quality", url: "/quality.json" },
    ],
    qualityReport: {
      score: .8, checks, weights: checks, strengths: [], weaknesses: [], warnings: [],
      evaluatedAt: "2026-09-08T00:00:00.000Z", renderArtifactIds: ["audio", "midi"],
      lineageComplete: true,
    },
    musicCritic: { ...musicCritic, coverage: { availableDimensions: 0, totalDimensions: 8, sparse: true } },
    audioCritic: null, error: null,
  } as unknown as CandidateEvaluation;
  assert.equal(hasCompleteQualityEvidence(evaluation), true);
  const publicEvaluation = publicCandidateEvaluation(evaluation);
  assert.equal(publicEvaluation.musicCritic?.coverage.totalDimensions, 8);
  const parsed = ListGenerationCandidatesResponse.parse([
    repairedCandidateResponse(publicEvaluation),
  ]);
  assert.equal(parsed[0].evaluation.musicCritic?.version, "music-critic-v1");
  assert.equal(parsed[0].evaluation.musicCritic?.coverage.totalDimensions, 8);
});

test("populated v2 critic public serialization excludes observations fingerprints and evaluator details", () => {
  const privateValues = ["private-observation", "private-fingerprint", "private-evaluator-detail"];
  const result = {
    status: "available" as const, score: .4,
    evidence: [{
      source: "composition_intelligence" as const,
      summary: "Producer-safe summary",
      observations: { detail: privateValues[0], fingerprint: privateValues[1] },
    }],
    explanation: "Readable explanation",
    findings: [{
      id: "music-critic-v2:motif:chorus:5-5:piano", affectedSections: ["chorus"],
      startBar: 5, endBar: 5, affectedTrackIds: ["piano"], affectedRoles: ["harmony"],
      canonicalScope: { startBar: 5, endBar: 5 },
      evidenceReferences: [{ source: "composition_intelligence", summary: "Safe reference" }],
      permissibleRepairOperations: ["adjust_notes"], musicalReason: "Repair this phrase.",
    }],
    rawEvaluatorDetails: privateValues[2],
  };
  const dimensions = Object.fromEntries([
    "vocalFit", "harmony", "development", "contrastAndTransitions", "registerCollisions",
    "playability", "repetition", "styleAndControlAdherence", "motifContinuityAndDevelopment",
    "phraseIntent", "vocalInteraction", "roleDuplication", "orchestralBalance",
    "grooveCoordination", "voiceLeading", "countermelodyShape", "dramaticTrajectory",
  ].map((name) => [name, result]));
  const evaluation = {
    status: "evaluated", providerScore: .5, renderArtifactIds: [], artifacts: [],
    qualityReport: null, audioCritic: null, error: null,
    musicCritic: {
      version: "music-critic-v2", score: .4,
      coverage: { availableDimensions: 17, totalDimensions: 17, sparse: false },
      dimensions,
    },
  } as unknown as CandidateEvaluation;
  const publicEvaluation = publicCandidateEvaluation(evaluation);
  const serialized = JSON.stringify(publicEvaluation);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
  assert.deepEqual(
    publicEvaluation.musicCritic?.dimensions.motifContinuityAndDevelopment.evidence[0].observations,
    {},
  );
  const parsed = ListGenerationCandidatesResponse.parse([
    repairedCandidateResponse(publicEvaluation),
  ]);
  assert.equal(parsed[0].evaluation.musicCritic?.version, "music-critic-v2");
});