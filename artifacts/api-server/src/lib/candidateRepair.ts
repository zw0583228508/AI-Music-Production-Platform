import { isDeepStrictEqual } from "node:util";
import type {
  ArrangementPlan,
  CandidateRepairSnapshot,
  CriticRepairFinding,
  TrackModel,
  ArrangementHierarchyScope,
} from "@workspace/db";
import { createCanonicalTimeline } from "./canonicalTimeline";

export const MAX_REPAIR_ATTEMPTS = 2;

function changedHierarchyScopes(
  before: ArrangementPlan["hierarchy"] | undefined,
  after: ArrangementPlan["hierarchy"] | undefined,
): ArrangementHierarchyScope[] {
  if (!after) return [];
  if (!before) {
    return [
      { level: "song", id: after.song.id },
      ...after.sections.map(({ id }) => ({ level: "section" as const, id })),
      ...after.phrases.map(({ id }) => ({ level: "phrase" as const, id })),
      ...after.bars.map(({ id }) => ({ level: "bar" as const, id })),
      ...after.events.map(({ id }) => ({ level: "event" as const, id })),
    ];
  }
  const scopes: ArrangementHierarchyScope[] = [];
  const compare = <T extends { id: string }>(
    level: ArrangementHierarchyScope["level"],
    left: T[],
    right: T[],
  ) => {
    const rightById = new Map(right.map((value) => [value.id, value]));
    for (const value of left) {
      if (!isDeepStrictEqual(value, rightById.get(value.id))) scopes.push({ level, id: value.id });
    }
    const leftIds = new Set(left.map((value) => value.id));
    for (const value of right) if (!leftIds.has(value.id)) scopes.push({ level, id: value.id });
  };
  if (!isDeepStrictEqual(before.song, after.song)) scopes.push({ level: "song", id: before.song.id });
  compare("section", before.sections, after.sections);
  compare("phrase", before.phrases, after.phrases);
  compare("bar", before.bars, after.bars);
  compare("event", before.events, after.events);
  return scopes;
}

export function normalizeRepairFinding(
  finding: CriticRepairFinding,
  plan: ArrangementPlan,
  trackModels: TrackModel[],
): CriticRepairFinding {
  const sections = [...new Set(finding.affectedSections.map((value) => value.trim()).filter(Boolean))].sort();
  const tracks = [...new Set(finding.affectedTrackIds.map((value) => value.trim()).filter(Boolean))].sort();
  const knownSections = new Set(plan.sections.map((section) => section.section));
  const knownTracks = new Set(trackModels.map((track) => track.id));
  if (
    !finding.id.trim() ||
    !finding.musicalReason.trim() ||
    !sections.length ||
    !tracks.length ||
    !Number.isInteger(finding.startBar) ||
    !Number.isInteger(finding.endBar) ||
    finding.startBar < 1 ||
    finding.endBar < finding.startBar ||
    sections.some((section) => !knownSections.has(section)) ||
    tracks.some((track) => !knownTracks.has(track))
  ) {
    throw new Error(
      "Repair requires a critic finding with known sections, an inclusive bar range, known tracks, and a musical reason",
    );
  }
  const selectedSections = plan.sections.filter((section) =>
    sections.includes(section.section));
  for (let bar = finding.startBar; bar <= finding.endBar; bar += 1) {
    if (!selectedSections.some((section) =>
      section.startBar <= bar && section.endBar >= bar)) {
      throw new Error(
        "Every repair bar must belong to one of the affected sections",
      );
    }
  }
  return {
    ...finding,
    id: finding.id.trim(),
    musicalReason: finding.musicalReason.trim(),
    affectedSections: sections,
    affectedTrackIds: tracks,
  };
}

export function validateServerAuthoredRepairFinding(
  findingId: string,
  submittedFinding: CriticRepairFinding,
  serverFindings: CriticRepairFinding[],
  plan: ArrangementPlan,
  trackModels: TrackModel[],
): CriticRepairFinding {
  const normalizedFinding = normalizeRepairFinding(submittedFinding, plan, trackModels);
  const serverFinding = serverFindings.find((item) => item.id === findingId);
  if (!serverFinding) {
    throw new Error("The selected critic finding is not available for this candidate");
  }
  const normalizedServerFinding = normalizeRepairFinding(serverFinding, plan, trackModels);
  if (
    findingId !== normalizedFinding.id ||
    !isDeepStrictEqual(normalizedFinding, normalizedServerFinding)
  ) {
    throw new Error("Repair scope does not match the server-authored critic finding");
  }
  return normalizedServerFinding;
}
export function repairTimeBounds(
  finding: CriticRepairFinding,
  tempoMap: Array<{ time: number; bpm: number }>,
  meterMap: Array<{ bar: number; meter: string }>,
) {
  const timeline = createCanonicalTimeline(tempoMap, meterMap);
  return {
    start: timeline.coordinateAtBar(finding.startBar).seconds,
    end: timeline.coordinateAtBar(finding.endBar + 1).seconds,
  };
}

const pointInScope = (time: number, bounds: { start: number; end: number }) => {
  return time >= bounds.start && time < bounds.end;
};

const intervalInScope = (
  start: number,
  duration: number,
  bounds: { start: number; end: number },
) => {
  return duration >= 0 && start >= bounds.start && start + duration <= bounds.end;
};

const intervalTouchesOutsideScope = (
  start: number,
  duration: number,
  bounds: { start: number; end: number },
) => !intervalInScope(start, duration, bounds);

export function applyBoundedRepair(input: {
  snapshot: CandidateRepairSnapshot;
  proposedPlan: ArrangementPlan;
  proposedTrackModels: TrackModel[];
  timeBounds: { start: number; end: number };
}): { plan: ArrangementPlan; trackModels: TrackModel[]; outsideScopePreserved: boolean; changedScopes: ArrangementHierarchyScope[] } {
  const { snapshot, proposedPlan, proposedTrackModels, timeBounds } = input;
  const finding = snapshot.finding;
  const proposedSections = new Map(proposedPlan.sections.map((section) => [section.section, section]));
  const hierarchySectionInScope = (section: NonNullable<typeof baseHierarchy>["sections"][number]) =>
    finding.affectedSections.includes(section.sourceSection) &&
    section.startBar >= finding.startBar && section.endBar <= finding.endBar;
  const affectedSectionId = (sectionId: string) => {
    const section = baseHierarchy?.sections.find((candidate) => candidate.id === sectionId);
    return Boolean(section && finding.affectedSections.includes(section.sourceSection));
  };
  const affectedBar = (bar: number) => bar >= finding.startBar && bar <= finding.endBar;
  const proposedHierarchy = proposedPlan.hierarchy;
  const originalHierarchy = (snapshot.plan as ArrangementPlan & {
    hierarchy?: ArrangementPlan["hierarchy"];
  }).hierarchy;
  const baseHierarchy = originalHierarchy ?? proposedHierarchy;
  const hierarchy = originalHierarchy && proposedHierarchy ? {
    ...baseHierarchy,
    sections: baseHierarchy.sections.map((section) =>
      hierarchySectionInScope(section)
        ? proposedHierarchy.sections.find((candidate) => candidate.id === section.id) ?? section
        : section),
    phrases: [
      ...baseHierarchy.phrases.filter((phrase) =>
        !affectedSectionId(phrase.sectionId) ||
        phrase.endBar < finding.startBar ||
        phrase.startBar > finding.endBar ||
        phrase.startBar < finding.startBar ||
        phrase.endBar > finding.endBar),
      ...proposedHierarchy.phrases.filter((phrase) =>
        affectedSectionId(phrase.sectionId) && phrase.startBar >= finding.startBar && phrase.endBar <= finding.endBar),
    ],
    bars: baseHierarchy.bars.map((bar) =>
      affectedSectionId(bar.sectionId) && affectedBar(bar.bar)
        ? proposedHierarchy.bars.find((candidate) => candidate.id === bar.id) ?? bar
        : bar),
    events: [
      ...baseHierarchy.events.filter((event) => {
        const bar = baseHierarchy.bars.find((candidate) => candidate.id === event.barId);
        return !affectedSectionId(event.sectionId) || !bar || !affectedBar(bar.bar) ||
          !finding.affectedTrackIds.includes(event.trackId);
      }),
      ...proposedHierarchy.events.filter((event) => {
        const bar = proposedHierarchy.bars.find((candidate) => candidate.id === event.barId);
        return affectedSectionId(event.sectionId) && Boolean(bar && affectedBar(bar.bar)) &&
          finding.affectedTrackIds.includes(event.trackId);
      }),
    ],
  } : proposedHierarchy;
  const plan: ArrangementPlan = {
    ...snapshot.plan,
    hierarchy,
    sections: snapshot.plan.sections.map((section) =>
      finding.affectedSections.includes(section.section) &&
      section.startBar >= finding.startBar &&
      section.endBar <= finding.endBar
        ? proposedSections.get(section.section) ?? section
        : section),
  };
  const proposedTracks = new Map(proposedTrackModels.map((track) => [track.id, track]));
  const mergeTimed = <T>(base: T[], proposed: T[], getTime: (value: T) => number) => [
    ...base.filter((value) => !pointInScope(getTime(value), timeBounds)),
    ...proposed.filter((value) => pointInScope(getTime(value), timeBounds)),
  ].sort((left, right) => getTime(left) - getTime(right));
  const mergeNotes = (
    base: TrackModel["notes"],
    proposed: TrackModel["notes"],
  ) => [
    ...base.filter((note) =>
      intervalTouchesOutsideScope(note.start, note.duration, timeBounds)),
    ...proposed.filter((note) =>
      intervalInScope(note.start, note.duration, timeBounds)),
  ].sort((left, right) => left.start - right.start);
  const trackModels = snapshot.trackModels.map((base) => {
    if (!finding.affectedTrackIds.includes(base.id)) return base;
    const proposed = proposedTracks.get(base.id);
    if (!proposed) return base;
    return {
      ...base,
      notes: mergeNotes(base.notes, proposed.notes),
      cc: mergeTimed(base.cc, proposed.cc, (value) => value.time),
      articulations: mergeTimed(base.articulations, proposed.articulations, (value) => value.time),
      automation: mergeTimed(base.automation, proposed.automation, (value) => value.time),
      appliedDirectives: [
        ...(base.appliedDirectives ?? []).filter((directive) =>
          directive.endBar < finding.startBar || directive.startBar > finding.endBar),
        ...(proposed.appliedDirectives ?? []).filter((directive) =>
          directive.startBar >= finding.startBar && directive.endBar <= finding.endBar),
      ],
      provenance: proposed.provenance,
      version: proposed.version,
      source: proposed.source,
    };
  });
  const outsideScopePreserved = snapshot.trackModels.every((base) => {
    const repaired = trackModels.find((track) => track.id === base.id);
    if (!repaired) return false;
    if (!finding.affectedTrackIds.includes(base.id)) return isDeepStrictEqual(base, repaired);
    return isDeepStrictEqual(
      base.notes.filter((note) =>
        intervalTouchesOutsideScope(note.start, note.duration, timeBounds)),
      repaired.notes.filter((note) =>
        intervalTouchesOutsideScope(note.start, note.duration, timeBounds)),
    ) && isDeepStrictEqual(
      base.cc.filter((event) => !pointInScope(event.time, timeBounds)),
      repaired.cc.filter((event) => !pointInScope(event.time, timeBounds)),
    ) && isDeepStrictEqual(
      base.articulations.filter((event) => !pointInScope(event.time, timeBounds)),
      repaired.articulations.filter((event) => !pointInScope(event.time, timeBounds)),
    ) && isDeepStrictEqual(
      base.automation.filter((event) => !pointInScope(event.time, timeBounds)),
      repaired.automation.filter((event) => !pointInScope(event.time, timeBounds)),
    );
  }) && snapshot.plan.sections.every((base) => {
    if (
      finding.affectedSections.includes(base.section) &&
      base.startBar >= finding.startBar &&
      base.endBar <= finding.endBar
    ) return true;
    return isDeepStrictEqual(base, plan.sections.find((section) => section.section === base.section));
  });
  const changedScopes = changedHierarchyScopes(originalHierarchy, plan.hierarchy);
  return { plan, trackModels, outsideScopePreserved, changedScopes };
}
