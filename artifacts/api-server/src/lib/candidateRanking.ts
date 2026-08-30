import type { CandidateEvaluation } from "@workspace/db";

const requiredQualityChecks = [
  "silence",
  "clipping",
  "notePlayability",
  "timing",
  "sectionCoverage",
  "lineage",
];

/**
 * A provider score is only a preference, not independent evidence. A candidate
 * is rankable only after its rendered audio/MIDI and quality report agree on
 * the same artifact lineage.
 */
export function hasCompleteQualityEvidence(evaluation: CandidateEvaluation): boolean {
  if (
    evaluation.status !== "evaluated" ||
    evaluation.error !== null ||
    !evaluation.qualityReport ||
    !evaluation.qualityReport.lineageComplete
  ) return false;
  const renderArtifactIds = new Set(evaluation.renderArtifactIds);
  if (renderArtifactIds.size !== 2 || ![...renderArtifactIds].every(Boolean)) return false;
  const audioArtifact = evaluation.artifacts.find((artifact) =>
    artifact.type === "AUDIO_TRACK" && renderArtifactIds.has(artifact.id));
  const midiArtifact = evaluation.artifacts.find((artifact) =>
    artifact.type === "MIDI" && renderArtifactIds.has(artifact.id));
  if (
    !audioArtifact ||
    !midiArtifact ||
    !evaluation.artifacts.some((artifact) => artifact.type === "QUALITY_REPORT") ||
    !audioArtifact.url ||
    !midiArtifact.url
  ) return false;
  const report = evaluation.qualityReport;
  return Number.isFinite(report.score) &&
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
  return candidate.status === "validated" &&
    hasCompleteQualityEvidence(candidate.evaluation) &&
    candidate.trackModels !== null &&
    candidate.evaluatedPlan !== null &&
    candidate.evaluatedStyleSpec !== null;
}

export function rankEvaluatedCandidates<
  T extends { score: number; evaluation: CandidateEvaluation },
>(candidates: T[]): Array<T & { rank: number | null }> {
  let nextRank = 1;
  return [...candidates]
    .sort((left, right) => {
      const leftEvaluated = hasCompleteQualityEvidence(left.evaluation) ? 1 : 0;
      const rightEvaluated = hasCompleteQualityEvidence(right.evaluation) ? 1 : 0;
      return rightEvaluated - leftEvaluated ||
        right.score - left.score ||
        right.evaluation.providerScore - left.evaluation.providerScore;
    })
    .map((candidate) => {
      const rank = hasCompleteQualityEvidence(candidate.evaluation)
        ? nextRank++
        : null;
      return { ...candidate, rank };
    });
}