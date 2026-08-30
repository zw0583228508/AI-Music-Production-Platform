import type { CandidateEvaluation } from "@workspace/db";

export function rankEvaluatedCandidates<
  T extends { score: number; evaluation: CandidateEvaluation },
>(candidates: T[]): Array<T & { rank: number | null }> {
  let nextRank = 1;
  return [...candidates]
    .sort((left, right) => {
      const leftEvaluated = left.evaluation.status === "evaluated" ? 1 : 0;
      const rightEvaluated = right.evaluation.status === "evaluated" ? 1 : 0;
      return rightEvaluated - leftEvaluated ||
        right.score - left.score ||
        right.evaluation.providerScore - left.evaluation.providerScore;
    })
    .map((candidate) => {
      const rank = candidate.evaluation.status === "evaluated"
        ? nextRank++
        : null;
      return { ...candidate, rank };
    });
}