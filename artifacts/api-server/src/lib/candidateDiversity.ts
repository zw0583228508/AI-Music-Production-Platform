import type { ArrangementPlan, TrackModel } from "@workspace/db";

export const CANDIDATE_STRATEGIES = [
  "sparse",
  "balanced",
  "rhythmic",
  "harmonic",
  "orchestral",
] as const;

export type CandidateStrategy = (typeof CANDIDATE_STRATEGIES)[number];
export const CANDIDATE_DIVERSITY_THRESHOLD = 0.25;

export type CandidateFingerprint = {
  activeTracks: string[];
  densityEnergy: Array<{ density: number; energy: number }>;
  harmonySequence: string[];
  trackRoleInstruments: string[];
  noteShape: number[];
};

export type CandidateDiversityEvidence = {
  fingerprint: CandidateFingerprint;
  comparedToCandidateId: string | null;
  distance: number | null;
  threshold: number;
  rejected: boolean;
  reason: "baseline_retained" | "near_duplicate" | "sufficiently_distinct";
};

export function strategyForCandidate(index: number): CandidateStrategy {
  return CANDIDATE_STRATEGIES[index % CANDIDATE_STRATEGIES.length];
}

export function seedForCandidate(baseSeed: number, index: number): number {
  return (baseSeed + index) % 2_147_483_647;
}

const uniqueSorted = (values: string[]) => [...new Set(values)].sort();
const jaccardDistance = (left: string[], right: string[]) => {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return 1 - intersection / union.size;
};

/** This intentionally only reads canonical ArrangementPlan and TrackModel data. */
export function fingerprintCandidate(
  plan: ArrangementPlan,
  trackModels: TrackModel[],
): CandidateFingerprint {
  const activeTracks = uniqueSorted(plan.sections.flatMap((section, index) => {
    const active = section.activeTracks?.length
      ? section.activeTracks
      : Object.entries(section.tracks)
          .filter(([, operation]) => operation !== "none")
          .map(([track]) => track);
    return active.map((track) => `${index}:${track}`);
  }));
  const harmonyTracks = trackModels.filter((track) =>
    /harmony|bass|melody|countermelody/i.test(track.role));
  const harmonySequence = harmonyTracks
    .flatMap((track) => track.notes.map((note) =>
      `${Math.round(note.start * 4) / 4}:${note.pitch % 12}`,
    ))
    .sort();
  const noteShape = trackModels.map((track) => {
    if (!track.notes.length) return `${track.id}:empty`;
    const duration = track.notes.reduce((sum, note) => sum + note.duration, 0);
    const averagePitch = track.notes.reduce((sum, note) => sum + note.pitch, 0) /
      track.notes.length;
    return `${track.id}:${track.notes.length}:${Math.round(duration * 4) / 4}:${Math.round(averagePitch)}`;
  }).sort();
  return {
    activeTracks,
    densityEnergy: plan.sections.map(({ density, energy }) => ({ density, energy })),
    harmonySequence,
    trackRoleInstruments: uniqueSorted(trackModels.map((track) =>
      `${track.role}:${track.instrument}`)),
    // Kept as a string-compatible tuple internally so its stable serialized
    // representation remains inspectable without inspecting provider output.
    noteShape: noteShape.map((value) => stableNumber(value)),
  };
}

// A deterministic compact representation for note-shape tuples. It is not a
// random hash and is compared positionally below.
function stableNumber(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

function madDistance(
  left: Array<{ density: number; energy: number }>,
  right: Array<{ density: number; energy: number }>,
) {
  const length = Math.max(left.length, right.length);
  if (!length) return 0;
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    total += a && b
      ? (Math.abs(a.density - b.density) + Math.abs(a.energy - b.energy)) / 2
      : 1;
  }
  return total / length;
}

export function candidateDistance(
  left: CandidateFingerprint,
  right: CandidateFingerprint,
): number {
  const activeTrackDistance = jaccardDistance(left.activeTracks, right.activeTracks);
  const densityEnergyDistance = madDistance(left.densityEnergy, right.densityEnergy);
  const harmonyDistance = jaccardDistance(left.harmonySequence, right.harmonySequence);
  const roleInstrumentDistance = jaccardDistance(
    left.trackRoleInstruments,
    right.trackRoleInstruments,
  );
  const noteShapeDistance = jaccardDistance(
    left.noteShape.map(String),
    right.noteShape.map(String),
  );
  return 0.4 * activeTrackDistance +
    0.25 * densityEnergyDistance +
    0.2 * harmonyDistance +
    0.15 * (0.7 * roleInstrumentDistance + 0.3 * noteShapeDistance);
}

export function diversityEvidence(
  fingerprint: CandidateFingerprint,
  accepted: Array<{ id: string; fingerprint: CandidateFingerprint }>,
): CandidateDiversityEvidence {
  if (!accepted.length) {
    return {
      fingerprint, comparedToCandidateId: null, distance: null,
      threshold: CANDIDATE_DIVERSITY_THRESHOLD, rejected: false,
      reason: "baseline_retained",
    };
  }
  const nearest = accepted
    .map((candidate) => ({ id: candidate.id, distance: candidateDistance(fingerprint, candidate.fingerprint) }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))[0];
  const rejected = nearest.distance < CANDIDATE_DIVERSITY_THRESHOLD;
  return {
    fingerprint, comparedToCandidateId: nearest.id, distance: nearest.distance,
    threshold: CANDIDATE_DIVERSITY_THRESHOLD, rejected,
    reason: rejected ? "near_duplicate" : "sufficiently_distinct",
  };
}