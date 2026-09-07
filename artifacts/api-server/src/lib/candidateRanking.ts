import type { CandidateEvaluation } from "@workspace/db";
import { musicCriticDimensions } from "./candidateQuality";

const requiredQualityChecks = [
  "silence",
  "clipping",
  "notePlayability",
  "timing",
  "sectionCoverage",
  "lineage",
];

export function publicCandidateEvaluation(evaluation: CandidateEvaluation) {
  const { fingerprint: _fingerprint, ...publicDiversity } =
    evaluation.diversity ?? {
      fingerprint: undefined,
      comparedToCandidateId: null,
      distance: null,
      threshold: 0.25,
      rejected: false,
      reason: "baseline_retained" as const,
    };
  const musicCritic = evaluation.musicCritic
    ? {
        ...evaluation.musicCritic,
        coverage: evaluation.musicCritic.coverage ?? (() => {
          const availableDimensions = musicCriticDimensions.filter(
            (name) => evaluation.musicCritic?.dimensions[name]?.status === "available",
          ).length;
          return {
            availableDimensions,
            totalDimensions: 8 as const,
            sparse: availableDimensions < musicCriticDimensions.length / 2,
          };
        })(),
      }
    : null;
  return {
    ...evaluation,
    musicCritic,
    ...(evaluation.diversity ? { diversity: publicDiversity } : {}),
  };
}

/**
 * A provider score is only a preference, not independent evidence. A candidate
 * is rankable only after its render outputs and quality report agree on the
 * same artifact lineage. Provider-audio candidates may be audio-only when no
 * symbolic TrackModels exist; symbolic candidates must include MIDI evidence.
 */
export function hasCompleteQualityEvidence(evaluation: CandidateEvaluation): boolean {
  if (
    evaluation.status !== "evaluated" ||
    evaluation.diversity?.rejected ||
    evaluation.error !== null ||
    !evaluation.qualityReport ||
    !evaluation.musicCritic ||
    !evaluation.qualityReport.lineageComplete
  ) return false;
  const renderArtifactIds = new Set(evaluation.renderArtifactIds);
  if (
    renderArtifactIds.size < 1 ||
    renderArtifactIds.size > 2 ||
    renderArtifactIds.size !== evaluation.renderArtifactIds.length ||
    ![...renderArtifactIds].every(Boolean)
  ) return false;
  const audioArtifacts = evaluation.artifacts.filter((artifact) =>
    artifact.type === "AUDIO_TRACK" && renderArtifactIds.has(artifact.id));
  const midiArtifacts = evaluation.artifacts.filter((artifact) =>
    artifact.type === "MIDI" && renderArtifactIds.has(artifact.id));
  if (
    audioArtifacts.length !== 1 ||
    (renderArtifactIds.size === 1
      ? midiArtifacts.length !== 0
      : midiArtifacts.length !== 1) ||
    !evaluation.artifacts.some((artifact) => artifact.type === "QUALITY_REPORT") ||
    !audioArtifacts[0].url ||
    midiArtifacts.some((artifact) => !artifact.url)
  ) return false;
  const report = evaluation.qualityReport;
  return Number.isFinite(report.score) &&
    Number.isFinite(evaluation.musicCritic.score) &&
    musicCriticDimensions.every((name) => {
      const dimension = evaluation.musicCritic?.dimensions[name];
      return Boolean(
        dimension &&
        dimension.status !== "failed" &&
        (dimension.status === "unavailable"
          ? dimension.score === null
          : Number.isFinite(dimension.score)),
      );
    }) &&
    !Number.isNaN(Date.parse(report.evaluatedAt)) &&
    report.renderArtifactIds.length === renderArtifactIds.size &&
    report.renderArtifactIds.every((id) => renderArtifactIds.has(id)) &&
    requiredQualityChecks.every((check) =>
      Number.isFinite(report.checks[check]) &&
      Number.isFinite(report.weights[check]));
}

export function isSelectableCandidate(candidate: {
  status: string;
  evaluation: CandidateEvaluation;
  trackModels: unknown;
  evaluatedPlan: unknown;
  evaluatedStyleSpec: unknown;
}): boolean {
  const audioOnlyProviderCandidate =
    Array.isArray(candidate.trackModels) &&
    candidate.trackModels.length === 0 &&
    candidate.evaluation.renderArtifactIds.length === 1 &&
    candidate.evaluation.artifacts.some((artifact) =>
      artifact.type === "AUDIO_TRACK" &&
      candidate.evaluation.renderArtifactIds.includes(artifact.id)
    ) &&
    !candidate.evaluation.artifacts.some((artifact) =>
      artifact.type === "MIDI" &&
      candidate.evaluation.renderArtifactIds.includes(artifact.id)
    );
  return candidate.status === "validated" &&
    hasCompleteQualityEvidence(candidate.evaluation) &&
    Array.isArray(candidate.trackModels) &&
    (candidate.trackModels.length > 0 || audioOnlyProviderCandidate) &&
    candidate.evaluatedPlan !== null &&
    candidate.evaluatedStyleSpec !== null;
}

export function rankEvaluatedCandidates<
  T extends { id?: string; score: number; evaluation: CandidateEvaluation },
>(candidates: T[]): Array<T & { rank: number | null }> {
  let nextRank = 1;
  return [...candidates]
    .sort((left, right) => {
      const leftEvaluated = hasCompleteQualityEvidence(left.evaluation) ? 1 : 0;
      const rightEvaluated = hasCompleteQualityEvidence(right.evaluation) ? 1 : 0;
      return rightEvaluated - leftEvaluated ||
        (right.evaluation.musicCritic?.score ?? -1) -
          (left.evaluation.musicCritic?.score ?? -1) ||
        right.evaluation.providerScore - left.evaluation.providerScore ||
        (left.id ?? "").localeCompare(right.id ?? "");
    })
    .map((candidate) => {
      const rank = hasCompleteQualityEvidence(candidate.evaluation)
        ? nextRank++
        : null;
      return { ...candidate, rank };
    });
}