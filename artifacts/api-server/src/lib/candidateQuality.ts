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
): CandidateMusicCriticDimensionResult {
  if (!decisions.length) {
    return unavailable("No harmony decision evidence was recorded.", "harmony_decisions");
  }
  const scored = decisions.filter((item) =>
    Number.isFinite(item.melodyFit) && Number.isFinite(item.bassFit));
  if (!scored.length) {
    return unavailable("Harmony decisions do not include melody and bass fit scores.", "harmony_decisions");
  }
  const score = scored.reduce(
    (sum, item) => sum + ((item.melodyFit ?? 0) + (item.bassFit ?? 0)) / 2,
    0,
  ) / scored.length;
  return available(
    score,
    "Combines observed melody and bass compatibility for recorded harmony choices.",
    "harmony_decisions",
    "Scored harmony choices with melody and bass evidence.",
    { scoredDecisions: scored.length, totalDecisions: decisions.length },
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
  const notes = tracks.flatMap((track) => track.notes.map((note) => ({ ...note, trackId: track.id })));
  if (!notes.length) return unavailable("Symbolic note evidence is unavailable.", "track_notes");
  let overlaps = 0;
  let collisions = 0;
  for (let left = 0; left < notes.length; left += 1) {
    for (let right = left + 1; right < notes.length; right += 1) {
      if (notes[left].trackId === notes[right].trackId) continue;
      if (
        notes[left].start < notes[right].start + notes[right].duration &&
        notes[right].start < notes[left].start + notes[left].duration
      ) {
        overlaps += 1;
        if (Math.abs(notes[left].pitch - notes[right].pitch) <= 2) collisions += 1;
      }
    }
  }
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

  const vocalIssue = tracks.flatMap((track) => track.notes.map((note) => ({ track, note })))
    .find(({ note }) => note.pitch >= 60 && songModel.vocalEvidence?.observedVoicedWindows.some(
      (window) => note.start < window.end && note.start + note.duration > window.start,
    ));
  if (vocalIssue) {
    const section = sectionAtTime(vocalIssue.note.start);
    const bar = timeline.coordinateAtSeconds(vocalIssue.note.start).bar;
    add("vocalFit", section, [vocalIssue.track.id], bar, bar,
      `${vocalIssue.track.instrument} enters the upper register during verified vocal activity.`);
  }

  const weakestHarmony = harmonyDecisions
    .filter((decision) => Number.isFinite(decision.melodyFit) && Number.isFinite(decision.bassFit))
    .sort((left, right) =>
      ((left.melodyFit ?? 0) + (left.bassFit ?? 0)) -
      ((right.melodyFit ?? 0) + (right.bassFit ?? 0)))[0];
  if (weakestHarmony) {
    const section = sectionAtTime(weakestHarmony.start);
    const startBar = timeline.coordinateAtSeconds(weakestHarmony.start).bar;
    const endBar = timeline.coordinateAtSeconds(Math.max(weakestHarmony.start, weakestHarmony.end - 0.001)).bar;
    if (section) add("harmony", section, trackIdsForSection(section), startBar, endBar,
      `${weakestHarmony.symbol} has the weakest combined melody and bass fit in ${section.section}.`);
  }

  const developmentSection = [...plan.sections]
    .sort((left, right) => left.energy + left.density - right.energy - right.density)[0];
  add("development", developmentSection, developmentSection && trackIdsForSection(developmentSection),
    developmentSection?.startBar ?? 1, developmentSection?.endBar ?? 1,
    developmentSection
      ? `${developmentSection.section} has the arrangement's weakest energy and density development.`
      : "");

  const weakestBoundary = plan.sections.slice(1).map((section, index) => {
    const previous = plan.sections[index];
    return {
      section,
      difference: Math.abs(section.energy - previous.energy) + Math.abs(section.density - previous.density),
    };
  }).sort((left, right) => left.difference - right.difference)[0];
  if (weakestBoundary) add(
    "contrastAndTransitions",
    weakestBoundary.section,
    trackIdsForSection(weakestBoundary.section),
    weakestBoundary.section.startBar,
    weakestBoundary.section.startBar,
    `The entry into ${weakestBoundary.section.section} has the least energy and density contrast.`,
  );

  let collision: { leftTrackId: string; rightTrackId: string; time: number } | undefined;
  const notes = tracks.flatMap((track) => track.notes.map((note) => ({ trackId: track.id, note })));
  for (let left = 0; left < notes.length && !collision; left += 1) {
    for (let right = left + 1; right < notes.length; right += 1) {
      if (notes[left].trackId !== notes[right].trackId &&
        notes[left].note.start < notes[right].note.start + notes[right].note.duration &&
        notes[right].note.start < notes[left].note.start + notes[left].note.duration &&
        Math.abs(notes[left].note.pitch - notes[right].note.pitch) <= 2) {
        collision = {
          leftTrackId: notes[left].trackId,
          rightTrackId: notes[right].trackId,
          time: Math.max(notes[left].note.start, notes[right].note.start),
        };
        break;
      }
    }
  }
  if (collision) {
    const section = sectionAtTime(collision.time);
    const bar = timeline.coordinateAtSeconds(collision.time).bar;
    add("registerCollisions", section, [collision.leftTrackId, collision.rightTrackId], bar, bar,
      "These two parts overlap within two semitones, creating a close-register collision.");
  }

  const violation = tracks.flatMap((track) => track.notes.map((note) => ({ track, note })))
    .find(({ track, note }) => {
      const definition = track.instrumentDefinition;
      return definition?.playableRange && definition.constraints && (
        note.pitch < definition.playableRange.min ||
        note.pitch > definition.playableRange.max ||
        note.duration < definition.constraints.minNoteDuration
      );
    });
  if (violation) {
    const section = sectionAtTime(violation.note.start);
    const bar = timeline.coordinateAtSeconds(violation.note.start).bar;
    add("playability", section, [violation.track.id], bar, bar,
      `${violation.track.instrument} contains a note outside its playable range or minimum duration.`);
  }

  const repetitiveTrack = tracks.filter((track) => track.notes.length >= 4).map((track) => {
    const patterns = [...track.notes].sort((a, b) => a.start - b.start)
      .map((note, index, sorted) =>
        `${index ? note.pitch - sorted[index - 1].pitch : 0}:${round(note.duration)}`);
    return { track, ratio: new Set(patterns).size / patterns.length };
  }).sort((left, right) => left.ratio - right.ratio)[0];
  if (repetitiveTrack) {
    const firstNote = [...repetitiveTrack.track.notes].sort((a, b) => a.start - b.start)[0];
    const section = sectionAtTime(firstNote.start);
    if (section) add("repetition", section, [repetitiveTrack.track.id],
      section.startBar, section.endBar,
      `${repetitiveTrack.track.instrument} has the least varied interval and duration pattern.`);
  }

  const directiveIssue = plan.sections.flatMap((section) =>
    Object.keys(section.trackDirectives ?? {}).map((trackId) => ({ section, trackId })))
    .find(({ section, trackId }) => !tracks.find((track) => track.id === trackId)
      ?.appliedDirectives?.some((directive) => directive.section === section.section));
  const styleSection = directiveIssue?.section ?? plan.sections[0];
  add("styleAndControlAdherence", styleSection,
    directiveIssue ? [directiveIssue.trackId] : trackIdsForSection(styleSection),
    styleSection.startBar, styleSection.endBar,
    directiveIssue
      ? `${directiveIssue.trackId} did not apply its orchestration directive in ${styleSection.section}.`
      : `${styleSection.section} contributes to the mismatch between rendered and requested density.`);
}

export function evaluateCandidateMusicalFit(input: {
  songModel: SongModelData;
  plan: ArrangementPlan;
  tracks: TrackModel[];
  harmonyDecisions: HarmonyDecisionEvidence[];
}): CandidateMusicCriticReport {
  const results: Record<CandidateMusicCriticDimension, CandidateMusicCriticDimensionResult> = {
    vocalFit: scoreVocalFit(input.songModel, input.tracks),
    harmony: scoreHarmony(input.harmonyDecisions),
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