import { isDeepStrictEqual } from "node:util";
import type {
  ArrangementPlan,
  CandidateRepairSnapshot,
  CriticRepairFinding,
  CandidateAudioCriticFinding,
  TrackModel,
  ArrangementHierarchyScope,
} from "@workspace/db";
import { createCanonicalTimeline } from "./canonicalTimeline";
import { performedMaterialSha256, synchronizeMotifLineage } from "./musicEngines";

/** Repairs retain the persisted candidate's stochastic identity verbatim. */
export const boundedRepairSourceSeed = (persistedSourceSeed: number) => persistedSourceSeed;

export const MAX_REPAIR_ATTEMPTS = 2;
const repairOperations = [
  "adjust_notes", "adjust_rhythm", "adjust_register", "adjust_dynamics", "adjust_voicing", "adjust_directive",
] as const;

/** Converts only persisted PCM findings into a canonical, bounded repair scope. */
export function audioFindingToRepairFinding(input: {
  finding: CandidateAudioCriticFinding;
  plan: ArrangementPlan;
  trackModels: TrackModel[];
  tempoMap: Array<{ time: number; bpm: number }>;
  meterMap: Array<{ bar: number; meter: string }>;
}): CriticRepairFinding {
  const { finding, plan, trackModels } = input;
  if (!Number.isFinite(finding.startSeconds) || !Number.isFinite(finding.endSeconds) ||
    finding.startSeconds < 0 || finding.endSeconds <= finding.startSeconds ||
    !finding.affectedTrackIds?.length) throw new Error("Audio finding is not an actionable bounded repair scope");
  const knownTracks = new Set(trackModels.map((track) => track.id));
  const tracks = finding.affectedTrackIds.filter((id) => knownTracks.has(id));
  if (!tracks.length) throw new Error("Audio finding has no valid rendered track attribution");
  const timeline = createCanonicalTimeline(input.tempoMap, input.meterMap);
  const startBar = timeline.coordinateAtSeconds(finding.startSeconds).bar;
  const endBar = timeline.coordinateAtSeconds(Math.max(finding.startSeconds, finding.endSeconds - 1e-6)).bar;
  const sections = plan.sections.filter((section) => section.endBar >= startBar && section.startBar <= endBar)
    .map((section) => section.section);
  return normalizeRepairFinding({
    id: finding.id, affectedSections: sections, startBar, endBar, affectedTrackIds: tracks,
    musicalReason: finding.recommendation,
  }, plan, trackModels);
}

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
  const allowedOperations = new Set<string>(repairOperations);
  // Historical v1 findings did not carry an operation contract. They retain
  // the previous bounded behavior; newly authored findings must be explicit.
  const operations = finding.permissibleRepairOperations ?? [...repairOperations];
  if (!operations.length || operations.some((operation) => !allowedOperations.has(operation))) {
    throw new Error("Repair finding has an invalid permissible repair operation");
  }
  if (finding.canonicalScope && (
    finding.canonicalScope.startBar !== finding.startBar ||
    finding.canonicalScope.endBar !== finding.endBar
  )) throw new Error("Repair finding canonical scope does not match its bar range");
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
    affectedRoles: [...new Set((finding.affectedRoles ?? tracks.map((id) =>
      trackModels.find((track) => track.id === id)!.role)).filter(Boolean))].sort(),
    canonicalScope: { startBar: finding.startBar, endBar: finding.endBar },
    evidenceReferences: (finding.evidenceReferences ?? []).slice(0, 8).map((reference) => ({
      source: reference.source,
      summary: reference.summary,
    })),
    permissibleRepairOperations: [...new Set(operations)].sort(),
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
  const permitted = new Set(finding.permissibleRepairOperations ?? repairOperations);
  const requireOperation = (operation: typeof repairOperations[number], detail: string) => {
    if (!permitted.has(operation)) {
      throw new Error(`Bounded repair does not permit ${operation}: ${detail}`);
    }
  };
  const baseTrackById = new Map(snapshot.trackModels.map((track) => [track.id, track]));
  for (const proposed of proposedTrackModels) {
    const base = baseTrackById.get(proposed.id);
    if (!base || !finding.affectedTrackIds.includes(proposed.id)) continue;
    const before = new Map(base.notes.filter((note) => intervalInScope(note.start, note.duration, timeBounds))
      .map((note) => [note.id, note]));
    const after = new Map(proposed.notes.filter((note) => intervalInScope(note.start, note.duration, timeBounds))
      .map((note) => [note.id, note]));
    for (const [id, note] of before) {
      const replacement = after.get(id);
      if (!replacement) {
        requireOperation("adjust_notes", `removing note ${id}`);
        continue;
      }
      if (note.start !== replacement.start || note.duration !== replacement.duration) {
        requireOperation("adjust_rhythm", `changing timing for note ${id}`);
      }
      if (note.pitch !== replacement.pitch) {
        if (!permitted.has("adjust_register") && !permitted.has("adjust_voicing")) {
          throw new Error(`Bounded repair does not permit pitch change for note ${id}`);
        }
      }
      if (note.velocity !== replacement.velocity) requireOperation("adjust_dynamics", `changing velocity for note ${id}`);
    }
    for (const id of after.keys()) if (!before.has(id)) requireOperation("adjust_notes", `adding note ${id}`);
    const inScopeDirectives = (values: NonNullable<TrackModel["appliedDirectives"]>) =>
      values.filter((directive) => directive.startBar >= finding.startBar && directive.endBar <= finding.endBar);
    if (!isDeepStrictEqual(inScopeDirectives(base.appliedDirectives ?? []), inScopeDirectives(proposed.appliedDirectives ?? []))) {
      requireOperation("adjust_directive", `changing directives for ${proposed.id}`);
    }
    const scopedTimed = <T extends { time: number }>(values: T[]) =>
      values.filter((value) => pointInScope(value.time, timeBounds));
    if (!isDeepStrictEqual(scopedTimed(base.cc), scopedTimed(proposed.cc)) ||
      !isDeepStrictEqual(scopedTimed(base.automation), scopedTimed(proposed.automation))) {
      requireOperation("adjust_dynamics", `changing controller or automation data for ${proposed.id}`);
    }
    if (!isDeepStrictEqual(scopedTimed(base.articulations), scopedTimed(proposed.articulations))) {
      requireOperation("adjust_notes", `changing articulations for ${proposed.id}`);
    }
  }
  // Plan reasoning is not performance material.  Any merged plan, hierarchy,
  // or Composition Intelligence decision is an explicit directive operation;
  // a notes-only repair must leave all of it byte-identical.
  const originalHierarchy = snapshot.plan.hierarchy;
  const hierarchySemantics = (value: ArrangementPlan["hierarchy"] | undefined) => {
    if (!value) return value;
    const sourceById = new Map(value.sections.map((section) => [section.id, section.sourceSection]));
    return {
      song: {
        intent: value.song.intent,
        climaxSection: value.song.climaxSectionId
          ? sourceById.get(value.song.climaxSectionId) ?? value.song.climaxSectionId
          : null,
      },
      sections: value.sections.map(({ id: _id, phraseIds: _phrases, barIds: _bars, ...section }) => section),
      phrases: value.phrases.map(({ id: _id, sectionId, ...phrase }) => ({
        ...phrase, sourceSection: sourceById.get(sectionId) ?? sectionId,
      })),
      bars: value.bars.map(({ id: _id, sectionId, phraseIds: _phrases, ...bar }) => ({
        ...bar, sourceSection: sourceById.get(sectionId) ?? sectionId,
      })),
      events: value.events.map(({ id: _id, sectionId, barId: _barId, ...event }) => ({
        ...event, sourceSection: sourceById.get(sectionId) ?? sectionId,
      })),
    };
  };
  const hierarchyEquivalent = isDeepStrictEqual(
    hierarchySemantics(originalHierarchy),
    hierarchySemantics(proposedPlan.hierarchy),
  );
  const scopedMotifMaterialChanged = (
    motifId: string,
    phraseId: string,
  ) => {
    const normalizedScopedMaterial = (values: TrackModel[]) => values
      .filter((track) => finding.affectedTrackIds.includes(track.id))
      .flatMap((track) => track.notes
        .filter((note) =>
          note.motif?.id === motifId &&
          note.motif.phraseId === phraseId &&
          intervalInScope(note.start, note.duration, timeBounds))
        .map((note) => ({
          trackId: track.id,
          note: {
            ...note,
            motif: note.motif ? { ...note.motif, fingerprint: "" } : note.motif,
          },
        })))
      .sort((left, right) =>
        left.trackId.localeCompare(right.trackId) ||
        left.note.id.localeCompare(right.note.id) ||
        left.note.start - right.note.start ||
        left.note.pitch - right.note.pitch);
    return !isDeepStrictEqual(
      normalizedScopedMaterial(snapshot.trackModels),
      normalizedScopedMaterial(proposedTrackModels),
    );
  };
  const fingerprintMayBeDerivedFromScopedMaterial = (
    motif: NonNullable<NonNullable<
      ArrangementPlan["compositionIntelligence"]
    >["motifs"]>[number],
    reasoning: NonNullable<ArrangementPlan["compositionIntelligence"]>,
  ) => {
    if (!(["adjust_notes", "adjust_rhythm", "adjust_voicing", "adjust_register"] as const)
      .some((operation) => permitted.has(operation))) return false;
    const phrase = reasoning.phrases.find((candidate) =>
      candidate.id === motif.sourcePhraseId);
    if (!phrase) return false;
    const hierarchySection = originalHierarchy?.sections.find((section) =>
      section.id === phrase.sectionId);
    if (!hierarchySection ||
      !finding.affectedSections.includes(hierarchySection.sourceSection)) return false;
    const belongsToAffectedTrack = phrase.ownerTrackId
      ? finding.affectedTrackIds.includes(phrase.ownerTrackId)
      : motif.ownerTrackId
        ? finding.affectedTrackIds.includes(motif.ownerTrackId)
        : snapshot.trackModels.some((track) =>
          finding.affectedTrackIds.includes(track.id) &&
          track.notes.some((note) =>
            note.motif?.id === motif.id && note.motif.phraseId === phrase.id));
    if (!belongsToAffectedTrack) return false;
    return scopedMotifMaterialChanged(motif.id, phrase.id);
  };
  const reasoningEquivalent = (() => {
    if (!snapshot.plan.compositionIntelligence || !proposedPlan.compositionIntelligence) {
      return snapshot.plan.compositionIntelligence === proposedPlan.compositionIntelligence;
    }
    const sourceMotifs = new Map(
      snapshot.plan.compositionIntelligence.motifs?.map((motif) => [motif.id, motif]) ?? [],
    );
    return isDeepStrictEqual(snapshot.plan.compositionIntelligence, {
      ...proposedPlan.compositionIntelligence,
      seed: snapshot.plan.compositionIntelligence.seed,
      evidenceSha256: snapshot.plan.compositionIntelligence.evidenceSha256,
      motifs: proposedPlan.compositionIntelligence.motifs?.map((motif) => {
        const source = sourceMotifs.get(motif.id);
        return source && fingerprintMayBeDerivedFromScopedMaterial(
          source,
          snapshot.plan.compositionIntelligence!,
        )
          ? { ...motif, fingerprint: source.fingerprint }
          : motif;
      }),
    });
  })();
  const planReasoningChanged =
    !hierarchyEquivalent ||
    !reasoningEquivalent ||
    snapshot.plan.sections.some((section) => {
      const proposed = proposedPlan.sections.find((candidate) => candidate.section === section.section);
      if (!proposed || !finding.affectedSections.includes(section.section)) return false;
      return finding.affectedTrackIds.some((trackId) =>
        section.tracks[trackId] !== proposed.tracks[trackId] ||
        !isDeepStrictEqual(section.trackDirectives?.[trackId], proposed.trackDirectives?.[trackId]) ||
        (section.activeTracks ?? Object.keys(section.tracks)).includes(trackId) !==
          (proposed.activeTracks ?? Object.keys(proposed.tracks)).includes(trackId));
    });
  if (planReasoningChanged) requireOperation("adjust_directive", "changing plan, hierarchy, or composition intelligence");
  const proposedSections = new Map(proposedPlan.sections.map((section) => [section.section, section]));
  const hierarchySectionInScope = (section: NonNullable<typeof baseHierarchy>["sections"][number]) =>
    finding.affectedSections.includes(section.sourceSection) &&
    section.startBar >= finding.startBar && section.endBar <= finding.endBar;
  const affectedSectionId = (sectionId: string) => {
    const section = baseHierarchy?.sections.find((candidate) => candidate.id === sectionId);
    return Boolean(section && finding.affectedSections.includes(section.sourceSection));
  };
  const affectedBar = (bar: number) => bar >= finding.startBar && bar <= finding.endBar;
  const proposedHierarchy = hierarchyEquivalent && originalHierarchy
    ? originalHierarchy
    : proposedPlan.hierarchy;
  const baseHierarchy = originalHierarchy ?? proposedHierarchy;
  if (originalHierarchy && proposedHierarchy) {
    if (!isDeepStrictEqual(originalHierarchy.song, proposedHierarchy.song)) {
      throw new Error("Bounded repair cannot alter canonical hierarchy song ownership");
    }
    const assertCanonicalObjects = (
      source: Array<Record<string, unknown>>,
      proposed: Array<Record<string, unknown>>,
      fields: string[],
      label: string,
    ) => {
      const sourceById = new Map(source.map((item) => [String(item.id), item]));
      const proposedById = new Map(proposed.map((item) => [String(item.id), item]));
      if (sourceById.size !== proposedById.size) {
        throw new Error(`Bounded repair cannot add or remove canonical hierarchy ${label}`);
      }
      for (const [id, original] of sourceById) {
        const candidate = proposedById.get(id);
        if (!candidate) throw new Error(`Bounded repair cannot replace canonical hierarchy ${label}`);
        const protectedFields = new Set([
          ...fields,
          ...Object.keys(original).filter((key) =>
            /(parent|song|owner|section|bar|meter|time|coordinate)/i.test(key)),
        ]);
        for (const field of protectedFields) {
          if (!isDeepStrictEqual(original[field], candidate[field])) {
            throw new Error(`Bounded repair cannot alter canonical hierarchy ${label} ownership or scope`);
          }
        }
      }
    };
    assertCanonicalObjects(
      originalHierarchy.sections as Array<Record<string, unknown>>,
      proposedHierarchy.sections as Array<Record<string, unknown>>,
      ["id", "sourceSection", "startBar", "endBar", "phraseIds", "barIds"],
      "sections",
    );
    assertCanonicalObjects(
      originalHierarchy.bars as Array<Record<string, unknown>>,
      proposedHierarchy.bars as Array<Record<string, unknown>>,
      ["id", "sectionId", "bar", "meter", "phraseIds"],
      "bars",
    );
    assertCanonicalObjects(
      originalHierarchy.phrases as Array<Record<string, unknown>>,
      proposedHierarchy.phrases as Array<Record<string, unknown>>,
      ["id", "sectionId", "startBar", "endBar"],
      "phrases",
    );
    assertCanonicalObjects(
      originalHierarchy.events as Array<Record<string, unknown>>,
      proposedHierarchy.events as Array<Record<string, unknown>>,
      ["id", "sectionId", "barId", "trackId", "source"],
      "events",
    );
  }
  const copyHierarchySemanticFields = <T extends object>(
    source: T,
    candidate: T | undefined,
    fields: string[],
  ) => {
    if (!candidate) return source;
    const copied = { ...source } as Record<string, unknown>;
    const proposed = candidate as Record<string, unknown>;
    for (const field of fields) {
      if (field in proposed) copied[field] = proposed[field];
    }
    return copied as T;
  };
  const hierarchy = hierarchyEquivalent ? originalHierarchy
    : originalHierarchy && proposedHierarchy ? {
    ...baseHierarchy,
    // Hierarchy coordinates and parent links are source-owned. Directive
    // repairs may carry only these local semantic fields into the merge.
    // This deliberately does not spread a proposed hierarchy object.
    sections: baseHierarchy.sections.map((section) =>
      hierarchySectionInScope(section)
        ? copyHierarchySemanticFields(section,
          proposedHierarchy.sections.find((candidate) => candidate.id === section.id),
          ["function", "development", "targetEnergy", "targetDensity"])
        : section),
    phrases: [
      ...baseHierarchy.phrases.filter((phrase) =>
        !affectedSectionId(phrase.sectionId) ||
        phrase.endBar < finding.startBar ||
        phrase.startBar > finding.endBar ||
        phrase.startBar < finding.startBar ||
        phrase.endBar > finding.endBar),
      ...proposedHierarchy.phrases.filter((phrase) =>
        affectedSectionId(phrase.sectionId) && phrase.startBar >= finding.startBar && phrase.endBar <= finding.endBar)
        .map((phrase) => copyHierarchySemanticFields(
          baseHierarchy.phrases.find((source) => source.id === phrase.id)!, phrase,
          ["intent", "confidence"])),
    ],
    bars: baseHierarchy.bars.map((bar) =>
      affectedSectionId(bar.sectionId) && affectedBar(bar.bar)
        ? copyHierarchySemanticFields(bar,
          proposedHierarchy.bars.find((candidate) => candidate.id === bar.id),
          ["vocalSpace"])
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
      }).map((event) => copyHierarchySemanticFields(
        baseHierarchy.events.find((source) => source.id === event.id)!, event, ["intent"])),
    ],
    } : proposedHierarchy;
  const originalReasoning = snapshot.plan.compositionIntelligence;
  const proposedReasoning = proposedPlan.compositionIntelligence;
  const phraseTouchesAffectedTrack = (
    phrase: NonNullable<typeof originalReasoning>["phrases"][number],
  ) => phrase.ownerTrackId
    ? finding.affectedTrackIds.includes(phrase.ownerTrackId)
    : [...snapshot.trackModels, ...proposedTrackModels]
        .filter((track) => finding.affectedTrackIds.includes(track.id))
        .some((track) => track.notes.some((note) =>
          note.motif?.phraseId === phrase.id || note.motif?.id === phrase.motifRef));
  const phraseInScope = (phrase: NonNullable<typeof originalReasoning>["phrases"][number]) =>
    finding.affectedSections.some((name) =>
      (baseHierarchy?.sections.find((section) => section.id === phrase.sectionId)
        ?? proposedHierarchy?.sections.find((section) => section.id === phrase.sectionId))
        ?.sourceSection === name) &&
    phrase.startBar >= finding.startBar &&
    phrase.endBar <= finding.endBar &&
    phraseTouchesAffectedTrack(phrase);
  if (originalReasoning && proposedReasoning) {
    const originalMotifIds = originalReasoning.motifs?.map((motif) => motif.id) ?? [];
    const proposedMotifIds = proposedReasoning.motifs?.map((motif) => motif.id) ?? [];
    if (new Set(originalMotifIds).size !== originalMotifIds.length ||
      new Set(proposedMotifIds).size !== proposedMotifIds.length) {
      throw new Error("Bounded repair requires unique motif identities");
    }
    for (const original of originalReasoning.phrases.filter(phraseInScope)) {
      const proposed = proposedReasoning.phrases.find((phrase) => phrase.id === original.id);
      if (!proposed ||
        proposed.motifRef !== original.motifRef ||
        proposed.sourceMotifRef !== original.sourceMotifRef ||
        proposed.ownerTrackId !== original.ownerTrackId) {
        throw new Error("Bounded repair must preserve motif and phrase ownership identity");
      }
      const originalMotif = originalReasoning.motifs?.find((motif) =>
        motif.id === original.motifRef);
      const proposedMotif = proposedReasoning.motifs?.find((motif) =>
        motif.id === original.motifRef);
      if (originalMotif && (!proposedMotif ||
        proposedMotif.sourcePhraseId !== originalMotif.sourcePhraseId ||
        proposedMotif.sourceSectionId !== originalMotif.sourceSectionId ||
        proposedMotif.parentMotifId !== originalMotif.parentMotifId ||
        proposedMotif.ownerTrackId !== originalMotif.ownerTrackId ||
        proposedMotif.evidenceSha256 !== originalMotif.evidenceSha256)) {
        throw new Error("Bounded repair must preserve canonical motif source lineage");
      }
    }
  }
  const compositionIntelligence = originalReasoning && proposedReasoning ? {
    ...originalReasoning,
    tensionRelease: originalReasoning.tensionRelease.map((event) => {
      const hierarchySection = baseHierarchy?.sections.find((section) =>
        section.id === event.sectionId);
      if (!hierarchySection || !finding.affectedSections.includes(hierarchySection.sourceSection) ||
        hierarchySection.startBar < finding.startBar || hierarchySection.endBar > finding.endBar) return event;
      return proposedReasoning.tensionRelease.find((candidate) =>
        candidate.sectionId === event.sectionId) ?? event;
    }),
    phrases: [
      ...originalReasoning.phrases.filter((phrase) => !phraseInScope(phrase))
        .map((phrase) => ({ ...phrase })),
      ...proposedReasoning.phrases.filter(phraseInScope)
        .map((phrase) => ({ ...phrase })),
    ].sort((left, right) =>
      left.startBar - right.startBar || left.endBar - right.endBar || left.id.localeCompare(right.id)),
    motifs: [
      ...(originalReasoning.motifs ?? []).filter((motif) =>
        !originalReasoning.phrases.some((phrase) =>
          phrase.id === motif.sourcePhraseId && phraseInScope(phrase)))
        .map((motif) => ({ ...motif })),
      ...(proposedReasoning.motifs ?? []).filter((motif) =>
        proposedReasoning.phrases.some((phrase) =>
          phrase.id === motif.sourcePhraseId && phraseInScope(phrase)))
        .map((motif) => ({ ...motif })),
    ].sort((left, right) => left.id.localeCompare(right.id)),
  } : originalReasoning ?? proposedReasoning;
  const plan: ArrangementPlan = {
    ...snapshot.plan,
    hierarchy,
    compositionIntelligence,
    sections: snapshot.plan.sections.map((section) => {
      const proposed = proposedSections.get(section.section);
      if (!proposed || !finding.affectedSections.includes(section.section) ||
        section.startBar < finding.startBar || section.endBar > finding.endBar) return section;
      const affected = new Set(finding.affectedTrackIds);
      const mergeMap = <T>(base: Record<string, T> | undefined, next: Record<string, T> | undefined) =>
        Object.fromEntries([...new Set([...Object.keys(base ?? {}), ...Object.keys(next ?? {})])]
          .flatMap((id) => {
            const value = affected.has(id) ? next?.[id] : base?.[id];
            return value === undefined ? [] : [[id, value] as [string, T]];
          })) as Record<string, T>;
      return {
        ...section,
        tracks: mergeMap(section.tracks, proposed.tracks),
        activeTracks: proposed.activeTracks
          ? [...new Set([
              ...(section.activeTracks ?? Object.keys(section.tracks)).filter((id) => !affected.has(id)),
              ...proposed.activeTracks.filter((id) => affected.has(id)),
            ])]
          : section.activeTracks,
        trackDirectives: mergeMap(section.trackDirectives, proposed.trackDirectives),
        // Operations are section-wide intent and cannot safely be attributed
        // to one repaired track.
        operations: section.operations,
      };
    }),
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
  let trackModels = snapshot.trackModels.map((base) => {
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
          directive.startBar < finding.startBar || directive.endBar > finding.endBar),
        ...(proposed.appliedDirectives ?? []).filter((directive) =>
          directive.startBar >= finding.startBar && directive.endBar <= finding.endBar),
      ],
       // A local repair may replace only scoped performance material. Identity,
       // parent lineage, and all non-performance metadata remain source-owned.
       provenance: base.provenance,
       version: base.version,
       source: base.source,
    };
  });
  const beforeSynchronize = structuredClone(trackModels);
  trackModels = synchronizeMotifLineage(trackModels, plan.compositionIntelligence);
  // synchronizeMotifLineage is useful for newly repaired notes, but it has no
  // authority over an unscoped tag. Restore those exact source bytes before
  // returning rather than merely comparing all other note fields.
  for (const before of beforeSynchronize) {
    const repaired = trackModels.find((track) => track.id === before.id);
    if (!repaired) continue;
    const selected = finding.affectedTrackIds.includes(before.id);
    const originalById = new Map(before.notes
      .filter((note) => !selected || intervalTouchesOutsideScope(note.start, note.duration, timeBounds))
      .map((note) => [note.id, note]));
    repaired.notes = repaired.notes.map((note) => originalById.get(note.id) ?? note);
  }
  // Lineage synchronization is permitted to inspect all tracks, but an
  // unselected track is not part of the repair contract. Restore its complete
  // model (including provenance and performance digests), not only its notes.
  trackModels = trackModels.map((track) =>
    finding.affectedTrackIds.includes(track.id)
      ? track
      : beforeSynchronize.find((before) => before.id === track.id) ?? track);
  trackModels = trackModels.map((track) => {
    if (!finding.affectedTrackIds.includes(track.id) || !track.performanceEvidence) return track;
    return {
      ...track,
      performanceEvidence: {
        ...track.performanceEvidence,
        performedMaterialSha256: performedMaterialSha256(track),
      },
    };
  });
  // Lineage reconciliation is allowed to retag only material wholly inside
  // the approved scope. It must never silently rewrite a boundary-crossing or
  // unscoped event.
  for (const before of beforeSynchronize) {
    const after = trackModels.find((track) => track.id === before.id);
    if (!after || !isDeepStrictEqual(
      before.notes.filter((note) => intervalTouchesOutsideScope(note.start, note.duration, timeBounds))
        .map(({ motif: _motif, ...note }) => note),
      after.notes.filter((note) => intervalTouchesOutsideScope(note.start, note.duration, timeBounds))
        .map(({ motif: _motif, ...note }) => note),
    )) throw new Error("Motif lineage synchronization modified material outside the repair scope");
  }
  const hierarchyScopePreserved = (() => {
    if (!originalHierarchy || !plan.hierarchy) return originalHierarchy === plan.hierarchy;
    const canonicalFieldsEqual = (
      source: Record<string, unknown>,
      repaired: Record<string, unknown> | undefined,
      fields: string[],
    ) => Boolean(repaired) && fields.every((field) =>
      isDeepStrictEqual(source[field], repaired![field]));
    const sectionById = new Map(plan.hierarchy.sections.map((section) => [section.id, section]));
    const barById = new Map(plan.hierarchy.bars.map((bar) => [bar.id, bar]));
    const phraseById = new Map(plan.hierarchy.phrases.map((phrase) => [phrase.id, phrase]));
    const eventById = new Map(plan.hierarchy.events.map((event) => [event.id, event]));
    const sections = originalHierarchy.sections.every((section) => {
      const repaired = sectionById.get(section.id);
      const scoped = hierarchySectionInScope(section);
      return scoped
        ? canonicalFieldsEqual(section as Record<string, unknown>, repaired as Record<string, unknown>,
          ["id", "sourceSection", "startBar", "endBar", "phraseIds", "barIds"])
        : isDeepStrictEqual(section, repaired);
    });
    const bars = originalHierarchy.bars.every((bar) => {
      const repaired = barById.get(bar.id);
      const scoped = affectedSectionId(bar.sectionId) && affectedBar(bar.bar);
      return scoped
        ? canonicalFieldsEqual(bar as Record<string, unknown>, repaired as Record<string, unknown>,
          ["id", "sectionId", "bar", "meter", "phraseIds"])
        : isDeepStrictEqual(bar, repaired);
    });
    const phrases = originalHierarchy.phrases.every((phrase) => {
      const repaired = phraseById.get(phrase.id);
      const scoped = affectedSectionId(phrase.sectionId) &&
        phrase.startBar >= finding.startBar && phrase.endBar <= finding.endBar;
      return scoped
        ? canonicalFieldsEqual(phrase as Record<string, unknown>, repaired as Record<string, unknown>,
          ["id", "sectionId", "startBar", "endBar"])
        : isDeepStrictEqual(phrase, repaired);
    });
    const events = originalHierarchy.events.every((event) => {
      const sourceBar = originalHierarchy.bars.find((bar) => bar.id === event.barId);
      const repaired = eventById.get(event.id);
      const scoped = Boolean(sourceBar && affectedSectionId(event.sectionId) &&
        affectedBar(sourceBar.bar) && finding.affectedTrackIds.includes(event.trackId));
      return scoped
        ? canonicalFieldsEqual(event as Record<string, unknown>, repaired as Record<string, unknown>,
          ["id", "sectionId", "barId", "trackId", "source"])
        : isDeepStrictEqual(event, repaired);
    });
    return isDeepStrictEqual(originalHierarchy.song, plan.hierarchy.song) &&
      originalHierarchy.sections.length === plan.hierarchy.sections.length &&
      originalHierarchy.bars.length === plan.hierarchy.bars.length &&
      originalHierarchy.phrases.length === plan.hierarchy.phrases.length &&
      originalHierarchy.events.length === plan.hierarchy.events.length &&
      sections && bars && phrases && events;
  })();
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
    ) && isDeepStrictEqual(
      (base.appliedDirectives ?? []).filter((directive) =>
        directive.startBar < finding.startBar || directive.endBar > finding.endBar),
      (repaired.appliedDirectives ?? []).filter((directive) =>
        directive.startBar < finding.startBar || directive.endBar > finding.endBar),
    );
  }) && hierarchyScopePreserved && snapshot.plan.sections.every((base) => {
    if (
      finding.affectedSections.includes(base.section) &&
      base.startBar >= finding.startBar &&
      base.endBar <= finding.endBar
    ) return true;
    return isDeepStrictEqual(base, plan.sections.find((section) => section.section === base.section));
  }) && (!originalReasoning || (
    originalReasoning.phrases.filter((phrase) => !phraseInScope(phrase)).every((phrase) =>
      isDeepStrictEqual(phrase, plan.compositionIntelligence?.phrases.find((candidate) =>
        candidate.id === phrase.id))) &&
    (originalReasoning.motifs ?? []).filter((motif) =>
      !fingerprintMayBeDerivedFromScopedMaterial(motif, originalReasoning) &&
      !originalReasoning.phrases.some((phrase) =>
        phrase.id === motif.sourcePhraseId && phraseInScope(phrase))).every((motif) =>
      isDeepStrictEqual(motif, plan.compositionIntelligence?.motifs.find((candidate) =>
        candidate.id === motif.id)))
  ));
  const changedScopes = changedHierarchyScopes(originalHierarchy, plan.hierarchy);
  return { plan, trackModels, outsideScopePreserved, changedScopes };
}
