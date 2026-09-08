import type {
  ArrangementPlan,
  CandidateMusicCriticDimension,
  CandidateMusicCriticDimensionResult,
  CandidateMusicCriticReport,
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
    | "style_and_directives",
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
  ) => {
    const result = results[dimension];
    const knownTracks = new Set(tracks.map((track) => track.id));
    const affectedTrackIds = [...new Set(trackIds)].filter((id) => knownTracks.has(id)).sort();
    if (result.status !== "available" || result.score === null || result.score >= 1 ||
      !section || !affectedTrackIds.length) return;
    const boundedStart = Math.max(section.startBar, startBar);
    const boundedEnd = Math.min(section.endBar, endBar);
    if (boundedEnd < boundedStart) return;
    const overlapsExisting = result.findings.some((existing) =>
      boundedStart <= existing.endBar && existing.startBar <= boundedEnd);
    if (overlapsExisting) return;
    const finding: CriticRepairFinding = {
      id: [
        "music-critic-v1",
        dimension,
        section.section,
        `${boundedStart}-${boundedEnd}`,
        affectedTrackIds.join(","),
      ].join(":"),
      affectedSections: [section.section],
      startBar: boundedStart,
      endBar: boundedEnd,
      affectedTrackIds,
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
}

export function evaluateCandidateMusicalFit(input: {
  songModel: SongModelData;
  plan: ArrangementPlan;
  tracks: TrackModel[];
  harmonyDecisions: HarmonyDecisionEvidence[];
}): CandidateMusicCriticReport {
  const results: Record<CandidateMusicCriticDimension, CandidateMusicCriticDimensionResult> = {
    vocalFit: scoreVocalFit(input.songModel, input.tracks),
    harmony: scoreHarmony(input.harmonyDecisions, input.tracks),
    development: scoreDevelopment(input.plan),
    contrastAndTransitions: scoreContrast(input.plan),
    registerCollisions: scoreRegisterCollisions(input.tracks),
    playability: scorePlayability(input.tracks),
    repetition: scoreRepetition(input.tracks),
    styleAndControlAdherence: scoreStyle(input.plan, input.tracks),
  };
  localizeCriticFindings({ ...input, results });
  const scored = dimensions.filter((name) => results[name].status === "available");
  const totalWeight = scored.reduce((sum, name) => sum + weights[name], 0);
  const score = totalWeight
    ? scored.reduce((sum, name) => sum + (results[name].score ?? 0) * weights[name], 0) / totalWeight
    : 0;
  return {
    version: "music-critic-v1",
    score: round(score),
    coverage: {
      availableDimensions: scored.length,
      totalDimensions: 8,
      sparse: scored.length < dimensions.length / 2,
    },
    dimensions: results,
  };
}

export const musicCriticDimensions = dimensions;
