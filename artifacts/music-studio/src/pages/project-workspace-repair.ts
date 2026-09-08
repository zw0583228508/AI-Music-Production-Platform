import type {
  CandidateMusicCriticFinding,
  GenerationCandidate,
} from "@workspace/api-client-react";

export type RepairFindingPreview = {
  candidate: GenerationCandidate;
  dimensionName: string;
  finding: CandidateMusicCriticFinding;
};

export function isRepairEligible(
  candidate: GenerationCandidate,
  dimension: {
    status: string;
    score: number | null;
  },
  existingRepair: unknown,
  finding: CandidateMusicCriticFinding | null,
): boolean {
  return Boolean(
    candidate.status === "validated" &&
    !existingRepair &&
    dimension.status === "available" &&
    dimension.score !== null &&
    dimension.score < 1 &&
    finding,
  );
}

export function resolveRepairSourceCandidate(
  currentSource: GenerationCandidate | null,
  sourceJobCandidates: GenerationCandidate[] | undefined,
  repairedCandidates: GenerationCandidate[],
): GenerationCandidate | null {
  return currentSource ??
    sourceJobCandidates?.find((candidate) =>
      repairedCandidates.some((repaired) =>
        repaired.evaluation.repair?.sourceCandidateId === candidate.id
      )
    ) ??
    null;
}

export function retainedRepairSourceForJob(
  status: string | undefined,
  repairedCandidateCount: number,
  sourceCandidate: GenerationCandidate | null,
): GenerationCandidate | null {
  if (!sourceCandidate) return null;
  if (status === "queued" || status === "running") return sourceCandidate;
  if (status === "failed" && repairedCandidateCount === 0) return sourceCandidate;
  return null;
}

export function repairOutcomeTitle(repair: {
  outsideScopePreserved: boolean;
  improved: boolean;
}): string {
  if (!repair.outsideScopePreserved) return "Repair violated its scope";
  return repair.improved
    ? "Critic repair improved this candidate"
    : "Repair did not improve the candidate";
}

export function repairLineageLabel(
  sourceCandidateId: string,
  persistedSourceCandidateLabel: string | undefined,
  sourceCandidate: GenerationCandidate | null,
): string {
  return `Repair of ${
    persistedSourceCandidateLabel ??
    (sourceCandidate?.id === sourceCandidateId
      ? sourceCandidate.label
      : sourceCandidateId.slice(0, 8))
  }`;
}
