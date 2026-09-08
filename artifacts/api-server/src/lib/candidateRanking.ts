import type {
  CandidateEvaluation,
  CandidateMusicCriticDimension,
  CandidateMusicCriticDimensionResult,
} from "@workspace/db";
import { musicCriticDimensions } from "./candidateQuality";
import { perceptualAudioCriticDimensions } from "./perceptualAudioCritic";

const requiredQualityChecks = [
  "silence",
  "clipping",
  "notePlayability",
  "timing",
  "sectionCoverage",
  "lineage",
];

export function publicCandidateEvaluation(evaluation: CandidateEvaluation) {
  const criticDimensions = evaluation.musicCritic?.dimensions as Partial<Record<
    CandidateMusicCriticDimension, CandidateMusicCriticDimensionResult
  >> | undefined;
  const musicCritic = evaluation.musicCritic
    ? {
        version: evaluation.musicCritic.version,
        score: evaluation.musicCritic.score,
        coverage: evaluation.musicCritic.coverage ?? (() => {
          const availableDimensions = musicCriticDimensions.filter(
            (name) => criticDimensions?.[name]?.status === "available",
          ).length;
          return {
            availableDimensions,
            totalDimensions: evaluation.musicCritic?.version === "music-critic-v1" ? 8 : musicCriticDimensions.length,
            sparse: availableDimensions < (evaluation.musicCritic?.version === "music-critic-v1" ? 8 : musicCriticDimensions.length) / 2,
          };
        })(),
        dimensions: Object.fromEntries(
          musicCriticDimensions.flatMap((name) => {
            const dimension = criticDimensions?.[name];
            return dimension
              ? [[name, {
                  status: dimension.status,
                  score: dimension.score,
                   // Public evidence is a bounded explanation only; internal
                   // fingerprints, raw observations, and evaluator details stay private.
                   evidence: dimension.evidence.map((evidence) => ({
                    source: evidence.source,
                    summary: evidence.summary,
                     observations: {},
                  })),
                  explanation: dimension.explanation,
                  findings: (dimension.findings ?? []).map((finding) => ({
                    id: finding.id,
                    affectedSections: [...finding.affectedSections],
                    startBar: finding.startBar,
                    endBar: finding.endBar,
                    affectedTrackIds: [...finding.affectedTrackIds],
                    ...(finding.affectedRoles ? { affectedRoles: [...finding.affectedRoles] } : {}),
                    ...(finding.canonicalScope ? { canonicalScope: { ...finding.canonicalScope } } : {}),
                    ...(finding.evidenceReferences ? {
                      evidenceReferences: finding.evidenceReferences.map((reference) => ({
                        source: reference.source, summary: reference.summary,
                      })),
                    } : {}),
                    ...(finding.permissibleRepairOperations ? {
                      permissibleRepairOperations: [...finding.permissibleRepairOperations],
                    } : {}),
                    musicalReason: finding.musicalReason,
                  })),
                }]]
              : [];
          }),
        ),
      }
    : null;
  const audioCritic = evaluation.audioCritic
    ? {
        version: evaluation.audioCritic.version,
        status: evaluation.audioCritic.status,
        score: evaluation.audioCritic.score,
        coverage: { ...evaluation.audioCritic.coverage },
        // Evidence is intentionally metadata/hash only, never PCM or a private URL.
        evidence: evaluation.audioCritic.evidence ? { ...evaluation.audioCritic.evidence } : null,
        dimensions: Object.fromEntries(perceptualAudioCriticDimensions.map((name) => {
          const dimension = evaluation.audioCritic!.dimensions[name];
          return [name, {
            status: dimension.status, score: dimension.score, explanation: dimension.explanation,
            findings: dimension.findings.map((finding) => ({
              id: finding.id, startSeconds: finding.startSeconds, endSeconds: finding.endSeconds,
              ...(finding.affectedTrackIds ? { affectedTrackIds: [...finding.affectedTrackIds] } : {}),
              confidence: finding.confidence, provenance: finding.provenance, recommendation: finding.recommendation,
            })),
          }];
        })),
      }
    : null;
  return {
    status: evaluation.status,
    providerScore: evaluation.providerScore,
    renderArtifactIds: [...evaluation.renderArtifactIds],
    artifacts: evaluation.artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      label: artifact.label,
      url: artifact.url,
      ...(artifact.artifactSha256 ? { artifactSha256: artifact.artifactSha256 } : {}),
    })),
    qualityReport: evaluation.qualityReport
      ? {
          score: evaluation.qualityReport.score,
          checks: { ...evaluation.qualityReport.checks },
          weights: { ...evaluation.qualityReport.weights },
          strengths: [...evaluation.qualityReport.strengths],
          weaknesses: [...evaluation.qualityReport.weaknesses],
          warnings: [...evaluation.qualityReport.warnings],
          evaluatedAt: evaluation.qualityReport.evaluatedAt,
          renderArtifactIds: [...evaluation.qualityReport.renderArtifactIds],
          lineageComplete: evaluation.qualityReport.lineageComplete,
        }
      : null,
    musicCritic,
    audioCritic,
    error: evaluation.error,
    ...(evaluation.strategy
      ? {
          strategy: {
            name: evaluation.strategy.name,
            index: evaluation.strategy.index,
            baseSeed: evaluation.strategy.baseSeed,
            seed: evaluation.strategy.seed,
          },
        }
      : {}),
    ...(evaluation.diversity
      ? {
          diversity: {
            comparedToCandidateId: evaluation.diversity.comparedToCandidateId,
            distance: evaluation.diversity.distance,
            threshold: evaluation.diversity.threshold,
            rejected: evaluation.diversity.rejected,
            reason: evaluation.diversity.reason,
          },
        }
      : {}),
    ...(evaluation.repair
      ? {
          repair: {
            sourceCandidateId: evaluation.repair.sourceCandidateId,
            ...(evaluation.repair.sourceCandidateLabel
              ? { sourceCandidateLabel: evaluation.repair.sourceCandidateLabel }
              : {}),
            findingId: evaluation.repair.findingId,
            seed: evaluation.repair.seed,
            attempt: evaluation.repair.attempt,
            maxAttempts: evaluation.repair.maxAttempts,
            scope: {
              affectedSections: [...evaluation.repair.scope.affectedSections],
              startBar: evaluation.repair.scope.startBar,
              endBar: evaluation.repair.scope.endBar,
              affectedTrackIds: [...evaluation.repair.scope.affectedTrackIds],
            },
            musicalReason: evaluation.repair.musicalReason,
            outsideScopePreserved: evaluation.repair.outsideScopePreserved,
            changedScopes: [...((evaluation.repair as typeof evaluation.repair & {
              changedScopes?: typeof evaluation.repair.changedScopes;
            }).changedScopes ?? [])].map((scope) => ({ ...scope })),
            sourceQualityScore: evaluation.repair.sourceQualityScore,
            repairedQualityScore: evaluation.repair.repairedQualityScore,
            improved: evaluation.repair.improved,
          },
        }
      : {}),
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
  // Historical rows predate the PCM critic. Any row carrying the new report must
  // have sufficient, successful audio evidence; provider confidence cannot bypass it.
  if (evaluation.audioCritic && (
    evaluation.audioCritic.status !== "available" ||
    !evaluation.audioCritic.coverage.sufficient ||
    !Number.isFinite(evaluation.audioCritic.score) ||
    !evaluation.audioCritic.evidence ||
    !renderedAudioEvidenceMatches(evaluation)
  )) return false;
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
    (evaluation.musicCritic.version === "music-critic-v1"
      ? musicCriticDimensions.filter((name) => ![
        "motifContinuityAndDevelopment", "phraseIntent", "vocalInteraction", "roleDuplication",
        "orchestralBalance", "grooveCoordination", "voiceLeading", "countermelodyShape", "dramaticTrajectory",
      ].includes(name))
      : musicCriticDimensions
    ).every((name) => {
      const dimension = evaluation.musicCritic?.dimensions as Partial<Record<
        CandidateMusicCriticDimension, CandidateMusicCriticDimensionResult
      >>;
      const result = dimension?.[name];
      return Boolean(
        result &&
        result.status !== "failed" &&
        (result.status === "unavailable"
          ? result.score === null
          : Number.isFinite(result.score)),
      );
    }) &&
    !Number.isNaN(Date.parse(report.evaluatedAt)) &&
    report.renderArtifactIds.length === renderArtifactIds.size &&
    report.renderArtifactIds.every((id) => renderArtifactIds.has(id)) &&
    requiredQualityChecks.every((check) =>
      Number.isFinite(report.checks[check]) &&
      Number.isFinite(report.weights[check]));
}

function renderedAudioEvidenceMatches(evaluation: CandidateEvaluation): boolean {
  const evidence = evaluation.audioCritic?.evidence;
  return Boolean(evidence && evaluation.renderArtifactIds.includes(evidence.artifactId) &&
    evaluation.artifacts.some((artifact) => artifact.id === evidence.artifactId &&
      artifact.type === "AUDIO_TRACK" && artifact.artifactSha256 === evidence.artifactSha256) &&
    perceptualAudioCriticDimensions.every((name) => {
      const dimension = evaluation.audioCritic?.dimensions[name];
      return dimension && dimension.status !== "failed" &&
        (dimension.status === "unavailable" ? dimension.score === null : Number.isFinite(dimension.score));
    }));
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

/** Neither critic replaces the other. New complete evidence is reconciled evenly. */
export function reconciledEvidenceScore(evaluation: CandidateEvaluation): number {
  return reconciledEvidenceScoreWithCalibration(evaluation);
}

export type CandidateRankingCalibration = {
  rankingWeight: number;
  criticWeight: number;
};

/** Calibration only reweights two independent, already-safe critic scores. */
export function reconciledEvidenceScoreWithCalibration(
  evaluation: CandidateEvaluation,
  calibration?: CandidateRankingCalibration,
): number {
  const symbolic = evaluation.musicCritic?.score;
  const audio = evaluation.audioCritic?.score;
  if (
    calibration &&
    Number.isFinite(symbolic) &&
    Number.isFinite(audio) &&
    Number.isFinite(calibration.rankingWeight) &&
    Number.isFinite(calibration.criticWeight)
  ) {
    return symbolic! * calibration.rankingWeight + audio! * calibration.criticWeight;
  }
  return Number.isFinite(symbolic) && Number.isFinite(audio)
    ? (symbolic! + audio!) / 2
    : symbolic ?? audio ?? -1;
}

export function rankEvaluatedCandidates<
  T extends { id?: string; score: number; evaluation: CandidateEvaluation },
>(candidates: T[], calibration?: CandidateRankingCalibration): Array<T & { rank: number | null }> {
  let nextRank = 1;
  return [...candidates]
    .sort((left, right) => {
      const leftEvaluated = hasCompleteQualityEvidence(left.evaluation) ? 1 : 0;
      const rightEvaluated = hasCompleteQualityEvidence(right.evaluation) ? 1 : 0;
      return rightEvaluated - leftEvaluated ||
        candidateEvidenceScore(right, calibration) - candidateEvidenceScore(left, calibration) ||
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

function candidateEvidenceScore(
  candidate: { evaluation: CandidateEvaluation },
  calibration?: CandidateRankingCalibration,
): number {
  const critic = reconciledEvidenceScore(candidate.evaluation);
  const ranking = candidate.evaluation.qualityReport?.score;
  return calibration && Number.isFinite(ranking) && Number.isFinite(critic)
    ? ranking! * calibration.rankingWeight + critic * calibration.criticWeight
    : critic;
}

/** The only score features calibration is permitted to freeze and reuse. */
export function deployedCalibrationFeatures(evaluation: CandidateEvaluation): {
  rankingScore: number | null; criticScore: number | null;
} {
  const rankingScore = evaluation.qualityReport?.score;
  const criticScore = reconciledEvidenceScore(evaluation);
  return {
    rankingScore: Number.isFinite(rankingScore) ? rankingScore! : null,
    criticScore: Number.isFinite(criticScore) && criticScore >= 0 ? criticScore : null,
  };
}
