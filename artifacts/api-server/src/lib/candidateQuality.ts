import type {
  ArrangementPlan,
  CandidateMusicCriticDimension,
  CandidateMusicCriticDimensionResult,
  CandidateMusicCriticReport,
  CandidateMusicCriticReportV2,
  CriticRepairFinding,
  HarmonyDecisionEvidence,
  SongModelData,
  TrackModel,
} from "@workspace/db";
import { createCanonicalTimeline } from "./canonicalTimeline";

const dimensions: CandidateMusicCriticDimension[] = [
  "vocalFit",
  "harmony",
  "development",
  "contrastAndTransitions",
  "registerCollisions",
  "playability",
  "repetition",
  "styleAndControlAdherence",
  "motifContinuityAndDevelopment",
  "phraseIntent",
  "vocalInteraction",
  "roleDuplication",
  "orchestralBalance",
  "grooveCoordination",
  "voiceLeading",
  "countermelodyShape",
  "dramaticTrajectory",
];

const weights: Record<CandidateMusicCriticDimension, number> = {
  vocalFit: 0.14,
  harmony: 0.16,
  development: 0.12,
  contrastAndTransitions: 0.12,
  registerCollisions: 0.12,
  playability: 0.12,
  repetition: 0.1,
  styleAndControlAdherence: 0.12,
  motifContinuityAndDevelopment: 0.1,
  phraseIntent: 0.08,
  vocalInteraction: 0.08,
  roleDuplication: 0.08,
  orchestralBalance: 0.08,
  grooveCoordination: 0.08,
  voiceLeading: 0.1,
  countermelodyShape: 0.08,
  dramaticTrajectory: 0.1,
};

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const round = (value: number): number => Math.round(value * 1_000) / 1_000;

type TimedTrackNote = {
  trackId: string;
  note: TrackModel["notes"][number];
  ordinal: number;
};

function isExplicitDoubling(
  left: TimedTrackNote,
  right: TimedTrackNote,
  tracks: TrackModel[],
): boolean {
  const time = Math.max(left.note.start, right.note.start);
  const leftTrack = tracks.find((track) => track.id === left.trackId);
  const rightTrack = tracks.find((track) => track.id === right.trackId);
  const directiveAt = (track: TrackModel | undefined) => track?.appliedDirectives?.find((applied) =>
    time >= applied.start && time < applied.end)?.directive ?? track?.directive;
  const leftDirective = directiveAt(leftTrack);
  const rightDirective = directiveAt(rightTrack);
  return leftDirective?.musicalFunction === "doubling" &&
      leftDirective.doublingTrackId === right.trackId ||
    rightDirective?.musicalFunction === "doubling" &&
      rightDirective.doublingTrackId === left.trackId;
}

function forEachCrossTrackOverlap(
  tracks: TrackModel[],
  visit: (left: TimedTrackNote, right: TimedTrackNote) => void,
): number {
  const notes: TimedTrackNote[] = [];
  let ordinal = 0;
  for (const track of tracks) {
    for (const note of track.notes) {
      notes.push({ trackId: track.id, note, ordinal });
      ordinal += 1;
    }
  }
  notes.sort((left, right) => left.note.start - right.note.start || left.ordinal - right.ordinal);

  let active: TimedTrackNote[] = [];
  let overlaps = 0;
  for (const current of notes) {
    active = active.filter((candidate) =>
      candidate.note.start + candidate.note.duration > current.note.start);
    for (const candidate of active) {
      if (candidate.trackId === current.trackId) continue;
      const [left, right] = candidate.ordinal < current.ordinal
        ? [candidate, current]
        : [current, candidate];
      overlaps += 1;
      visit(left, right);
    }
    active.push(current);
  }
  return overlaps;
}

const available = (
  score: number,
  explanation: string,
  source: Parameters<typeof evidence>[0],
  summary: string,
  observations: Record<string, string | number | boolean>,
): CandidateMusicCriticDimensionResult => ({
  status: "available",
  score: round(clamp(score)),
  evidence: [evidence(source, summary, observations)],
  explanation,
  findings: [],
});

const unavailable = (
  explanation: string,
  source: Parameters<typeof evidence>[0],
): CandidateMusicCriticDimensionResult => ({
  status: "unavailable",
  score: null,
  evidence: [evidence(source, explanation, {})],
  explanation,
  findings: [],
});

const failed = (
  explanation: string,
  source: Parameters<typeof evidence>[0],
): CandidateMusicCriticDimensionResult => ({
  status: "failed",
  score: null,
  evidence: [evidence(source, explanation, {})],
  explanation,
  findings: [],
});

function evidence(
  source:
    | "vocal_activity"
    | "harmony_decisions"
    | "section_plan"
    | "track_notes"
    | "instrument_constraints"
    | "style_and_directives"
    | "composition_intelligence"
    | "rhythm_evidence",
  summary: string,
  observations: Record<string, string | number | boolean>,
) {
  return { source, summary, observations };
}

function scoreVocalFit(
  songModel: SongModelData,
  tracks: TrackModel[],
): CandidateMusicCriticDimensionResult {
  const vocal = songModel.vocalEvidence;
  if (!vocal || vocal.status === "not_available") {
    return unavailable("Verified vocal activity evidence is unavailable.", "vocal_activity");
  }
  if (vocal.status === "failed") {
    return failed("Verified vocal activity analysis failed.", "vocal_activity");
  }
  if (!vocal.observedVoicedWindows.length) {
    return unavailable("No verified voiced windows were observed.", "vocal_activity");
  }
  const notes = tracks.flatMap((track) => track.notes);
  if (!notes.length) {
    return unavailable("Symbolic accompaniment notes are unavailable.", "track_notes");
  }
  const overlapsVocal = notes.filter((note) => vocal.observedVoicedWindows.some(
    (window) => note.start < window.end && note.start + note.duration > window.start,
  ));
  const busyHighNotes = overlapsVocal.filter((note) => note.pitch >= 60).length;
  const score = 1 - busyHighNotes / Math.max(1, overlapsVocal.length);
  return available(
    score,
    "Measures how often accompaniment leaves upper-register space during verified vocals.",
    "vocal_activity",
    "Compared accompaniment notes with verified voiced windows.",
    { voicedWindows: vocal.observedVoicedWindows.length, overlappingNotes: overlapsVocal.length, upperRegisterOverlaps: busyHighNotes },
  );
}

function scoreHarmony(
  decisions: HarmonyDecisionEvidence[],
  tracks: TrackModel[],
): CandidateMusicCriticDimensionResult {
  if (!decisions.length) {
    return unavailable("No harmony decision evidence was recorded.", "harmony_decisions");
  }
  const scored = decisions.filter((item) =>
    Number.isFinite(item.melodyFit) && Number.isFinite(item.bassFit));
  if (!scored.length) {
    return unavailable("Harmony decisions do not include melody and bass fit scores.", "harmony_decisions");
  }
  const evidenceFit = scored.reduce(
    (sum, item) => sum + ((item.melodyFit ?? 0) + (item.bassFit ?? 0)) / 2,
    0,
  ) / scored.length;
  const voicing = tracks.flatMap((track) =>
    track.harmonyEvidence?.mode === "advanced_voicing" &&
    Number.isFinite(track.harmonyEvidence.selectedMotion) &&
    Number.isFinite(track.harmonyEvidence.baselineMotion)
      ? [track.harmonyEvidence]
      : []);
  const improvedVoicings = voicing.filter((item) =>
    item.melodyEvidencePreserved &&
    item.bassEvidencePreserved &&
    (item.selectedMotion ?? Infinity) <= (item.baselineMotion ?? -Infinity)).length;
  const score = voicing.length
    ? evidenceFit * .8 + improvedVoicings / voicing.length * .2
    : evidenceFit;
  return available(
    score,
    "Combines observed melody and bass compatibility for recorded harmony choices.",
    "harmony_decisions",
    "Scored harmony choices with melody and bass evidence.",
    {
      scoredDecisions: scored.length,
      totalDecisions: decisions.length,
      measuredVoicingTracks: voicing.length,
      improvedVoicingTracks: improvedVoicings,
    },
  );
}

function scoreDevelopment(plan: ArrangementPlan): CandidateMusicCriticDimensionResult {
  if (plan.sections.length < 2) {
    return unavailable("At least two sections are needed to assess development.", "section_plan");
  }
  const energy = plan.sections.map((section) => section.energy);
  const density = plan.sections.map((section) => section.density);
  if ([...energy, ...density].some((value) => !Number.isFinite(value))) {
    return failed("Section energy or density evidence is malformed.", "section_plan");
  }
  const range = Math.max(
    Math.max(...energy) - Math.min(...energy),
    Math.max(...density) - Math.min(...density),
  );
  const changedBoundaries = plan.sections.slice(1).filter((section, index) =>
    Math.abs(section.energy - plan.sections[index].energy) >= 0.08 ||
    Math.abs(section.density - plan.sections[index].density) >= 0.08).length;
  return available(
    clamp(range * 1.5 + changedBoundaries / Math.max(1, plan.sections.length - 1) * 0.4),
    "Rewards an observable energy or density arc across sections.",
    "section_plan",
    "Compared section-level energy and density.",
    { sections: plan.sections.length, changedBoundaries, maximumRange: round(range) },
  );
}

function scoreContrast(plan: ArrangementPlan): CandidateMusicCriticDimensionResult {
  if (plan.sections.length < 2) {
    return unavailable("At least two sections are needed to assess contrast and transitions.", "section_plan");
  }
  const boundaries = plan.sections.slice(1).map((section, index) => {
    const previous = plan.sections[index];
    const previousTracks = new Set(previous.activeTracks ?? Object.keys(previous.tracks));
    const currentTracks = new Set(section.activeTracks ?? Object.keys(section.tracks));
    const changedTracks = new Set(
      [...previousTracks, ...currentTracks].filter((track) =>
        previousTracks.has(track) !== currentTracks.has(track)),
    ).size;
    const directives = Object.values(section.trackDirectives ?? {});
    return {
      contrast: clamp(
        Math.abs(section.energy - previous.energy) +
        Math.abs(section.density - previous.density) +
        changedTracks / Math.max(1, previousTracks.size + currentTracks.size),
      ),
      transition: directives.some((directive) =>
        Boolean(directive.transition || directive.entry || directive.exit || directive.fill)),
    };
  });
  const score = boundaries.reduce(
    (sum, boundary) => sum + clamp(boundary.contrast * 0.75 + (boundary.transition ? 0.25 : 0)),
    0,
  ) / boundaries.length;
  return available(
    score,
    "Measures section contrast and explicit transition intent at boundaries.",
    "section_plan",
    "Compared adjacent sections and their transition directives.",
    { boundaries: boundaries.length, explicitTransitions: boundaries.filter((item) => item.transition).length },
  );
}

function scoreRegisterCollisions(tracks: TrackModel[]): CandidateMusicCriticDimensionResult {
  if (!tracks.some((track) => track.notes.length)) {
    return unavailable("Symbolic note evidence is unavailable.", "track_notes");
  }
  let collisions = 0;
  const overlaps = forEachCrossTrackOverlap(tracks, (left, right) => {
    if (Math.abs(left.note.pitch - right.note.pitch) <= 2 &&
      !isExplicitDoubling(left, right, tracks)) collisions += 1;
  });
  return available(
    1 - collisions / Math.max(1, overlaps),
    "Penalizes close-register collisions between simultaneously active tracks.",
    "track_notes",
    "Compared overlapping notes across different tracks.",
    { crossTrackOverlaps: overlaps, closeRegisterCollisions: collisions },
  );
}

function scorePlayability(tracks: TrackModel[]): CandidateMusicCriticDimensionResult {
  const notes = tracks.flatMap((track) => track.notes.map((note) => ({ track, note })));
  if (!notes.length) return unavailable("Symbolic note evidence is unavailable.", "instrument_constraints");
  let violations = 0;
  for (const { track, note } of notes) {
    const definition = track.instrumentDefinition;
    if (!definition?.playableRange || !definition.constraints) {
      return failed("An instrument is missing required playability constraints.", "instrument_constraints");
    }
    if (
      note.pitch < definition.playableRange.min ||
      note.pitch > definition.playableRange.max ||
      note.duration < definition.constraints.minNoteDuration
    ) violations += 1;
  }
  return available(
    1 - violations / notes.length,
    "Checks rendered notes against instrument range and duration constraints.",
    "instrument_constraints",
    "Validated notes against canonical instrument constraints.",
    { notes: notes.length, violations },
  );
}

function scoreRepetition(tracks: TrackModel[]): CandidateMusicCriticDimensionResult {
  const notes = tracks.flatMap((track) => [...track.notes]
    .sort((a, b) => a.start - b.start)
    .map((note, index, sorted) => {
      const previous = sorted[index - 1];
      return `${previous ? note.pitch - previous.pitch : 0}:${round(note.duration)}`;
    }));
  if (notes.length < 4) return unavailable("Too few symbolic notes to assess repetition.", "track_notes");
  const uniqueRatio = new Set(notes).size / notes.length;
  const score = clamp(uniqueRatio * 1.5);
  return available(
    score,
    "Rewards recurring material without allowing one note-shape pattern to dominate.",
    "track_notes",
    "Compared interval and duration patterns across rendered parts.",
    { patterns: notes.length, uniquePatterns: new Set(notes).size },
  );
}

function scoreStyle(plan: ArrangementPlan, tracks: TrackModel[]): CandidateMusicCriticDimensionResult {
  if (!plan.sections.length) return failed("The evaluated arrangement has no sections.", "style_and_directives");
  const actualDensity = tracks.reduce((sum, track) => sum + track.notes.length, 0) /
    Math.max(1, plan.sections.length * Math.max(1, tracks.length) * 16);
  const densityFit = 1 - Math.abs(clamp(actualDensity) - plan.style.orchestration.density);
  const directives = plan.sections.flatMap((section) => Object.entries(section.trackDirectives ?? {}));
  const applied = directives.filter(([trackId, directive]) => {
    const track = tracks.find((item) => item.id === trackId);
    return track?.appliedDirectives?.some((item) =>
      item.section === plan.sections.find((section) =>
        section.trackDirectives?.[trackId] === directive)?.section);
  }).length;
  const directiveFit = directives.length ? applied / directives.length : 1;
  return available(
    densityFit * 0.6 + directiveFit * 0.4,
    "Measures rendered density and application of explicit orchestration controls.",
    "style_and_directives",
    "Compared the render with style density and recorded track directives.",
    { requestedDirectives: directives.length, appliedDirectives: applied, densityFit: round(densityFit) },
  );
}

/** v2 dimensions deliberately require the specific recorded capability they use. */
type IntelligenceIssue = {
  phraseId: string;
  sectionId: string;
  startBar: number;
  endBar: number;
  trackIds: string[];
  reason: string;
  actionable?: boolean;
};

function motifContinuityAssessment(plan: ArrangementPlan, tracks: TrackModel[]) {
  const intelligence = plan.compositionIntelligence;
  if (!intelligence?.phrases.length || !intelligence.motifs?.length) return null;
  const motifs = new Map(intelligence.motifs.map((motif) => [motif.id, motif]));
  const notes = tracks.flatMap((track) => track.notes.map((note) => ({ trackId: track.id, note })));
  const assessable = intelligence.phrases.filter((phrase) => {
    const motif = motifs.get(phrase.motifRef);
    return motif && notes.some(({ note }) =>
      note.motif?.id === motif.id && Boolean(note.motif.fingerprint));
  });
  if (!assessable.length) return null;
  const issues: IntelligenceIssue[] = [];
  for (const phrase of assessable) {
    const motif = motifs.get(phrase.motifRef)!;
    const rendered = notes.filter(({ note }) =>
      note.motif?.id === motif.id && note.motif.phraseId === phrase.id);
    const source = phrase.sourceMotifRef ? motifs.get(phrase.sourceMotifRef) : undefined;
    const selfRepetition = phrase.sourceMotifRef === phrase.motifRef &&
      phrase.transformation === "repetition" && motif.parentMotifId === null;
    const lineageValid = !phrase.sourceMotifRef || selfRepetition ||
      Boolean(source && motif.parentMotifId === source.id &&
        phrase.transformation === motif.transformation);
    const fingerprintValid = rendered.length > 0 &&
      rendered.every(({ note }) => note.motif?.fingerprint === motif.fingerprint);
    const sourceRendered = source
      ? notes.find(({ note }) => note.motif?.id === source.id)
      : undefined;
    const transformationValid = !source || !sourceRendered ||
      (phrase.transformation === "repetition"
        ? motif.fingerprint === source.fingerprint
        : motif.fingerprint !== source.fingerprint);
    if (!lineageValid || !fingerprintValid || !transformationValid) {
      issues.push({
        phraseId: phrase.id, sectionId: phrase.sectionId,
        startBar: phrase.startBar, endBar: phrase.endBar,
        trackIds: phrase.ownerTrackId ? [phrase.ownerTrackId] : rendered.map((item) => item.trackId),
        reason: `Phrase ${phrase.id} has inconsistent rendered motif lineage, fingerprint, or transformation evidence.`,
        // Parent/source identities and canonical motif records are immutable
        // evidence. A bounded notes/rhythm repair can only correct rendered
        // material whose tag/fingerprint disagrees with that evidence.
        actionable: lineageValid && transformationValid && !fingerprintValid,
      });
    }
  }
  return { total: assessable.length, issues };
}

function phraseIntentAssessment(plan: ArrangementPlan, tracks: TrackModel[]) {
  const intelligence = plan.compositionIntelligence;
  if (!intelligence?.phrases.length || !plan.hierarchy?.phrases.length) return null;
  const hierarchy = new Map(plan.hierarchy.phrases.map((phrase) => [phrase.id, phrase]));
  const issues: IntelligenceIssue[] = [];
  for (const phrase of intelligence.phrases) {
    const scope = hierarchy.get(phrase.id);
    const rendered = tracks.flatMap((track) => track.notes
      .filter((note) => note.motif?.phraseId === phrase.id)
      .map((note) => ({ trackId: track.id, note })));
    const scoped = Boolean(scope && scope.startBar === phrase.startBar && scope.endBar === phrase.endBar);
    const semantic = (phrase.intent === "protect_vocal" && phrase.intention === "silence" && rendered.length === 0) ||
      (phrase.intent === "develop" && phrase.transformation !== "repetition" && rendered.length > 0) ||
      (phrase.intent === "answer" && phrase.intention === "response" &&
        Boolean(phrase.responseToPhraseId) && rendered.length > 0) ||
      (["state", "build", "release"].includes(phrase.intent) &&
        phrase.intention !== "silence" && rendered.length > 0);
    if (!scoped || !semantic) issues.push({
      phraseId: phrase.id, sectionId: phrase.sectionId,
      startBar: phrase.startBar, endBar: phrase.endBar,
      trackIds: phrase.ownerTrackId ? [phrase.ownerTrackId] : rendered.map((item) => item.trackId),
      reason: `Phrase ${phrase.id} does not realize its declared intent within canonical phrase scope.`,
    });
  }
  return { total: intelligence.phrases.length, issues };
}

function scoreMotifContinuity(plan: ArrangementPlan, tracks: TrackModel[]): CandidateMusicCriticDimensionResult {
  const assessment = motifContinuityAssessment(plan, tracks);
  if (!assessment) {
    return unavailable("Motif and phrase lineage evidence is unavailable.", "composition_intelligence");
  }
  return available(1 - assessment.issues.length / assessment.total,
    "Validates recorded parent/source lineage, declared transformation, and rendered motif references.",
    "composition_intelligence", "Cross-checked phrase lineage with motif records and rendered motif tags.",
    { assessedPhrases: assessment.total, invalidRenderedLineages: assessment.issues.length });
}

function scorePhraseIntent(plan: ArrangementPlan, tracks: TrackModel[]): CandidateMusicCriticDimensionResult {
  const assessment = phraseIntentAssessment(plan, tracks);
  if (!assessment) {
    return unavailable("Canonical phrase intent evidence is unavailable.", "composition_intelligence");
  }
  return available(1 - assessment.issues.length / assessment.total,
    "Validates declared phrase intent, hierarchy scope, and rendered phrase references.",
    "composition_intelligence", "Matched phrase semantics and scope to rendered phrase tags.",
    { phrases: assessment.total, unrealizedPhrases: assessment.issues.length });
}

function vocalInteractionAssessment(songModel: SongModelData, plan: ArrangementPlan, tracks: TrackModel[]) {
  const vocal = songModel.vocalEvidence;
  const allPhrases = plan.compositionIntelligence?.phrases ?? [];
  const phrases = allPhrases.filter((phrase) =>
    phrase.intent === "protect_vocal" ||
    ((phrase.intent === "answer" || phrase.intention === "response") &&
      Boolean(phrase.responseToPhraseId &&
        allPhrases.some((candidate) => candidate.id === phrase.responseToPhraseId))));
  if (vocal?.status !== "detected" || !vocal.observedVoicedWindows.length || !phrases.length) return null;
  const timeline = createCanonicalTimeline(songModel.tempoMap, songModel.meterMap);
  const interactions = phrases.flatMap((phrase) => {
    const start = timeline.coordinateAtBar(phrase.startBar).seconds;
    const end = timeline.coordinateAtBar(phrase.endBar + 1).seconds;
    const windows = vocal.observedVoicedWindows.map((window) => ({
      start: Math.max(start, window.start),
      end: Math.min(end, window.end),
    })).filter((window) => window.end > window.start);
    return tracks.flatMap((track) => track.notes
      .filter((note) => note.start < end && note.start + note.duration > start)
      .flatMap((note) => windows.filter((window) =>
        note.start < window.end && note.start + note.duration > window.start)
        .map((window) => ({ phrase, track, note, window }))));
  }).sort((left, right) =>
    left.note.start - right.note.start ||
    left.track.id.localeCompare(right.track.id) ||
    left.phrase.id.localeCompare(right.phrase.id) ||
    left.note.id.localeCompare(right.note.id));
  return { phrases, interactions };
}

function scoreVocalInteraction(songModel: SongModelData, plan: ArrangementPlan, tracks: TrackModel[]) {
  const assessment = vocalInteractionAssessment(songModel, plan, tracks);
  if (!assessment) {
    return unavailable("Verified vocal interaction evidence is unavailable.", "vocal_activity");
  }
  const intrusive = assessment.interactions.filter(({ note }) => note.pitch >= 72).length;
  return available(1 - intrusive / Math.max(1, assessment.interactions.length),
    "Measures exact symbolic overlap during verified vocal windows under declared protect/respond phrases.",
    "vocal_activity", "Compared symbolic overlap with verified windows and phrase interaction declarations.",
    {
      voicedWindows: songModel.vocalEvidence!.observedVoicedWindows.length,
      interactionPhrases: assessment.phrases.length,
      overlappingNotes: assessment.interactions.length,
      intrusiveNotes: intrusive,
    });
}

function scoreRoleDuplication(plan: ArrangementPlan, tracks: TrackModel[]) {
  const hasFunctions = plan.sections.some((section) =>
    Object.values(section.trackDirectives ?? {}).some((directive) =>
      Boolean(directive.musicalFunction)));
  if (!hasFunctions || !tracks.length) {
    return unavailable("Recorded role directives are unavailable.", "style_and_directives");
  }
  let duplicate = 0;
  let pairs = 0;
  for (const section of plan.sections) {
    const active = (section.activeTracks ?? Object.keys(section.tracks)).filter((id) => tracks.some((track) => track.id === id));
    for (let i = 0; i < active.length; i += 1) for (let j = i + 1; j < active.length; j += 1) {
      const left = section.trackDirectives?.[active[i]]?.musicalFunction;
      const right = section.trackDirectives?.[active[j]]?.musicalFunction;
      if (!left || !right) continue;
      pairs += 1;
      const leftDirective = section.trackDirectives?.[active[i]];
      const rightDirective = section.trackDirectives?.[active[j]];
      const allowed = leftDirective?.musicalFunction === "doubling" && leftDirective.doublingTrackId === active[j] ||
        rightDirective?.musicalFunction === "doubling" && rightDirective.doublingTrackId === active[i];
      if (left && left === right && !allowed) duplicate += 1;
    }
  }
  return available(1 - duplicate / Math.max(1, pairs), "Penalizes duplicate explicit non-doubling roles.",
    "style_and_directives", "Compared declared musical functions within each section.",
    { comparedPairs: pairs, duplicateRoles: duplicate });
}

function scoreOrchestralBalance(plan: ArrangementPlan, tracks: TrackModel[]) {
  if (!plan.sections.length || !tracks.some((track) => track.notes.length)) return unavailable("Section and symbolic orchestration evidence is unavailable.", "track_notes");
  // Section directives are the evidence of which roles may carry density. Do
  // not infer mix balance from a whole-track count.
  const sections = plan.sections.filter((section) => (section.activeTracks ?? Object.keys(section.tracks)).length);
  const directiveSections = sections.filter((section) => Object.keys(section.trackDirectives ?? {}).length);
  if (!directiveSections.length) return unavailable("Per-section orchestration directives are unavailable.", "style_and_directives");
  const fits = directiveSections.map((section) => {
    const active = section.activeTracks ?? Object.keys(section.tracks);
    const counts = active.map((id) => tracks.find((track) => track.id === id)?.notes.filter((note) =>
      // Canonical bar localization is performed by findings; this coarse check
      // only admits notes rendered while a section directive is active.
      (tracks.find((track) => track.id === id)?.appliedDirectives ?? []).some((directive) =>
        directive.section === section.section && note.start >= directive.start && note.start < directive.end)).length ?? 0);
    const bars = section.endBar - section.startBar + 1;
    const target = clamp(section.density);
    const densityFit = counts.reduce((sum, count) =>
      sum + (1 - Math.abs(clamp(count / Math.max(1, bars * 4)) - target)), 0) /
      Math.max(1, counts.length);
    const functionCoverage = counts.filter((count) => count > 0).length / Math.max(1, counts.length);
    return densityFit * .7 + functionCoverage * .3;
  });
  const fit = fits.reduce((sum, value) => sum + value, 0) / fits.length;
  return available(fit, "Measures local function coverage and rendered density against each section target.",
    "style_and_directives", "Compared per-section active role density under recorded directives.",
    { directedSections: directiveSections.length, averageSectionDensityFit: round(fit) });
}

function reconcileRhythmEvidence(songModel: SongModelData) {
  const normalized = (songModel.rhythmEvidence ?? []).flatMap((item) => {
    const beats = item.beats.filter((beat) => Number.isFinite(beat) && beat >= 0)
      .sort((left, right) => left - right)
      .filter((beat, index, all) => index === 0 || beat - all[index - 1] > .001);
    return beats.length ? [{
      provider: item.provider.trim().toUpperCase(),
      version: item.version,
      beats,
      tempoBpm: item.tempoBpm,
    }] : [];
  }).sort((left, right) =>
    left.provider.localeCompare(right.provider) ||
    left.version.localeCompare(right.version) ||
    left.beats.join(",").localeCompare(right.beats.join(",")));
  if (!normalized.length) return null;
  if (normalized.length === 1) return normalized[0];

  // Beat This is the production beat/downbeat authority. Madmom remains the
  // deterministic secondary source when both are present.
  const providerPriority = new Map([
    ["BEAT_THIS", 0],
    ["BEAT-THIS", 0],
    ["MADMOM", 1],
  ]);
  const authoritative = normalized.filter((item) =>
    providerPriority.has(item.provider)).sort((left, right) =>
    providerPriority.get(left.provider)! - providerPriority.get(right.provider)! ||
    left.provider.localeCompare(right.provider) ||
    left.version.localeCompare(right.version));
  const consensus = (values: typeof normalized) => {
    const reference = values[0];
    const equivalent = values.every((item) => {
    if (item.beats.length !== reference.beats.length) return false;
    const tempoTolerance = Math.max(2, Math.abs(reference.tempoBpm) * .03);
    if (!Number.isFinite(item.tempoBpm) ||
      !Number.isFinite(reference.tempoBpm) ||
      Math.abs(item.tempoBpm - reference.tempoBpm) > tempoTolerance) return false;
    return item.beats.every((beat, index) =>
      Math.abs(beat - reference.beats[index]) <= .08);
    });
    if (!equivalent) return null;
    return {
      provider: "CONSENSUS",
      version: "1",
      beats: reference.beats.map((_, index) =>
        round(values.reduce((sum, item) => sum + item.beats[index], 0) /
          values.length)),
      tempoBpm: values.reduce((sum, item) => sum + item.tempoBpm, 0) /
        values.length,
    };
  };
  if (authoritative.length) {
    const priority = providerPriority.get(authoritative[0].provider)!;
    const peers = authoritative.filter((item) =>
      providerPriority.get(item.provider) === priority);
    return peers.length === 1 ? peers[0] : consensus(peers);
  }
  return consensus(normalized);
}

function grooveAssessment(songModel: SongModelData, plan: ArrangementPlan, tracks: TrackModel[]) {
  if (!songModel.rhythmEvidence?.length || !tracks.some((track) => track.notes.length)) return null;
  const rhythm = reconcileRhythmEvidence(songModel);
  if (!rhythm) return null;
  const beats = rhythm.beats;
  const roleIds = new Set([
    ...(plan.compositionIntelligence?.groove?.roles.map((role) => role.trackId) ?? []),
    ...(plan.compositionIntelligence?.instrumentRoles.filter((role) =>
      role.function === "foundation" || role.function === "pulse").map((role) => role.trackId) ?? []),
  ]);
  if (roleIds.size < 2) return null;
  const interval = beats.length > 1
    ? beats.slice(1).reduce((sum, beat, index) => sum + beat - beats[index], 0) / (beats.length - 1)
    : 60 / rhythm.tempoBpm;
  const subdivision = plan.compositionIntelligence?.groove?.subdivision === "16th" ? 4 : 2;
  const grid = beats.flatMap((beat) =>
    Array.from({ length: subdivision }, (_, index) => beat + interval * index / subdivision));
  const roleTracks = tracks.filter((track) => roleIds.has(track.id));
  const notes = roleTracks.flatMap((track) => track.notes.map((note) => ({ trackId: track.id, note })));
  if (!notes.length) return null;
  const assessed = notes.map(({ trackId, note }) => {
    const aligned = grid.some((point) => Math.abs(note.start - point) <= .08);
    const coordinated = notes.some((other) =>
      other.trackId !== trackId && Math.abs(other.note.start - note.start) <= interval / subdivision + .08);
    return { trackId, note, aligned, coordinated };
  });
  return { beats, interval, subdivision, roleIds, assessed,
    issues: assessed.filter((item) => !item.aligned || !item.coordinated) };
}

function scoreGroove(songModel: SongModelData, plan: ArrangementPlan, tracks: TrackModel[]) {
  const assessment = grooveAssessment(songModel, plan, tracks);
  if (!assessment) {
    return unavailable("Verified rhythm, rhythmic-role, and rendered attack evidence is unavailable.", "rhythm_evidence");
  }
  const aligned = assessment.assessed.filter((item) => item.aligned).length;
  const coordinated = assessment.assessed.filter((item) => item.coordinated).length;
  return available((aligned / assessment.assessed.length) * .7 + (coordinated / assessment.assessed.length) * .3,
    "Measures subdivision-aware attacks and phase interaction among recorded rhythmic roles.",
    "rhythm_evidence", "Compared bass/drum/pulse attacks with verified subdivisions and one another.",
    { beats: assessment.beats.length, rhythmicRoles: assessment.roleIds.size, attacks: assessment.assessed.length, alignedAttacks: aligned, coordinatedAttacks: coordinated });
}

function voiceLeadingAssessment(
  decisions: HarmonyDecisionEvidence[],
  plan: ArrangementPlan,
  tracks: TrackModel[],
) {
  const harmonyTrackIds = new Set(tracks.flatMap((track) => {
    const intelligenceRole = plan.compositionIntelligence?.instrumentRoles.find((role) =>
      role.trackId === track.id)?.function;
    const directiveRoles = plan.sections.flatMap((section) =>
      section.trackDirectives?.[track.id]?.musicalFunction ?? []);
    return intelligenceRole === "harmony" || intelligenceRole === "foundation" ||
      ["harmony", "harmonic_support", "foundation", "bass"].includes(track.role) ||
      directiveRoles.some((role) =>
        ["harmonic_support", "foundation"].includes(role))
      ? [track.id]
      : [];
  }));
  type HarmonicEvent = {
    time: number;
    pitches: number[];
    trackIds: string[];
  };
  const onsetTolerance = .01;
  const ordered = [...decisions].sort((left, right) =>
    left.start - right.start || left.end - right.end);
  let preceding: { event: HarmonicEvent; decision: HarmonyDecisionEvidence } | null = null;
  return ordered.map((decision) => {
    const timedNotes = tracks.filter((track) => harmonyTrackIds.has(track.id))
      .flatMap((track) => track.notes
        .filter((note) => note.start >= decision.start && note.start < decision.end)
        .map((note) => ({ trackId: track.id, note })))
      .sort((left, right) =>
        left.note.start - right.note.start ||
        left.note.pitch - right.note.pitch ||
        left.trackId.localeCompare(right.trackId) ||
        left.note.id.localeCompare(right.note.id));
    const events: HarmonicEvent[] = [];
    for (const { trackId, note } of timedNotes) {
      const current = events.at(-1);
      if (!current || Math.abs(note.start - current.time) > onsetTolerance) {
        events.push({ time: note.start, pitches: [note.pitch], trackIds: [trackId] });
      } else {
        current.pitches.push(note.pitch);
        if (!current.trackIds.includes(trackId)) current.trackIds.push(trackId);
      }
    }
    for (const event of events) {
      event.pitches.sort((left, right) => left - right);
      event.trackIds.sort();
    }
    const penalties: Array<{ penalty: number; time: number; trackIds: string[] }> = [];
    for (const event of events) {
      const adjacent = preceding && (
        preceding.decision === decision ||
        decision.start <= preceding.decision.end + onsetTolerance
      );
      if (adjacent) {
        const previous = preceding!.event;
        const voices = Math.min(previous.pitches.length, event.pitches.length);
        const horizontalMotion = voices
          ? Array.from({ length: voices }, (_, index) =>
              Math.abs(event.pitches[index] - previous.pitches[index]))
              .reduce((sum, value) => sum + value, 0) / voices
          : 24;
        const voiceCountLoss = Math.abs(event.pitches.length - previous.pitches.length) /
          Math.max(1, event.pitches.length, previous.pitches.length);
        penalties.push({
          penalty: clamp(horizontalMotion / 24 + voiceCountLoss * .25),
          time: event.time,
          trackIds: [...new Set([...previous.trackIds, ...event.trackIds])].sort(),
        });
      }
      preceding = { event, decision };
    }
    const worst = penalties.sort((left, right) =>
      right.penalty - left.penalty || left.time - right.time)[0];
    return {
      decision,
      trackIds: worst?.trackIds ?? events.flatMap((event) => event.trackIds)
        .filter((id, index, all) => all.indexOf(id) === index).sort(),
      derivedPenalty: worst?.penalty ?? null,
      transitionTime: worst?.time ?? null,
    };
  });
}

function scoreVoiceLeading(
  decisions: HarmonyDecisionEvidence[],
  plan: ArrangementPlan,
  tracks: TrackModel[],
) {
  const values = decisions.map((decision) => decision.voiceLeading).filter((value): value is number => Number.isFinite(value));
  if (!values.length) return unavailable("Recorded harmony voice-leading evidence is unavailable.", "harmony_decisions");
  const assessments = voiceLeadingAssessment(decisions, plan, tracks);
  const normalized = decisions.filter((decision) => Number.isFinite(decision.voiceLeading)).map((decision) => {
    const derived = assessments.find((item) => item.decision === decision)?.derivedPenalty;
    if (derived !== null && derived !== undefined) return clamp(1 - derived);
    const selectedPenalty = Math.abs(decision.voiceLeading!);
    const candidates = decision.candidateRationale?.map((candidate) =>
      Math.abs(candidate.voiceLeading)).filter(Number.isFinite) ?? [];
    const worstPenalty = Math.max(selectedPenalty, ...candidates, .001);
    const absolute = clamp(1 - selectedPenalty * 2);
    const comparative = clamp(1 - selectedPenalty / worstPenalty);
    return candidates.length ? absolute * .7 + comparative * .3 : absolute;
  });
  return available(normalized.reduce((sum, value) => sum + value, 0) / normalized.length,
    "Measures deterministic note motion inside recorded harmony decision windows.", "harmony_decisions",
    "Derived local register motion from final harmony-track notes, using recorded decisions as window evidence.",
    {
      decisions: values.length,
      derivedWindows: assessments.filter((item) => item.derivedPenalty !== null).length,
    });
}

function scoreCountermelody(plan: ArrangementPlan, tracks: TrackModel[]) {
  const roles = plan.compositionIntelligence?.instrumentRoles;
  const counter = roles?.filter((role) => role.function === "counterline") ?? [];
  if (!counter.length) return unavailable("Recorded countermelody role evidence is unavailable.", "composition_intelligence");
  const shaped = counter.filter((role) => {
    const notes = [...(tracks.find((track) => track.id === role.trackId)?.notes ?? [])].sort((a, b) => a.start - b.start);
    if (notes.length < 3) return false;
    const intervals = notes.slice(1).map((note, i) => note.pitch - notes[i].pitch);
    const contourChanges = intervals.slice(1).some((value, i) => Math.sign(value) !== Math.sign(intervals[i]));
    const range = Math.max(...notes.map((note) => note.pitch)) - Math.min(...notes.map((note) => note.pitch));
    return range >= 3 && contourChanges && new Set(intervals).size > 1;
  }).length;
  return available(shaped / counter.length, "Checks interval/rhythm contour and range for declared countermelody roles.",
    "composition_intelligence", "Measured scoped counterline interval contour rather than note count.", { declaredRoles: counter.length, shapedRoles: shaped });
}

function scoreDramaticTrajectory(plan: ArrangementPlan) {
  const tensions = plan.compositionIntelligence?.tensionRelease;
  if (!tensions?.length || !plan.hierarchy?.song.climaxSectionId) return unavailable("Recorded dramatic trajectory evidence is unavailable.", "composition_intelligence");
  const values = tensions.map((item) => item.tension).filter(Number.isFinite);
  if (!values.length) return unavailable("Recorded dramatic trajectory contains no finite tension values.", "composition_intelligence");
  const climax = tensions.find((item) => item.sectionId === plan.hierarchy!.song.climaxSectionId);
  if (!climax) return unavailable("Declared climax has no recorded tension event.", "composition_intelligence");
  const climaxIndex = tensions.indexOf(climax);
  const beforeClimax = tensions.slice(0, climaxIndex);
  const rises = beforeClimax.every((item, index, all) =>
    (index === 0 || item.tension >= all[index - 1].tension) && item.tension <= climax.tension);
  const releases = tensions.slice(climaxIndex + 1).every((item) => item.release >= climax.release || item.tension <= climax.tension);
  return available(rises && releases ? 1 : 0,
    "Measures range in recorded tension/release trajectory.", "composition_intelligence",
    "Aligned recorded tension/release events with the declared hierarchy climax.", { tensionEvents: values.length, riseToClimax: rises, releaseAfterClimax: releases });
}

function localizeCriticFindings(input: {
  songModel: SongModelData;
  plan: ArrangementPlan;
  tracks: TrackModel[];
  harmonyDecisions: HarmonyDecisionEvidence[];
  results: Record<CandidateMusicCriticDimension, CandidateMusicCriticDimensionResult>;
}) {
  const { songModel, plan, tracks, harmonyDecisions, results } = input;
  if (!plan.sections.length || !tracks.length) return;
  const timeline = createCanonicalTimeline(songModel.tempoMap, songModel.meterMap);
  const sectionAtTime = (time: number) => {
    const bar = timeline.coordinateAtSeconds(Math.max(0, time)).bar;
    return plan.sections.find((section) => bar >= section.startBar && bar <= section.endBar);
  };
  const trackIdsForSection = (section: ArrangementPlan["sections"][number]) => {
    const known = new Set(tracks.map((track) => track.id));
    return [...new Set(section.activeTracks ?? Object.keys(section.tracks))]
      .filter((trackId) => known.has(trackId))
      .sort();
  };
  const add = (
    dimension: CandidateMusicCriticDimension,
    section: ArrangementPlan["sections"][number] | undefined,
    trackIds: string[],
    startBar: number,
    endBar: number,
    musicalReason: string,
    affectedRoles?: string[],
  ) => {
    const result = results[dimension];
    const knownTracks = new Set(tracks.map((track) => track.id));
    const affectedTrackIds = [...new Set(trackIds)].filter((id) => knownTracks.has(id)).sort();
    if (result.status !== "available" || result.score === null || result.score >= 1 ||
      !section || !affectedTrackIds.length) return;
    const boundedStart = Math.max(section.startBar, startBar);
    const boundedEnd = Math.min(section.endBar, endBar);
    if (boundedEnd < boundedStart) return;
    // Different evidence may legitimately implicate overlapping bars. Only
    // suppress an identical canonical repair scope.
    const duplicateExisting = result.findings.some((existing) =>
      existing.startBar === boundedStart && existing.endBar === boundedEnd &&
      existing.affectedTrackIds.join(",") === affectedTrackIds.join(","));
    if (duplicateExisting) return;
    const finding: CriticRepairFinding = {
      id: [
          "music-critic-v2",
        dimension,
        section.section,
        `${boundedStart}-${boundedEnd}`,
        affectedTrackIds.join(","),
      ].join(":"),
      affectedSections: [section.section],
      startBar: boundedStart,
      endBar: boundedEnd,
      affectedTrackIds,
        affectedRoles: [...new Set(affectedRoles?.filter(Boolean) ?? affectedTrackIds.map((id) =>
          tracks.find((track) => track.id === id)!.role))].sort(),
        canonicalScope: { startBar: boundedStart, endBar: boundedEnd },
        evidenceReferences: result.evidence.slice(0, 1).map((item) => ({
          source: item.source,
          summary: item.summary,
        })),
        permissibleRepairOperations: ({
          motifContinuityAndDevelopment: ["adjust_notes", "adjust_rhythm"],
          phraseIntent: ["adjust_notes", "adjust_rhythm", "adjust_dynamics", "adjust_directive"],
          vocalInteraction: ["adjust_register", "adjust_dynamics", "adjust_notes"],
          roleDuplication: ["adjust_directive", "adjust_notes"],
          orchestralBalance: ["adjust_directive", "adjust_dynamics", "adjust_notes"],
          grooveCoordination: ["adjust_rhythm", "adjust_notes"],
          voiceLeading: ["adjust_voicing"],
          countermelodyShape: ["adjust_notes", "adjust_rhythm"],
          dramaticTrajectory: ["adjust_notes", "adjust_dynamics", "adjust_directive"],
          harmony: ["adjust_voicing", "adjust_notes"],
          vocalFit: ["adjust_register", "adjust_dynamics", "adjust_notes"],
        } as Partial<Record<CandidateMusicCriticDimension, Array<
          "adjust_notes" | "adjust_rhythm" | "adjust_register" | "adjust_dynamics" | "adjust_voicing" | "adjust_directive"
        >>>)[dimension]
          ?? ["adjust_notes", "adjust_directive"],
      musicalReason,
    };
    result.findings.push(finding);
  };

  const vocalIssues = tracks.flatMap((track) => track.notes.map((note) => ({ track, note })))
    .filter(({ note }) => note.pitch >= 60 && songModel.vocalEvidence?.observedVoicedWindows.some(
      (window) => note.start < window.end && note.start + note.duration > window.start,
    ))
    .sort((left, right) => left.note.start - right.note.start || left.track.id.localeCompare(right.track.id));
  for (const vocalIssue of vocalIssues) {
    const section = sectionAtTime(vocalIssue.note.start);
    const bar = timeline.coordinateAtSeconds(vocalIssue.note.start).bar;
    add("vocalFit", section, [vocalIssue.track.id], bar, bar,
      `${vocalIssue.track.instrument} enters the upper register during verified vocal activity.`);
  }

  const localizedHarmony = harmonyDecisions
    .filter((decision) => Number.isFinite(decision.melodyFit) && Number.isFinite(decision.bassFit))
    .sort((left, right) =>
      ((left.melodyFit ?? 0) + (left.bassFit ?? 0)) -
      ((right.melodyFit ?? 0) + (right.bassFit ?? 0)) ||
      left.start - right.start);
  for (const harmony of localizedHarmony) {
    const section = sectionAtTime(harmony.start);
    const startBar = timeline.coordinateAtSeconds(harmony.start).bar;
    const endBar = timeline.coordinateAtSeconds(Math.max(harmony.start, harmony.end - 0.001)).bar;
    if (section) add("harmony", section, trackIdsForSection(section), startBar, endBar,
      `${harmony.symbol} has weak combined melody and bass fit in ${section.section}.`);
  }

  for (const section of [...plan.sections]
    .sort((left, right) =>
      left.energy + left.density - right.energy - right.density ||
      left.startBar - right.startBar)) {
    add("development", section, trackIdsForSection(section),
      section.startBar, section.endBar,
      `${section.section} has weak energy and density development.`);
  }

  const boundaries = plan.sections.slice(1).map((section, index) => {
    const previous = plan.sections[index];
    return {
      section,
      difference: Math.abs(section.energy - previous.energy) + Math.abs(section.density - previous.density),
    };
  }).sort((left, right) => left.difference - right.difference || left.section.startBar - right.section.startBar);
  for (const boundary of boundaries) {
    add(
      "contrastAndTransitions",
      boundary.section,
      trackIdsForSection(boundary.section),
      boundary.section.startBar,
      boundary.section.startBar,
      `The entry into ${boundary.section.section} has weak energy and density contrast.`,
    );
  }

  type LocalizedCollision = {
    leftTrackId: string;
    rightTrackId: string;
    time: number;
    section: ArrangementPlan["sections"][number];
    bar: number;
  };
  const collisionsByRange = new Map<string, LocalizedCollision>();
  const compareCollisions = (left: LocalizedCollision, right: LocalizedCollision) =>
    left.time - right.time ||
    left.leftTrackId.localeCompare(right.leftTrackId) ||
    left.rightTrackId.localeCompare(right.rightTrackId);
  forEachCrossTrackOverlap(tracks, (left, right) => {
    if (Math.abs(left.note.pitch - right.note.pitch) > 2) return;
    if (isExplicitDoubling(left, right, tracks)) return;
    const time = Math.max(left.note.start, right.note.start);
    const section = sectionAtTime(time);
    if (!section) return;
    const bar = timeline.coordinateAtSeconds(time).bar;
    const collision: LocalizedCollision = {
      leftTrackId: left.trackId,
      rightTrackId: right.trackId,
      time,
      section,
      bar,
    };
    const rangeKey = `${section.section}:${bar}`;
    const existing = collisionsByRange.get(rangeKey);
    if (!existing || compareCollisions(collision, existing) < 0) {
      collisionsByRange.set(rangeKey, collision);
    }
  });
  const collisions = [...collisionsByRange.values()].sort(compareCollisions);
  for (const collision of collisions) {
    add("registerCollisions", collision.section,
      [collision.leftTrackId, collision.rightTrackId], collision.bar, collision.bar,
      "These two parts overlap within two semitones, creating a close-register collision.");
  }

  const violations = tracks.flatMap((track) => track.notes.map((note) => ({ track, note })))
    .filter(({ track, note }) => {
      const definition = track.instrumentDefinition;
      return definition?.playableRange && definition.constraints && (
        note.pitch < definition.playableRange.min ||
        note.pitch > definition.playableRange.max ||
        note.duration < definition.constraints.minNoteDuration
      );
    })
    .sort((left, right) => left.note.start - right.note.start || left.track.id.localeCompare(right.track.id));
  for (const violation of violations) {
    const section = sectionAtTime(violation.note.start);
    const bar = timeline.coordinateAtSeconds(violation.note.start).bar;
    add("playability", section, [violation.track.id], bar, bar,
      `${violation.track.instrument} contains a note outside its playable range or minimum duration.`);
  }

  const repetitiveTracks = tracks.filter((track) => track.notes.length >= 4).map((track) => {
    const patterns = [...track.notes].sort((a, b) => a.start - b.start)
      .map((note, index, sorted) =>
        `${index ? note.pitch - sorted[index - 1].pitch : 0}:${round(note.duration)}`);
    return { track, ratio: new Set(patterns).size / patterns.length };
  }).sort((left, right) => left.ratio - right.ratio || left.track.id.localeCompare(right.track.id));
  for (const repetitiveTrack of repetitiveTracks) {
    const firstNote = [...repetitiveTrack.track.notes].sort((a, b) => a.start - b.start)[0];
    const section = sectionAtTime(firstNote.start);
    if (section) add("repetition", section, [repetitiveTrack.track.id],
      section.startBar, section.endBar,
      `${repetitiveTrack.track.instrument} has the least varied interval and duration pattern.`);
  }

  const directiveIssues = plan.sections.flatMap((section) =>
    Object.keys(section.trackDirectives ?? {}).map((trackId) => ({ section, trackId })))
    .filter(({ section, trackId }) => !tracks.find((track) => track.id === trackId)
      ?.appliedDirectives?.some((directive) => directive.section === section.section))
    .sort((left, right) => left.section.startBar - right.section.startBar ||
      left.trackId.localeCompare(right.trackId));
  if (directiveIssues.length) {
    for (const directiveIssue of directiveIssues) {
      add("styleAndControlAdherence", directiveIssue.section, [directiveIssue.trackId],
        directiveIssue.section.startBar, directiveIssue.section.endBar,
        `${directiveIssue.trackId} did not apply its orchestration directive in ${directiveIssue.section.section}.`);
    }
  } else {
    for (const section of plan.sections) {
      add("styleAndControlAdherence", section, trackIdsForSection(section),
        section.startBar, section.endBar,
        `${section.section} contributes to the mismatch between rendered and requested density.`);
    }
  }

  const intelligence = plan.compositionIntelligence;
  const hierarchySections = new Map(plan.hierarchy?.sections.map((section) => [section.id, section]) ?? []);
  for (const issue of motifContinuityAssessment(plan, tracks)?.issues.filter((item) => item.actionable) ?? []) {
    const hierarchySection = hierarchySections.get(issue.sectionId);
    const section = hierarchySection && plan.sections.find((item) => item.section === hierarchySection.sourceSection);
    if (!section) continue;
    add("motifContinuityAndDevelopment", section,
      issue.trackIds.length ? issue.trackIds : trackIdsForSection(section),
      issue.startBar, issue.endBar, issue.reason);
  }
  for (const issue of phraseIntentAssessment(plan, tracks)?.issues ?? []) {
    const hierarchySection = hierarchySections.get(issue.sectionId);
    const section = hierarchySection && plan.sections.find((item) => item.section === hierarchySection.sourceSection);
    if (!section) continue;
    add("phraseIntent", section, issue.trackIds.length ? issue.trackIds : trackIdsForSection(section),
      issue.startBar, issue.endBar, issue.reason);
  }
  for (const section of plan.sections) {
    const active = trackIdsForSection(section);
    for (let index = 0; index < active.length; index += 1) {
      for (const other of active.slice(index + 1)) {
        const left = section.trackDirectives?.[active[index]]?.musicalFunction;
        const right = section.trackDirectives?.[other]?.musicalFunction;
        const leftDirective = section.trackDirectives?.[active[index]];
        const rightDirective = section.trackDirectives?.[other];
        const permittedDoubling = leftDirective?.musicalFunction === "doubling" &&
          leftDirective.doublingTrackId === other ||
          rightDirective?.musicalFunction === "doubling" &&
          rightDirective.doublingTrackId === active[index];
        if (left && left === right && !permittedDoubling) add("roleDuplication", section, [active[index], other],
          section.startBar, section.endBar, `${active[index]} and ${other} duplicate the declared ${left} role.`, [left]);
      }
    }
    if (!Object.keys(section.trackDirectives ?? {}).length) continue;
    const counts = active.map((id) => {
      const track = tracks.find((candidate) => candidate.id === id);
      const windows = track?.appliedDirectives?.filter((directive) =>
        directive.section === section.section) ?? [];
      return {
        id,
        count: track?.notes.filter((note) => windows.some((window) =>
          note.start >= window.start && note.start < window.end)).length ?? 0,
      };
    });
    const bars = section.endBar - section.startBar + 1;
    const fits = counts.map((item) => ({
      ...item,
      fit: item.count
        ? 1 - Math.abs(clamp(item.count / Math.max(1, bars * 4)) - clamp(section.density))
        : 0,
    }));
    const weakest = Math.min(...fits.map((item) => item.fit), 1);
    if (weakest < 1) add("orchestralBalance", section,
      fits.filter((item) => item.fit === weakest).map((item) => item.id),
      section.startBar, section.endBar,
      `${section.section} has a role whose local density or function coverage misses the section target.`);
  }
  for (const issue of grooveAssessment(songModel, plan, tracks)?.issues ?? []) {
    const section = sectionAtTime(issue.note.start);
    const bar = timeline.coordinateAtSeconds(issue.note.start).bar;
    add("grooveCoordination", section, [issue.trackId], bar, bar,
      `${issue.trackId} has an off-subdivision or uncoordinated rhythmic-role attack.`);
  }
  for (const role of intelligence?.instrumentRoles.filter((item) => item.function === "counterline") ?? []) {
    const track = tracks.find((item) => item.id === role.trackId);
    if (!track) continue;
    const sorted = [...track.notes].sort((left, right) => left.start - right.start);
    const intervals = sorted.slice(1).map((note, index) => note.pitch - sorted[index].pitch);
    const contourChanges = intervals.slice(1).some((value, index) =>
      Math.sign(value) !== Math.sign(intervals[index]));
    const range = sorted.length
      ? Math.max(...sorted.map((note) => note.pitch)) - Math.min(...sorted.map((note) => note.pitch))
      : 0;
    if (sorted.length >= 3 && range >= 3 && contourChanges && new Set(intervals).size > 1) continue;
    const note = sorted[0];
    const phrase = intelligence?.phrases.find((candidate) =>
      candidate.ownerTrackId === track.id && (candidate.intent === "answer" ||
        candidate.intention === "response" || candidate.intention === "foreground"));
    const hierarchySection = phrase && hierarchySections.get(phrase.sectionId);
    const section = hierarchySection
      ? plan.sections.find((candidate) => candidate.section === hierarchySection.sourceSection)
      : note && sectionAtTime(note.start);
    if (section) add("countermelodyShape", section, [track.id],
      phrase?.startBar ?? timeline.coordinateAtSeconds(note!.start).bar,
      phrase?.endBar ?? timeline.coordinateAtSeconds(note!.start).bar,
      `${track.instrument} does not realize the declared counterline contour in this phrase.`);
  }
  const tensions = intelligence?.tensionRelease ?? [];
  const climaxIndex = tensions.findIndex((item) => item.sectionId === plan.hierarchy?.song.climaxSectionId);
  const dramaticIssues = tensions.filter((tension, index) => {
    if (climaxIndex < 0) return false;
    if (index < climaxIndex) {
      const previous = tensions[index - 1];
      const climax = tensions[climaxIndex];
      return tension.tension > climax.tension || Boolean(previous && tension.tension < previous.tension);
    }
    if (index === climaxIndex) {
      return tensions.some((item, other) => other !== index && item.tension > tension.tension);
    }
    const previous = tensions[index - 1];
    return tension.tension > previous.tension && tension.release <= previous.release;
  });
  for (const tension of dramaticIssues) {
    const source = hierarchySections.get(tension.sectionId)?.sourceSection;
    const section = plan.sections.find((item) => item.section === source);
    if (section) add("dramaticTrajectory", section, trackIdsForSection(section), section.startBar, section.endBar,
      `${section.section} violates the declared rise, climax, or post-climax release.`);
  }
  const vocalInteractionIssues = vocalInteractionAssessment(songModel, plan, tracks)
    ?.interactions.filter(({ note }) => note.pitch >= 72) ?? [];
  for (const issue of vocalInteractionIssues) {
    const intersectionStart = Math.max(issue.note.start, issue.window.start);
    const intersectionEnd = Math.min(issue.note.start + issue.note.duration, issue.window.end);
    const section = sectionAtTime(intersectionStart);
    if (!section) continue;
    const sectionStart = timeline.coordinateAtBar(section.startBar).seconds;
    const sectionEnd = timeline.coordinateAtBar(section.endBar + 1).seconds;
    if (issue.note.start < sectionStart || issue.note.start + issue.note.duration > sectionEnd) {
      // Boundary-crossing events are immutable under bounded repair. They
      // remain part of score/evidence, but must not become impossible repair
      // contracts.
      continue;
    }
    const startBar = timeline.coordinateAtSeconds(intersectionStart).bar;
    const endBar = timeline.coordinateAtSeconds(
      Math.max(intersectionStart, intersectionEnd - .001),
    ).bar;
    add("vocalInteraction", section, [issue.track.id], startBar, endBar,
      `${issue.track.instrument} masks verified vocal activity in the upper register.`);
  }
  for (const assessment of voiceLeadingAssessment(harmonyDecisions, plan, tracks)
    .filter(({ decision, derivedPenalty }) =>
      Number.isFinite(decision.voiceLeading) &&
      (derivedPenalty ?? Math.abs(decision.voiceLeading!)) > .175)
    .sort((left, right) =>
      (right.derivedPenalty ?? Math.abs(right.decision.voiceLeading!)) -
        (left.derivedPenalty ?? Math.abs(left.decision.voiceLeading!)) ||
      left.decision.start - right.decision.start)) {
    const decision = assessment.decision;
    const transitionTime = assessment.transitionTime ?? decision.start;
    const section = sectionAtTime(transitionTime);
    const bar = timeline.coordinateAtSeconds(transitionTime).bar;
    const voicingTracks = assessment.trackIds.length ? assessment.trackIds : section ? trackIdsForSection(section).filter((id) => {
      const track = tracks.find((candidate) => candidate.id === id)!;
      const role = section.trackDirectives?.[id]?.musicalFunction ?? track.role;
      return track.harmonyEvidence?.mode === "advanced_voicing" ||
        ["harmony", "harmonic_support", "foundation", "bass"].includes(role);
    }) : [];
    if (section) add("voiceLeading", section, voicingTracks, bar, bar,
      `${decision.symbol} has weak recorded voice-leading evidence.`);
  }
}

export function evaluateCandidateMusicalFit(input: {
  songModel: SongModelData;
  plan: ArrangementPlan;
  tracks: TrackModel[];
  harmonyDecisions: HarmonyDecisionEvidence[];
}): CandidateMusicCriticReportV2 {
  const results: Record<CandidateMusicCriticDimension, CandidateMusicCriticDimensionResult> = {
    vocalFit: scoreVocalFit(input.songModel, input.tracks),
    harmony: scoreHarmony(input.harmonyDecisions, input.tracks),
    development: scoreDevelopment(input.plan),
    contrastAndTransitions: scoreContrast(input.plan),
    registerCollisions: scoreRegisterCollisions(input.tracks),
    playability: scorePlayability(input.tracks),
    repetition: scoreRepetition(input.tracks),
    styleAndControlAdherence: scoreStyle(input.plan, input.tracks),
    motifContinuityAndDevelopment: scoreMotifContinuity(input.plan, input.tracks),
    phraseIntent: scorePhraseIntent(input.plan, input.tracks),
    vocalInteraction: scoreVocalInteraction(input.songModel, input.plan, input.tracks),
    roleDuplication: scoreRoleDuplication(input.plan, input.tracks),
    orchestralBalance: scoreOrchestralBalance(input.plan, input.tracks),
    grooveCoordination: scoreGroove(input.songModel, input.plan, input.tracks),
    voiceLeading: scoreVoiceLeading(input.harmonyDecisions, input.plan, input.tracks),
    countermelodyShape: scoreCountermelody(input.plan, input.tracks),
    dramaticTrajectory: scoreDramaticTrajectory(input.plan),
  };
  localizeCriticFindings({ ...input, results });
  const scored = dimensions.filter((name) => results[name].status === "available");
  const totalWeight = scored.reduce((sum, name) => sum + weights[name], 0);
  const score = totalWeight
    ? scored.reduce((sum, name) => sum + (results[name].score ?? 0) * weights[name], 0) / totalWeight
    : 0;
  return {
    version: "music-critic-v2",
    score: round(score),
    coverage: {
      availableDimensions: scored.length,
      totalDimensions: dimensions.length,
      sparse: scored.length < dimensions.length / 2,
    },
    dimensions: results,
  };
}

export const musicCriticDimensions = dimensions;
