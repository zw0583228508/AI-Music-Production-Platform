import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  CandidateEvaluation,
  CandidateEvaluationStatus,
} from "@workspace/db";
import { publicCandidateEvaluation } from "./candidateRanking";

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
    vocalFit: { status: "unavailable", score: null, evidence: [], explanation: "safe-vocal-summary" },
    harmony: { status: "unavailable", score: null, evidence: [], explanation: "safe-harmony-summary" },
    development: { status: "unavailable", score: null, evidence: [], explanation: "safe-development-summary" },
    contrastAndTransitions: { status: "unavailable", score: null, evidence: [], explanation: "safe-transition-summary" },
    registerCollisions: { status: "unavailable", score: null, evidence: [], explanation: "safe-register-summary" },
    playability: { status: "unavailable", score: null, evidence: [], explanation: "safe-playability-summary" },
    repetition: { status: "unavailable", score: null, evidence: [], explanation: "safe-repetition-summary" },
    styleAndControlAdherence: { status: "unavailable", score: null, evidence: [], explanation: "safe-style-summary" },
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

    const serialized = JSON.stringify(publicEvaluation);
    assert.equal(serialized.includes('"fingerprint"'), false);
    assert.equal(serialized.includes(futurePrivateSentinel), false);
    assert.equal("futureInternalEvaluation" in publicEvaluation, false);
    for (const sentinel of privateFingerprintSentinels) {
      assert.equal(serialized.includes(String(sentinel)), false);
    }
  });
}