import type {
  ArrangementPlan,
  CandidateMusicCriticDimension,
  CandidateMusicCriticDimensionResult,
  CandidateMusicCriticReport,
  HarmonyDecisionEvidence,
  SongModelData,
  TrackModel,
} from "@workspace/db";

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
});

const unavailable = (
  explanation: string,
  source: Parameters<typeof evidence>[0],
): CandidateMusicCriticDimensionResult => ({
  status: "unavailable",
  score: null,
  evidence: [evidence(source, explanation, {})],
  explanation,
});

const failed = (
  explanation: string,
  source: Parameters<typeof evidence>[0],
): CandidateMusicCriticDimensionResult => ({
  status: "failed",
  score: null,
  evidence: [evidence(source, explanation, {})],
  explanation,
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
  const scored = dimensions.filter((name) => results[name].status === "available");
  const totalWeight = scored.reduce((sum, name) => sum + weights[name], 0);
  const score = totalWeight
    ? scored.reduce((sum, name) => sum + (results[name].score ?? 0) * weights[name], 0) / totalWeight
    : 0;
  return { version: "music-critic-v1", score: round(score), dimensions: results };
}

export const musicCriticDimensions = dimensions;