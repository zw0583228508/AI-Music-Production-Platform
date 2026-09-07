import type {
  ProviderFusionDecision,
  SongModelCore,
  SongModelData,
  SongModelValidationIssue,
} from "@workspace/db";
import { createCanonicalTimeline, type CanonicalCoordinate } from "./canonicalTimeline";

export const SONG_MODEL_CONTRACT_VERSION = "2.0" as const;
export const LEGACY_SONG_MODEL_CONTRACT_VERSION = "1.0" as const;
export const CANONICAL_SONG_MODEL_PPQ = 960 as const;
export const MIN_ARRANGEMENT_CONFIDENCE = 0.55;

export type ProviderSongModelResponse = {
  provider: string;
  output: unknown;
  confidence: number;
};

export type ValidationResult<T> =
  | { success: true; data: T; issues: SongModelValidationIssue[] }
  | { success: false; issues: SongModelValidationIssue[] };

export type FusionResult =
  | { accepted: true; model: SongModelData; decisions: ProviderFusionDecision[] }
  | { accepted: false; issues: SongModelValidationIssue[]; decisions: ProviderFusionDecision[] };

export function unavailableVocalIntelligence(
  reason = "This historical Song Model has no verified phrase-level vocal evidence. Reanalyze the source to verify it.",
): NonNullable<SongModelData["vocalIntelligence"]> {
  return {
    version: "1.0",
    provenance: null,
    phrases: { status: "not_available", reason, events: [] },
    breaths: { status: "not_available", reason, events: [] },
    lyricAlignment: {
      status: "not_available",
      reason: "No accepted vocal phrases and timed lyrics are both available.",
      alignments: [],
    },
    melodyAlignment: {
      status: "not_available",
      reason: "No accepted vocal phrases and compatible melody notes are both available.",
      alignments: [],
    },
    arrangementSpace: { status: "not_available", reason, windows: [] },
  };
}

type MutableIssue = Omit<SongModelValidationIssue, "provider"> & { provider?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

function canonicalizeCoordinates(
  model: SongModelCore,
): SongModelCore & Partial<Pick<SongModelData, "vocalEvidence" | "vocalIntelligence">> {
  const timeline = createCanonicalTimeline(model.tempoMap, model.meterMap);
  const vocalEvidence = (model as Partial<SongModelData>).vocalEvidence;
  const vocalIntelligence = (model as Partial<SongModelData>).vocalIntelligence;
  const range = (start: number, end: number) => ({
    start: timeline.coordinateAtSeconds(start),
    end: timeline.coordinateAtSeconds(end),
  });
  return {
    ...model,
    tempoMap: model.tempoMap.map((event) => ({
      ...event, coordinates: timeline.coordinateAtSeconds(event.time),
    })),
    meterMap: model.meterMap.map((event) => ({
      ...event, coordinates: timeline.coordinateAtBar(event.bar),
    })),
    keyMap: model.keyMap.map((event) => ({
      ...event, coordinates: timeline.coordinateAtSeconds(event.time),
    })),
    melody: model.melody.map((event) => ({ ...event, coordinates: range(event.start, event.end) })),
    bass: model.bass?.map((event) => ({ ...event, coordinates: range(event.start, event.end) })),
    chords: model.chords.map((event) => ({ ...event, coordinates: range(event.start, event.end) })),
    sections: model.sections.map((event) => ({
      ...event,
      coordinates: {
        start: timeline.coordinateAtBar(event.startBar),
        end: timeline.coordinateAtBar(event.endBar + 1),
      },
    })),
    vocalEvidence: vocalEvidence && {
      ...vocalEvidence,
      observedVoicedWindows: vocalEvidence.observedVoicedWindows.map((event) => ({
        ...event, coordinates: range(event.start, event.end),
      })),
      observedSilentWindows: vocalEvidence.observedSilentWindows.map((event) => ({
        ...event, coordinates: range(event.start, event.end),
      })),
    },
    vocalIntelligence: vocalIntelligence && {
      ...vocalIntelligence,
      phrases: { ...vocalIntelligence.phrases, events: vocalIntelligence.phrases.events.map((event) => ({ ...event, coordinates: range(event.start, event.end) })) },
      breaths: { ...vocalIntelligence.breaths, events: vocalIntelligence.breaths.events.map((event) => ({ ...event, coordinates: range(event.start, event.end) })) },
      arrangementSpace: { ...vocalIntelligence.arrangementSpace, windows: vocalIntelligence.arrangementSpace.windows.map((event) => ({ ...event, coordinates: range(event.start, event.end) })) },
    },
  };
}

export function canonicalizeSongModelCoordinates(model: SongModelData): SongModelData {
  const core = canonicalizeCoordinates(model);
  const timeline = createCanonicalTimeline(core.tempoMap, core.meterMap);
  return {
    ...model,
    tempoMap: core.tempoMap,
    meterMap: core.meterMap,
    keyMap: core.keyMap,
    melody: core.melody,
    bass: core.bass,
    chords: core.chords,
    sections: core.sections,
    beats: (model.beats ?? []).map((event) => ({
      ...event, coordinates: timeline.coordinateAtSeconds(event.time),
    })),
    bars: (model.bars ?? []).map((event) => ({
      ...event,
      coordinates: {
        start: timeline.coordinateAtSeconds(event.start),
        end: timeline.coordinateAtSeconds(event.end),
      },
    })),
    // Energy/dynamics are un-timestamped sample arrays.  Deliberately leave
    // them untouched rather than pretending their indices are musical events.
    lyrics: (model.lyrics ?? []).map((event) => ({
      ...event,
      coordinates: {
        start: timeline.coordinateAtSeconds(event.start),
        end: timeline.coordinateAtSeconds(event.end),
      },
    })),
    vocalEvidence: (core as Partial<SongModelData>).vocalEvidence,
    vocalIntelligence: (core as Partial<SongModelData>).vocalIntelligence,
  };
}

function coordinateMatches(
  value: unknown,
  expected: CanonicalCoordinate,
  path: string,
  issues: MutableIssue[],
): void {
  const tick = isRecord(value) ? value.tick : undefined;
  const bar = isRecord(value) ? value.bar : undefined;
  const beat = isRecord(value) ? value.beat : undefined;
  const beatInBar = isRecord(value) ? value.beatInBar : undefined;
  const beatFraction = isRecord(value) ? value.beatFraction : undefined;
  const seconds = isRecord(value) ? value.seconds : undefined;
  if (!isRecord(value) ||
    !isFiniteNumber(seconds) || !isInteger(tick) ||
    !isInteger(beat) || !isInteger(bar) || !isInteger(beatInBar) ||
    !isFiniteNumber(beatFraction) ||
    tick < 0 || bar < 1 || beat < 1 || beatInBar < 1 ||
    beatFraction < 0 || beatFraction >= 1 ||
    Math.abs(seconds - expected.seconds) > 0.000_001 ||
    tick !== expected.tick || beat !== expected.beat ||
    bar !== expected.bar || beatInBar !== expected.beatInBar ||
    Math.abs(beatFraction - expected.beatFraction) > 0.000_001
  ) {
    issues.push(issue("CONTRADICTORY_COORDINATES", "error", path,
      "Canonical coordinates must exactly match the Song Model tempo and meter maps."));
  }
}

function validateV2Coordinates(input: Record<string, unknown>, issues: MutableIssue[]): void {
  if (!Array.isArray(input.tempoMap) || !Array.isArray(input.meterMap)) return;
  let timeline: ReturnType<typeof createCanonicalTimeline>;
  try {
    timeline = createCanonicalTimeline(
      input.tempoMap.map((event) => isRecord(event) ? { time: event.time as number, bpm: event.bpm as number } : { time: -1, bpm: -1 }),
      input.meterMap.map((event) => isRecord(event) ? { bar: event.bar as number, meter: event.meter as string } : { bar: 0, meter: "" }),
    );
  } catch (error) {
    issues.push(issue("INVALID_CANONICAL_TIMELINE", "error", "tempoMap",
      error instanceof Error ? error.message : "Tempo and meter maps cannot form a canonical timeline."));
    return;
  }
  const pointEvents: Array<[string, unknown[], (event: Record<string, unknown>) => CanonicalCoordinate]> = [
    ["tempoMap", input.tempoMap, (event) => timeline.coordinateAtSeconds(event.time as number)],
    ["meterMap", input.meterMap, (event) => timeline.coordinateAtBar(event.bar as number)],
    ["keyMap", Array.isArray(input.keyMap) ? input.keyMap : [], (event) => timeline.coordinateAtSeconds(event.time as number)],
  ];
  for (const [name, events, position] of pointEvents) {
    events.forEach((event, index) => {
      if (!isRecord(event)) return;
      try { coordinateMatches(event.coordinates, position(event), `${name}.${index}.coordinates`, issues); } catch {
        issues.push(issue("CONTRADICTORY_COORDINATES", "error", `${name}.${index}.coordinates`, "Coordinates cannot be resolved."));
      }
    });
  }
  const rangeEvents: Array<[string, unknown[]]> = [
    ["melody", Array.isArray(input.melody) ? input.melody : []],
    ["bass", Array.isArray(input.bass) ? input.bass : []],
    ["chords", Array.isArray(input.chords) ? input.chords : []],
    ["bars", Array.isArray(input.bars) ? input.bars : []],
    ["lyrics", Array.isArray(input.lyrics) ? input.lyrics : []],
    ["vocalEvidence.observedVoicedWindows", isRecord(input.vocalEvidence) && Array.isArray(input.vocalEvidence.observedVoicedWindows) ? input.vocalEvidence.observedVoicedWindows : []],
    ["vocalEvidence.observedSilentWindows", isRecord(input.vocalEvidence) && Array.isArray(input.vocalEvidence.observedSilentWindows) ? input.vocalEvidence.observedSilentWindows : []],
    ["vocalIntelligence.phrases.events", isRecord(input.vocalIntelligence) && isRecord(input.vocalIntelligence.phrases) && Array.isArray(input.vocalIntelligence.phrases.events) ? input.vocalIntelligence.phrases.events : []],
    ["vocalIntelligence.breaths.events", isRecord(input.vocalIntelligence) && isRecord(input.vocalIntelligence.breaths) && Array.isArray(input.vocalIntelligence.breaths.events) ? input.vocalIntelligence.breaths.events : []],
    ["vocalIntelligence.arrangementSpace.windows", isRecord(input.vocalIntelligence) && isRecord(input.vocalIntelligence.arrangementSpace) && Array.isArray(input.vocalIntelligence.arrangementSpace.windows) ? input.vocalIntelligence.arrangementSpace.windows : []],
  ];
  for (const [name, events] of rangeEvents) {
    let previousStartTick = -1;
    events.forEach((event, index) => {
      if (!isRecord(event) || !isFiniteNumber(event.start) || !isFiniteNumber(event.end)) return;
      const coordinates = event.coordinates;
      if (!isRecord(coordinates)) {
        issues.push(issue("MISSING_CANONICAL_COORDINATES", "error", `${name}.${index}.coordinates`, "v2 timed events require canonical coordinates."));
        return;
      }
      const expectedStart = timeline.coordinateAtSeconds(event.start);
      if (expectedStart.tick < previousStartTick) {
        issues.push(issue("UNORDERED_CANONICAL_COORDINATES", "error", `${name}.${index}.coordinates.start`,
          "Timed v2 events must be ordered by canonical start tick."));
      }
      previousStartTick = Math.max(previousStartTick, expectedStart.tick);
      coordinateMatches(coordinates.start, expectedStart, `${name}.${index}.coordinates.start`, issues);
      coordinateMatches(coordinates.end, timeline.coordinateAtSeconds(event.end), `${name}.${index}.coordinates.end`, issues);
    });
  }
  let previousBeatTick = -1;
  (Array.isArray(input.beats) ? input.beats : []).forEach((event, index) => {
    if (!isRecord(event) || !isFiniteNumber(event.time)) return;
    const expected = timeline.coordinateAtSeconds(event.time);
    if (expected.tick < previousBeatTick) {
      issues.push(issue("UNORDERED_CANONICAL_COORDINATES", "error", `beats.${index}.coordinates`,
        "Beat events must be ordered by canonical tick."));
    }
    previousBeatTick = Math.max(previousBeatTick, expected.tick);
    coordinateMatches(event.coordinates, expected, `beats.${index}.coordinates`, issues);
    if (Number.isInteger(event.bar) && event.bar !== expected.bar) {
      issues.push(issue("CONTRADICTORY_COORDINATES", "error", `beats.${index}.bar`, "Beat bar contradicts the canonical meter timeline."));
    }
    if (Number.isInteger(event.beat) && event.beat !== expected.beatInBar) {
      issues.push(issue("CONTRADICTORY_COORDINATES", "error", `beats.${index}.beat`, "Beat number contradicts the canonical meter timeline."));
    }
  });
  (Array.isArray(input.sections) ? input.sections : []).forEach((event, index) => {
    if (!isRecord(event) || !Number.isInteger(event.startBar) || !Number.isInteger(event.endBar)) return;
    if (!isRecord(event.coordinates)) {
      issues.push(issue("MISSING_CANONICAL_COORDINATES", "error", `sections.${index}.coordinates`, "v2 sections require canonical bar coordinates."));
      return;
    }
    coordinateMatches(event.coordinates.start, timeline.coordinateAtBar(event.startBar as number), `sections.${index}.coordinates.start`, issues);
    coordinateMatches(event.coordinates.end, timeline.coordinateAtBar((event.endBar as number) + 1), `sections.${index}.coordinates.end`, issues);
  });
}

export function isLegacySongModel(input: unknown): boolean {
  return isRecord(input) && !("contractVersion" in input);
}
function issue(
  code: string,
  severity: "error" | "warning",
  path: string,
  message: string,
  provider?: string,
): MutableIssue {
  return { code, severity, path, message, ...(provider ? { provider } : {}) };
}

function confidenceValue(
  value: unknown,
  path: string,
  issues: MutableIssue[],
): value is number {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    issues.push(issue(
      "INVALID_CONFIDENCE",
      "error",
      path,
      "Confidence must be a finite number between 0 and 1.",
    ));
    return false;
  }
  return true;
}

function validateAudio(value: unknown, issues: MutableIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("INVALID_AUDIO", "error", "audio", "Audio metadata is required."));
    return;
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    issues.push(issue("INVALID_AUDIO_NAME", "error", "audio.name", "Audio name is required."));
  }
  if (typeof value.contentType !== "string" || !value.contentType.trim()) {
    issues.push(issue(
      "INVALID_CONTENT_TYPE",
      "error",
      "audio.contentType",
      "Audio content type is required.",
    ));
  }
  for (const [key, minimum] of [
    ["size", 1],
    ["durationSeconds", 0.1],
    ["sampleRate", 1],
    ["channels", 1],
  ] as const) {
    if (!isFiniteNumber(value[key]) || value[key] < minimum) {
      issues.push(issue(
        "INVALID_AUDIO_METADATA",
        "error",
        `audio.${key}`,
        `${key} must be a finite number greater than or equal to ${minimum}.`,
      ));
    }
  }
}

function validateTimedEvents(
  value: unknown,
  name: "tempoMap" | "keyMap",
  issues: MutableIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue(
      `MISSING_${name === "tempoMap" ? "TEMPO" : "KEY"}_MAP`,
      "error",
      name,
      `${name === "tempoMap" ? "Tempo" : "Key"} analysis is required.`,
    ));
    return;
  }
  let previousTime = -1;
  value.forEach((event, index) => {
    const path = `${name}.${index}`;
    if (!isRecord(event)) {
      issues.push(issue("INVALID_EVENT", "error", path, "Event must be an object."));
      return;
    }
    if (!isFiniteNumber(event.time) || event.time < 0 || event.time < previousTime) {
      issues.push(issue(
        "INVALID_EVENT_TIME",
        "error",
        `${path}.time`,
        "Event time must be finite, non-negative, and ordered.",
      ));
    } else {
      previousTime = event.time;
    }
    confidenceValue(event.confidence, `${path}.confidence`, issues);
    if (name === "tempoMap") {
      if (!isFiniteNumber(event.bpm) || event.bpm < 30 || event.bpm > 300) {
        issues.push(issue(
          "INVALID_TEMPO",
          "error",
          `${path}.bpm`,
          "Tempo must be between 30 and 300 BPM.",
        ));
      }
    } else if (typeof event.key !== "string" || !event.key.trim()) {
      issues.push(issue("INVALID_KEY", "error", `${path}.key`, "Key label is required."));
    }
  });
}

function validateMeterMap(value: unknown, issues: MutableIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue("MISSING_METER_MAP", "error", "meterMap", "Meter analysis is required."));
    return;
  }
  let previousBar = 0;
  value.forEach((event, index) => {
    const path = `meterMap.${index}`;
    if (!isRecord(event)) {
      issues.push(issue("INVALID_EVENT", "error", path, "Meter event must be an object."));
      return;
    }
    if (!Number.isInteger(event.bar) || (event.bar as number) < 1 || (event.bar as number) < previousBar) {
      issues.push(issue(
        "INVALID_METER_BAR",
        "error",
        `${path}.bar`,
        "Meter bar must be a positive, ordered integer.",
      ));
    } else {
      previousBar = event.bar as number;
    }
    if (typeof event.meter !== "string" || !/^[1-9]\d*\/[1-9]\d*$/.test(event.meter)) {
      issues.push(issue(
        "INVALID_METER",
        "error",
        `${path}.meter`,
        "Meter must use a value such as 4/4 or 6/8.",
      ));
    }
    confidenceValue(event.confidence, `${path}.confidence`, issues);
  });
}

function validateMelody(value: unknown, duration: number | undefined, issues: MutableIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(issue("INVALID_MELODY", "error", "melody", "Melody must be an array."));
    return;
  }
  let previous: { start: number; end: number; pitch: number } | undefined;
  value.forEach((note, index) => {
    const path = `melody.${index}`;
    if (!isRecord(note)) {
      issues.push(issue("INVALID_NOTE", "error", path, "Note must be an object."));
      return;
    }
    const start = note.start;
    const end = note.end;
    const pitch = note.pitch;
    if (!isFiniteNumber(start) || !isFiniteNumber(end) || start < 0 || end <= start) {
      issues.push(issue(
        "INVALID_NOTE_TIMING",
        "error",
        path,
        "Note start and end must be finite, non-negative, and increasing.",
      ));
    } else {
      if (end - start < 0.04) {
        issues.push(issue(
          "MICRO_NOTE",
          "error",
          path,
          "Notes shorter than 40 ms are unreliable; re-run transcription with transient filtering.",
        ));
      }
      if (duration !== undefined && end > duration + 0.05) {
        issues.push(issue(
          "NOTE_OUTSIDE_AUDIO",
          "error",
          `${path}.end`,
          "Note extends beyond the source audio duration.",
        ));
      }
    }
    if (!Number.isInteger(pitch) || (pitch as number) < 0 || (pitch as number) > 127) {
      issues.push(issue("INVALID_PITCH", "error", `${path}.pitch`, "Pitch must be a MIDI note from 0 to 127."));
    }
    if (!Number.isInteger(note.velocity) || (note.velocity as number) < 0 || (note.velocity as number) > 127) {
      issues.push(issue(
        "INVALID_VELOCITY",
        "error",
        `${path}.velocity`,
        "Velocity must be an integer from 0 to 127.",
      ));
    }
    confidenceValue(note.confidence, `${path}.confidence`, issues);
    if (typeof note.source !== "string" || !note.source.trim()) {
      issues.push(issue("MISSING_NOTE_SOURCE", "error", `${path}.source`, "Note source is required."));
    }
    if (
      previous &&
      isFiniteNumber(start) &&
      isFiniteNumber(pitch) &&
      start - previous.end <= 0.25 &&
      Math.abs(pitch - previous.pitch) > 18
    ) {
      issues.push(issue(
        "OCTAVE_JUMP",
        "warning",
        path,
        "Abrupt pitch jump exceeds 18 semitones; verify octave tracking before arranging.",
      ));
    }
    if (isFiniteNumber(start) && isFiniteNumber(end) && isFiniteNumber(pitch)) {
      previous = { start, end, pitch };
    }
  });
}

function validateBassEvidence(value: unknown, duration: number | undefined, issues: MutableIssue[]): void {
  if (value === undefined) return; // legacy models predate optional bass evidence
  if (!Array.isArray(value)) {
    issues.push(issue("INVALID_BASS_EVIDENCE", "error", "bass", "Bass evidence must be an array."));
    return;
  }
  value.forEach((note, index) => {
    const path = `bass.${index}`;
    if (!isRecord(note) || !isFiniteNumber(note.start) || !isFiniteNumber(note.end) ||
      note.start < 0 || note.end <= note.start || (duration !== undefined && note.end > duration + .05) ||
      !Number.isInteger(note.pitch) || (note.pitch as number) < 0 || (note.pitch as number) > 127 ||
      !confidenceValue(note.confidence, `${path}.confidence`, issues) ||
      (note.provider !== undefined && (typeof note.provider !== "string" || !note.provider.trim()))) {
      issues.push(issue("INVALID_BASS_EVIDENCE", "error", path, "Bass evidence must have valid timing, pitch, confidence, and optional provider."));
    }
  });
}

function validateVocalEvidence(value: unknown, duration: number | undefined, issues: MutableIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("MISSING_VOCAL_EVIDENCE", "error", "vocalEvidence", "v2 Song Models require explicit vocal evidence."));
    return;
  }
  const status = value.status;
  if (!["detected", "low_confidence", "not_available", "failed"].includes(String(status))) {
    issues.push(issue("INVALID_VOCAL_EVIDENCE", "error", "vocalEvidence.status", "Vocal evidence status is invalid."));
  }
  if (!(value.reason === null || typeof value.reason === "string")) {
    issues.push(issue("INVALID_VOCAL_EVIDENCE", "error", "vocalEvidence.reason", "Vocal evidence reason must be a string or null."));
  }
  const voiced = value.observedVoicedWindows;
  const silent = value.observedSilentWindows;
  if (!Array.isArray(voiced) || !Array.isArray(silent)) {
    issues.push(issue("INVALID_VOCAL_EVIDENCE", "error", "vocalEvidence", "Vocal evidence windows must be arrays."));
    return;
  }
  const all: Array<{ start: number; end: number; path: string }> = [];
  for (const [name, windows] of [["observedVoicedWindows", voiced], ["observedSilentWindows", silent]] as const) {
    let priorEnd = -1;
    windows.forEach((window, index) => {
      const path = `vocalEvidence.${name}.${index}`;
      if (isRecord(window) && isFiniteNumber(window.start) && isFiniteNumber(window.end) &&
        window.start >= 0 && window.end > window.start) {
        all.push({ start: window.start, end: window.end, path });
      }
      if (!isRecord(window) || !isFiniteNumber(window.start) || !isFiniteNumber(window.end) ||
        window.start < 0 || window.end <= window.start ||
        (duration !== undefined && window.end > duration + 0.000_001) ||
        window.start < priorEnd
      ) {
        issues.push(issue("INVALID_VOCAL_WINDOW", "error", path, "Vocal windows must be ordered, non-overlapping, and within audio bounds."));
      } else {
        priorEnd = window.end;
      }
    });
  }
  all.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < all.length; index += 1) {
    if (all[index].start < all[index - 1].end) {
      issues.push(issue("OVERLAPPING_VOCAL_WINDOWS", "error", all[index].path, "Voiced and silent windows must not overlap."));
    }
  }
  const hasMeasurements = status === "detected" || status === "low_confidence";
  if (hasMeasurements) {
    if (!isRecord(value.provenance) || typeof value.provenance.sourceStemRole !== "string" ||
      !value.provenance.sourceStemRole.trim() || typeof value.provenance.objectPath !== "string" ||
      !value.provenance.objectPath.trim() || typeof value.provenance.provider !== "string" ||
      !value.provenance.provider.trim() ||
      (value.provenance.contentChecksum !== undefined &&
        (typeof value.provenance.contentChecksum !== "string" || !/^[a-f0-9]{64}$/i.test(value.provenance.contentChecksum))) ||
      !isFiniteNumber(value.sampleRate) || value.sampleRate < 1 ||
      !Number.isInteger(value.channels) || (value.channels as number) < 1 ||
      !Number.isInteger(value.frameSizeSamples) || (value.frameSizeSamples as number) < 1 ||
      !isRecord(value.thresholds) ||
      !["rms", "peak", "activitySample", "activityRatio"].every((key) =>
        isFiniteNumber((value.thresholds as Record<string, unknown>)[key]) &&
        ((value.thresholds as Record<string, unknown>)[key] as number) >= 0
      )
    ) {
      issues.push(issue("INVALID_VOCAL_EVIDENCE", "error", "vocalEvidence", "Observed vocal evidence requires PCM metadata, thresholds, and stem provenance."));
    }
  } else if (voiced.length || silent.length) {
    issues.push(issue("INVALID_VOCAL_EVIDENCE", "error", "vocalEvidence", "Unavailable or failed vocal evidence must not contain windows."));
  }
}

function validateVocalIntelligence(
  value: unknown,
  duration: number | undefined,
  issues: MutableIssue[],
  vocalEvidence?: unknown,
  lyrics: unknown[] = [],
  melody: unknown[] = [],
  context?: Record<string, unknown>,
): void {
  if (!isRecord(value) || value.version !== "1.0") {
    issues.push(issue("MISSING_VOCAL_INTELLIGENCE", "error", "vocalIntelligence",
      "v2 Song Models require versioned phrase-level vocal intelligence."));
    return;
  }
  const groups = [
    ["phrases", "events", ["detected", "low_confidence", "not_available", "conflicting"]],
    ["breaths", "events", ["detected", "not_available"]],
    ["arrangementSpace", "windows", ["detected", "not_available"]],
  ] as const;
  const timedByGroup = new Map<string, Array<Record<string, unknown>>>();
  for (const [groupName, eventName, statuses] of groups) {
    const group = value[groupName];
    if (!isRecord(group) || !Array.isArray(group[eventName]) ||
      !statuses.includes(String(group.status) as never) ||
      !(group.reason === null || typeof group.reason === "string") ||
      (!["detected", "low_confidence"].includes(String(group.status)) &&
        (group[eventName] as unknown[]).length > 0)) {
      issues.push(issue("INVALID_VOCAL_INTELLIGENCE", "error", `vocalIntelligence.${groupName}`,
        "Phrase-level evidence groups require a legal status, reason, and status-compatible event array."));
      continue;
    }
    let priorEnd = -1;
    const validEvents: Array<Record<string, unknown>> = [];
    (group[eventName] as unknown[]).forEach((event, index) => {
      if (!isRecord(event) || typeof event.id !== "string" || !event.id ||
        !isFiniteNumber(event.start) || !isFiniteNumber(event.end) ||
        event.start < 0 || event.end <= event.start ||
        event.start < priorEnd ||
        (duration !== undefined && event.end > duration + 0.000_001) ||
        !isFiniteNumber(event.confidence) || event.confidence < 0 || event.confidence > 1) {
        issues.push(issue("INVALID_VOCAL_INTELLIGENCE_EVENT", "error",
          `vocalIntelligence.${groupName}.${eventName}.${index}`,
          "Vocal evidence events must be bounded, identified, and carry confidence."));
      } else {
        priorEnd = event.end;
        validEvents.push(event);
      }
    });
    timedByGroup.set(groupName, validEvents);
  }
  const phrases = timedByGroup.get("phrases") ?? [];
  const phraseIds = new Set(phrases.map((event) => String(event.id)));
  const breaths = timedByGroup.get("breaths") ?? [];
  const observedSilent = isRecord(vocalEvidence) && Array.isArray(vocalEvidence.observedSilentWindows)
    ? vocalEvidence.observedSilentWindows.filter(isRecord)
    : [];
  for (const breath of breaths) {
    const bounded = phrases.some((left, index) => {
      const right = phrases[index + 1];
      return right && left.end === breath.start && right.start === breath.end;
    });
    const observedGap = observedSilent.some((window) =>
      window.start === breath.start && window.end === breath.end);
    if (breath.kind !== "inter_phrase" || !bounded || !observedGap) {
      issues.push(issue("UNVERIFIED_VOCAL_BREATH", "error", "vocalIntelligence.breaths",
        "Breaths must be observed silent inter-phrase gaps bounded exactly by accepted phrases."));
    }
  }
  const spaces = timedByGroup.get("arrangementSpace") ?? [];
  let timeline: ReturnType<typeof createCanonicalTimeline> | null = null;
  try {
    if (context && Array.isArray(context.tempoMap) && Array.isArray(context.meterMap)) {
      timeline = createCanonicalTimeline(
        context.tempoMap.map((event) => isRecord(event)
          ? { time: event.time as number, bpm: event.bpm as number }
          : { time: -1, bpm: -1 }),
        context.meterMap.map((event) => isRecord(event)
          ? { bar: event.bar as number, meter: event.meter as string }
          : { bar: 0, meter: "" }),
      );
    }
  } catch {
    timeline = null;
  }
  for (const space of spaces) {
    const before = typeof space.phraseBeforeId === "string"
      ? phrases.find((phrase) => phrase.id === space.phraseBeforeId)
      : null;
    const after = typeof space.phraseAfterId === "string"
      ? phrases.find((phrase) => phrase.id === space.phraseAfterId)
      : null;
    const supportedBySilence = observedSilent.some((window) =>
      isFiniteNumber(window.start) && isFiniteNumber(window.end) &&
      window.start <= (space.start as number) && window.end >= (space.end as number));
    const startBar = timeline?.coordinateAtSeconds(space.start as number).bar;
    const endBar = timeline?.coordinateAtSeconds(space.end as number).bar;
    const expectedBars = startBar !== undefined && endBar !== undefined
      ? Array.from({ length: endBar - startBar + 1 }, (_, offset) => startBar + offset)
      : [];
    const expectedSections = startBar !== undefined && endBar !== undefined &&
      context && Array.isArray(context.sections)
      ? context.sections.filter((section) =>
          isRecord(section) && Number.isInteger(section.startBar) && Number.isInteger(section.endBar) &&
          (section.endBar as number) >= startBar && (section.startBar as number) <= endBar)
        .map((section) => (section as Record<string, unknown>).name)
        .filter((name): name is string => typeof name === "string")
      : [];
    const barsMatch = Array.isArray(space.bars) &&
      JSON.stringify(space.bars) === JSON.stringify(expectedBars);
    const sectionsMatch = Array.isArray(space.sections) &&
      JSON.stringify(space.sections) === JSON.stringify(expectedSections);
    if ((space.phraseBeforeId !== null && !before) ||
      (space.phraseAfterId !== null && !after) ||
      (before && isFiniteNumber(before.end) && before.end > (space.start as number)) ||
      (after && isFiniteNumber(after.start) && after.start < (space.end as number)) ||
      !Array.isArray(space.bars) ||
      !space.bars.every((bar) => Number.isInteger(bar) && bar >= 1) ||
      !Array.isArray(space.sections) ||
      !space.sections.every((section) => typeof section === "string" && section.trim()) ||
      !barsMatch ||
      !sectionsMatch ||
      !supportedBySilence) {
      issues.push(issue("UNVERIFIED_ARRANGEMENT_SPACE", "error", "vocalIntelligence.arrangementSpace",
        "Arrangement space must reference valid surrounding phrases, canonical bars/sections, and observed vocal-stem silence."));
    }
  }
  for (const name of ["lyricAlignment", "melodyAlignment"] as const) {
    const alignment = value[name];
    const statuses = ["aligned", "not_available", "conflicting"];
    if (!isRecord(alignment) || !Array.isArray(alignment.alignments) ||
      !statuses.includes(String(alignment.status)) ||
      (alignment.status !== "aligned" && alignment.alignments.length > 0) ||
      !(alignment.reason === null || typeof alignment.reason === "string")) {
      issues.push(issue("INVALID_VOCAL_ALIGNMENT", "error", `vocalIntelligence.${name}`,
        "Alignment evidence requires a status, reason, and alignment array."));
      continue;
    }
    const indexKey = name === "lyricAlignment" ? "lyricIndexes" : "melodyIndexes";
    const sourceItems = name === "lyricAlignment" ? lyrics : melody;
    alignment.alignments.forEach((item, index) => {
      const indexes = isRecord(item) ? item[indexKey] : undefined;
      const phrase = isRecord(item)
        ? phrases.find((candidate) => candidate.id === item.phraseId)
        : undefined;
      if (!isRecord(item) || typeof item.phraseId !== "string" ||
        !phraseIds.has(item.phraseId) || !Array.isArray(indexes) || !indexes.length ||
        !indexes.every((value) => {
          const source = Number.isInteger(value) ? sourceItems[value as number] : undefined;
          return isRecord(source) && isFiniteNumber(source.start) && isFiniteNumber(source.end) &&
            isFiniteNumber(phrase?.start) && isFiniteNumber(phrase?.end) &&
            Math.min(source.end, phrase.end) > Math.max(source.start, phrase.start);
        }) ||
        !isFiniteNumber(item.confidence) || item.confidence < 0 || item.confidence > 1) {
        issues.push(issue("UNVERIFIED_VOCAL_ALIGNMENT", "error",
          `vocalIntelligence.${name}.alignments.${index}`,
          "Alignments must reference an accepted phrase and existing compatible source events."));
      }
    });
    if (alignment.status === "aligned" && alignment.alignments.length === 0) {
      issues.push(issue("UNVERIFIED_VOCAL_ALIGNMENT", "error", `vocalIntelligence.${name}`,
        "Aligned status requires at least one supported phrase alignment."));
    }
  }
  const provenance = value.provenance;
  const observed = isRecord(vocalEvidence) && vocalEvidence.status === "detected";
  const observedVoiced = observed && Array.isArray(vocalEvidence.observedVoicedWindows)
    ? vocalEvidence.observedVoicedWindows.filter(isRecord)
    : [];
  for (const phrase of phrases) {
    const supportingWindows = observedVoiced.filter((window) =>
      isFiniteNumber(window.start) && isFiniteNumber(window.end) &&
      window.end > (phrase.start as number) && window.start < (phrase.end as number));
    const boundariesMatch = supportingWindows.length > 0 &&
      supportingWindows[0].start === phrase.start &&
      supportingWindows.at(-1)?.end === phrase.end;
    const gapsArePhraseSized = supportingWindows.every((window, index) =>
      index === 0 ||
      (window.start as number) - (supportingWindows[index - 1].end as number) <= .35);
    if (!boundariesMatch || !gapsArePhraseSized) {
      issues.push(issue("UNVERIFIED_VOCAL_PHRASE", "error", "vocalIntelligence.phrases",
        "Phrases must be bounded by verified voiced windows with only phrase-sized internal gaps."));
    }
  }
  const hasTimedEvidence = phrases.length || breaths.length ||
    (timedByGroup.get("arrangementSpace")?.length ?? 0) > 0;
  if (hasTimedEvidence) {
    if (!observed || !isRecord(provenance) || !isRecord(vocalEvidence.provenance) ||
      provenance.sourceStemRole !== vocalEvidence.provenance.sourceStemRole ||
      provenance.objectPath !== vocalEvidence.provenance.objectPath ||
      provenance.provider !== vocalEvidence.provenance.provider ||
      provenance.contentChecksum !== vocalEvidence.provenance.contentChecksum) {
      issues.push(issue("UNVERIFIED_VOCAL_PROVENANCE", "error", "vocalIntelligence.provenance",
        "Detected phrases must use the exact verified vocal-stem provenance."));
    }
  }
}

function validateChords(value: unknown, duration: number | undefined, issues: MutableIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(issue("INVALID_CHORDS", "error", "chords", "Chords must be an array."));
    return;
  }
  value.forEach((chord, index) => {
    const path = `chords.${index}`;
    if (!isRecord(chord)) {
      issues.push(issue("INVALID_CHORD", "error", path, "Chord must be an object."));
      return;
    }
    if (
      !isFiniteNumber(chord.start) ||
      !isFiniteNumber(chord.end) ||
      chord.start < 0 ||
      chord.end <= chord.start
    ) {
      issues.push(issue("INVALID_CHORD_TIMING", "error", path, "Chord timing is invalid."));
    } else if (duration !== undefined && chord.end > duration + 0.05) {
      issues.push(issue(
        "CHORD_OUTSIDE_AUDIO",
        "error",
        `${path}.end`,
        "Chord extends beyond the source audio duration.",
      ));
    }
    if (typeof chord.symbol !== "string" || !chord.symbol.trim()) {
      issues.push(issue("INVALID_CHORD_SYMBOL", "error", `${path}.symbol`, "Chord symbol is required."));
    }
    if (typeof chord.roman !== "string" || !chord.roman.trim()) {
      issues.push(issue("INVALID_ROMAN_NUMERAL", "error", `${path}.roman`, "Roman numeral is required."));
    }
    confidenceValue(chord.confidence, `${path}.confidence`, issues);
    for (const field of ["root", "quality", "bass", "function"] as const) {
      if (chord[field] !== undefined && (typeof chord[field] !== "string" || !chord[field].trim())) {
        issues.push(issue("INVALID_CANONICAL_CHORD_FIELD", "error", `${path}.${field}`, `${field} must be a non-empty string when supplied.`));
      }
    }
    for (const field of ["extensions", "alterations"] as const) {
      if (chord[field] !== undefined && (!Array.isArray(chord[field]) || !chord[field].every((item) => typeof item === "string" && item.trim()))) {
        issues.push(issue("INVALID_CANONICAL_CHORD_FIELD", "error", `${path}.${field}`, `${field} must be an array of non-empty strings when supplied.`));
      }
    }
    if (chord.inversion !== undefined && (!Number.isInteger(chord.inversion) || typeof chord.inversion !== "number" || chord.inversion < 0)) {
      issues.push(issue("INVALID_CANONICAL_CHORD_FIELD", "error", `${path}.inversion`, "inversion must be a non-negative integer when supplied."));
    }
    if (chord.timing !== undefined) {
      const timing = chord.timing;
      const beatPairSupplied = isRecord(timing) && (timing.startBeat !== undefined || timing.durationBeats !== undefined);
      const secondsPairSupplied = isRecord(timing) && (timing.startSeconds !== undefined || timing.endSeconds !== undefined);
      if (
        !isRecord(timing) ||
        (!beatPairSupplied && !secondsPairSupplied) ||
        (beatPairSupplied && (!isFiniteNumber(timing.startBeat) || timing.startBeat < 0 || !isFiniteNumber(timing.durationBeats) || timing.durationBeats <= 0)) ||
        (secondsPairSupplied && (!isFiniteNumber(timing.startSeconds) || timing.startSeconds < 0 || !isFiniteNumber(timing.endSeconds) || timing.endSeconds <= timing.startSeconds)) ||
        (isFiniteNumber(timing.startSeconds) && isFiniteNumber(chord.start) && Math.abs(timing.startSeconds - chord.start) > 0.05) ||
        (isFiniteNumber(timing.endSeconds) && isFiniteNumber(chord.end) && Math.abs(timing.endSeconds - chord.end) > 0.05)
      ) {
        issues.push(issue("INVALID_CANONICAL_CHORD_TIMING", "error", `${path}.timing`, "Canonical chord timing must contain complete, positive, consistent beat or second ranges."));
      }
    }
    if (chord.melodyConflictEvidence !== undefined) {
      if (!Array.isArray(chord.melodyConflictEvidence) || chord.melodyConflictEvidence.length > 64) {
        issues.push(issue("INVALID_MELODY_CONFLICT_EVIDENCE", "error", `${path}.melodyConflictEvidence`, "Melody conflict evidence must be a bounded array."));
      } else {
        chord.melodyConflictEvidence.forEach((evidence, evidenceIndex) => {
          const evidencePath = `${path}.melodyConflictEvidence.${evidenceIndex}`;
          if (
            !isRecord(evidence) ||
            !["clash", "avoid_note", "unresolved_tension", "unknown"].includes(String(evidence.conflict)) ||
            (evidence.noteId !== undefined && (typeof evidence.noteId !== "string" || !evidence.noteId.trim() || evidence.noteId.length > 512)) ||
            (evidence.pitch !== undefined && (!Number.isInteger(evidence.pitch) || (evidence.pitch as number) < 0 || (evidence.pitch as number) > 127)) ||
            (evidence.start !== undefined && (!isFiniteNumber(evidence.start) || evidence.start < 0)) ||
            (evidence.end !== undefined && (!isFiniteNumber(evidence.end) || evidence.end < 0)) ||
            (isFiniteNumber(evidence.start) && isFiniteNumber(evidence.end) && evidence.end <= evidence.start) ||
            (evidence.severity !== undefined && (!isFiniteNumber(evidence.severity) || evidence.severity < 0 || evidence.severity > 1)) ||
            (evidence.explanation !== undefined && (typeof evidence.explanation !== "string" || !evidence.explanation.trim() || evidence.explanation.length > 512))
          ) {
            issues.push(issue("INVALID_MELODY_CONFLICT_EVIDENCE", "error", evidencePath, "Melody conflict evidence contains invalid fields."));
          }
        });
      }
    }
    if (chord.bassSupportEvidence !== undefined) {
      if (!Array.isArray(chord.bassSupportEvidence) || chord.bassSupportEvidence.length > 16) {
        issues.push(issue("INVALID_CHORD_BASS_SUPPORT", "error", `${path}.bassSupportEvidence`, "Chord bass support must be a bounded array."));
      } else {
        chord.bassSupportEvidence.forEach((evidence, evidenceIndex) => {
          const evidencePath = `${path}.bassSupportEvidence.${evidenceIndex}`;
          if (
            !isRecord(evidence) ||
            !isFiniteNumber(evidence.start) || evidence.start < 0 ||
            !isFiniteNumber(evidence.end) || evidence.end <= evidence.start ||
            typeof evidence.pitch !== "number" || !Number.isInteger(evidence.pitch) || evidence.pitch < 0 || evidence.pitch > 127 ||
            !isFiniteNumber(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1 ||
            typeof evidence.provider !== "string" || !evidence.provider.trim() || evidence.provider.length > 512
          ) {
            issues.push(issue("INVALID_CHORD_BASS_SUPPORT", "error", evidencePath, "Chord bass support contains invalid timing, pitch, confidence, or provider."));
          }
        });
      }
    }
    if (chord.candidateProvenance !== undefined) {
      if (!Array.isArray(chord.candidateProvenance) || chord.candidateProvenance.length > 64) {
        issues.push(issue("INVALID_CHORD_CANDIDATE_PROVENANCE", "error", `${path}.candidateProvenance`, "Chord candidate provenance must be a bounded array."));
      } else {
        chord.candidateProvenance.forEach((candidate, candidateIndex) => {
          const candidatePath = `${path}.candidateProvenance.${candidateIndex}`;
          if (
            !isRecord(candidate) ||
            typeof candidate.candidateId !== "string" || !candidate.candidateId.trim() || candidate.candidateId.length > 512 ||
            typeof candidate.provider !== "string" || !candidate.provider.trim() || candidate.provider.length > 512 ||
            (candidate.modelVersion !== undefined && (typeof candidate.modelVersion !== "string" || !candidate.modelVersion.trim() || candidate.modelVersion.length > 512)) ||
            (candidate.score !== undefined && (!isFiniteNumber(candidate.score) || candidate.score < 0 || candidate.score > 100)) ||
            (candidate.selected !== undefined && typeof candidate.selected !== "boolean") ||
            (candidate.evidence !== undefined && (
              !Array.isArray(candidate.evidence) ||
              candidate.evidence.length > 64 ||
              !candidate.evidence.every((item) => typeof item === "string" && item.trim() && item.length <= 512)
            ))
          ) {
            issues.push(issue("INVALID_CHORD_CANDIDATE_PROVENANCE", "error", candidatePath, "Chord candidate provenance contains invalid fields."));
          }
        });
      }
    }
  });
}

function validateSections(value: unknown, issues: MutableIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue(
      "MISSING_SECTIONS",
      "error",
      "sections",
      "At least one structural section is required before arranging.",
    ));
    return;
  }
  let previousEnd = 0;
  value.forEach((section, index) => {
    const path = `sections.${index}`;
    if (!isRecord(section)) {
      issues.push(issue("INVALID_SECTION", "error", path, "Section must be an object."));
      return;
    }
    if (typeof section.name !== "string" || !section.name.trim()) {
      issues.push(issue("INVALID_SECTION_NAME", "error", `${path}.name`, "Section name is required."));
    }
    if (
      !Number.isInteger(section.startBar) ||
      !Number.isInteger(section.endBar) ||
      (section.startBar as number) < 1 ||
      (section.endBar as number) < (section.startBar as number)
    ) {
      issues.push(issue("INVALID_SECTION_BARS", "error", path, "Section bars are invalid."));
    } else {
      if (index === 0 && section.startBar !== 1) {
        issues.push(issue(
          "SECTION_COVERAGE_GAP",
          "error",
          `${path}.startBar`,
          "The first section must begin at bar 1.",
        ));
      }
      if (index > 0 && section.startBar !== previousEnd + 1) {
        issues.push(issue(
          "SECTION_COVERAGE_GAP",
          "error",
          `${path}.startBar`,
          "Sections must be ordered and contiguous.",
        ));
      }
      previousEnd = section.endBar as number;
    }
    if (!isFiniteNumber(section.energy) || section.energy < 0 || section.energy > 1) {
      issues.push(issue(
        "INVALID_SECTION_ENERGY",
        "error",
        `${path}.energy`,
        "Section energy must be between 0 and 1.",
      ));
    }
  });
}

const NOTE_ROOTS: Record<string, number> = {
  C: 0,
  "C#": 1,
  DB: 1,
  D: 2,
  "D#": 3,
  EB: 3,
  E: 4,
  F: 5,
  "F#": 6,
  GB: 6,
  G: 7,
  "G#": 8,
  AB: 8,
  A: 9,
  "A#": 10,
  BB: 10,
  B: 11,
};

function chordPitchClasses(symbol: string): Set<number> | undefined {
  const normalized = symbol.replace("♯", "#").replace("♭", "b");
  const match = /^([A-Ga-g])([#b]?)(.*)$/.exec(normalized);
  if (!match) return undefined;
  const root = NOTE_ROOTS[`${match[1].toUpperCase()}${match[2].toUpperCase()}`];
  if (root === undefined) return undefined;
  const quality = match[3].toLowerCase();
  const intervals = quality.startsWith("dim")
    ? [0, 3, 6]
    : quality.startsWith("aug") || quality.startsWith("+")
      ? [0, 4, 8]
      : quality.startsWith("m") && !quality.startsWith("maj")
        ? [0, 3, 7]
        : [0, 4, 7];
  if (quality.includes("7")) intervals.push(quality.includes("maj7") ? 11 : 10);
  return new Set(intervals.map((interval) => (root + interval) % 12));
}

function addMusicalIssues(model: SongModelCore, issues: MutableIssue[]): void {
  if (model.tempoMap.length > 1) {
    const bpms = model.tempoMap.map((event) => event.bpm).sort((a, b) => a - b);
    const median = bpms[Math.floor(bpms.length / 2)];
    const drift = Math.max(...bpms.map((bpm) => Math.abs(bpm - median) / median));
    if (drift > 0.08) {
      issues.push(issue(
        "TEMPO_DRIFT",
        "warning",
        "tempoMap",
        "Tempo estimates drift by more than 8%; verify the beat grid before arranging.",
      ));
    }
  }

  const highConfidenceNotes = model.melody.filter((note) => note.confidence >= 0.6);
  let compared = 0;
  let conflicts = 0;
  for (const note of highConfidenceNotes) {
    const chord = model.chords.find((candidate) =>
      candidate.confidence >= 0.6 &&
      candidate.start < note.end &&
      candidate.end > note.start
    );
    if (!chord) continue;
    const chordTones = chordPitchClasses(chord.symbol);
    if (!chordTones) continue;
    compared += 1;
    if (!chordTones.has(note.pitch % 12)) conflicts += 1;
  }
  if (compared >= 3 && conflicts / compared >= 0.6) {
    issues.push(issue(
      "CHORD_MELODY_CONFLICT",
      conflicts / compared >= 0.8 ? "error" : "warning",
      "melody",
      "High-confidence melody notes conflict with the detected harmony; review transcription or chords.",
    ));
  }
}

export function validateSongModelCore(input: unknown): ValidationResult<SongModelCore> {
  const issues: MutableIssue[] = [];
  if (!isRecord(input)) {
    return {
      success: false,
      issues: [issue("INVALID_SONG_MODEL", "error", "", "Provider output must be an object.")],
    };
  }
  validateAudio(input.audio, issues);
  const duration = isRecord(input.audio) && isFiniteNumber(input.audio.durationSeconds)
    ? input.audio.durationSeconds
    : undefined;
  validateTimedEvents(input.tempoMap, "tempoMap", issues);
  validateMeterMap(input.meterMap, issues);
  validateTimedEvents(input.keyMap, "keyMap", issues);
  validateMelody(input.melody, duration, issues);
  validateBassEvidence(input.bass, duration, issues);
  validateChords(input.chords, duration, issues);
  validateSections(input.sections, issues);
  if (!Array.isArray(input.energy) || input.energy.length === 0) {
    issues.push(issue("MISSING_ENERGY", "error", "energy", "Energy curve is required."));
  } else if (input.energy.some((value) => !isFiniteNumber(value) || value < 0 || value > 1)) {
    issues.push(issue(
      "INVALID_ENERGY",
      "error",
      "energy",
      "Energy values must be finite numbers between 0 and 1.",
    ));
  }

  if (issues.some((item) => item.severity === "error")) {
    return { success: false, issues };
  }
  const data = input as SongModelCore;
  addMusicalIssues(data, issues);
  if (issues.some((item) => item.severity === "error")) {
    return { success: false, issues };
  }
  return { success: true, data, issues };
}

function primaryTempo(model: SongModelCore): number {
  return model.tempoMap[0].bpm;
}

function primaryKey(model: SongModelCore): string {
  return model.keyMap[0].key.trim().toLowerCase().replaceAll("♯", "#").replaceAll("♭", "b");
}

function compatibilityWith(
  candidate: SongModelCore,
  reference: SongModelCore,
): { score: number; issues: MutableIssue[] } {
  const issues: MutableIssue[] = [];
  let score = 1;
  const tempoDifference = Math.abs(primaryTempo(candidate) - primaryTempo(reference)) /
    Math.max(primaryTempo(reference), 1);
  if (tempoDifference > 0.08) {
    score -= 0.45;
    issues.push(issue(
      "TEMPO_CANDIDATE_CONFLICT",
      "warning",
      "tempoMap",
      "Provider tempo differs from another valid candidate by more than 8%.",
    ));
  }
  if (primaryKey(candidate) !== primaryKey(reference)) {
    score -= 0.2;
    issues.push(issue(
      "KEY_CANDIDATE_CONFLICT",
      "warning",
      "keyMap",
      "Provider key differs from the confidence leader.",
    ));
  }
  if (candidate.sections.length !== reference.sections.length) {
    score -= 0.2;
    issues.push(issue(
      "SECTION_CANDIDATE_CONFLICT",
      "warning",
      "sections",
      "Provider section count differs from the confidence leader.",
    ));
  }
  return { score: Math.max(0, Number(score.toFixed(3))), issues };
}

export function fuseProviderSongModels(
  responses: ProviderSongModelResponse[],
): FusionResult {
  const decisions: ProviderFusionDecision[] = [];
  const valid: Array<{
    provider: string;
    model: SongModelCore;
    original: unknown;
    confidence: number;
    issues: SongModelValidationIssue[];
  }> = [];

  for (const response of responses) {
    const responseIssues: MutableIssue[] = [];
    if (!response.provider.trim()) {
      responseIssues.push(issue(
        "MISSING_PROVIDER",
        "error",
        "provider",
        "Provider name is required.",
      ));
    }
    if (!isFiniteNumber(response.confidence) || response.confidence < 0 || response.confidence > 1) {
      responseIssues.push(issue(
        "INVALID_PROVIDER_CONFIDENCE",
        "error",
        "confidence",
        "Provider confidence must be between 0 and 1.",
      ));
    }
    const validation = validateSongModelCore(response.output);
    responseIssues.push(...validation.issues);
    if (isRecord(response.output) && response.output.vocalIntelligence !== undefined) {
      const duration = isRecord(response.output.audio) && isFiniteNumber(response.output.audio.durationSeconds)
        ? response.output.audio.durationSeconds : undefined;
      validateVocalIntelligence(
        response.output.vocalIntelligence,
        duration,
        responseIssues,
        response.output.vocalEvidence,
        Array.isArray(response.output.lyrics) ? response.output.lyrics : [],
        Array.isArray(response.output.melody) ? response.output.melody : [],
        response.output,
      );
    }
    const providerIssues = responseIssues.map((item) => ({ ...item, provider: response.provider }));
    if (!validation.success || providerIssues.some((item) => item.severity === "error")) {
      decisions.push({
        provider: response.provider || "unknown",
        status: "rejected",
        confidence: isFiniteNumber(response.confidence) ? response.confidence : 0,
        compatibility: 0,
        issues: providerIssues,
      });
      continue;
    }
    valid.push({
      provider: response.provider,
      model: validation.data,
      original: response.output,
      confidence: response.confidence,
      issues: providerIssues,
    });
  }

  if (valid.length === 0) {
    const issues = decisions.flatMap((decision) => decision.issues);
    return {
      accepted: false,
      issues: issues.length
        ? issues
        : [issue("NO_PROVIDER_OUTPUT", "error", "", "No provider returned a usable Song Model.")],
      decisions,
    };
  }

  let selected:
    | (typeof valid)[number] & { compatibility: number; compatibilityIssues: SongModelValidationIssue[] }
    | undefined;
  for (const candidate of valid) {
    const peerCompatibility = valid
      .filter((peer) => peer.provider !== candidate.provider)
      .map((peer) => compatibilityWith(candidate.model, peer.model));
    const compatibility = peerCompatibility.length
      ? {
          score: Number(
            (
              peerCompatibility.reduce((sum, result) => sum + result.score, 0) /
              peerCompatibility.length
            ).toFixed(3),
          ),
          issues: peerCompatibility.flatMap((result) => result.issues),
        }
      : { score: 1, issues: [] };
    const candidateIssues = [
      ...candidate.issues,
      ...compatibility.issues.map((item) => ({ ...item, provider: candidate.provider })),
    ];
    const hasBlockingIssue = candidateIssues.some((item) => item.severity === "error");
    const decision: ProviderFusionDecision = {
      provider: candidate.provider,
      status: hasBlockingIssue
        ? "rejected"
        : candidateIssues.length
          ? "flagged"
          : "accepted",
      confidence: candidate.confidence,
      compatibility: compatibility.score,
      issues: candidateIssues,
    };
    decisions.push(decision);
    if (
      !hasBlockingIssue &&
      compatibility.score >= 0.55 &&
      (!selected ||
        candidate.confidence * compatibility.score >
          selected.confidence * selected.compatibility)
    ) {
      selected = {
        ...candidate,
        compatibility: compatibility.score,
        compatibilityIssues: candidateIssues,
      };
    }
  }

  if (!selected) {
    return {
      accepted: false,
      issues: decisions.flatMap((decision) => decision.issues),
      decisions,
    };
  }
  const selectedDecision = decisions.find((decision) => decision.provider === selected.provider);
  if (selectedDecision) selectedDecision.status = "selected";
  const overallConfidence = Number(
    Math.min(1, selected.confidence * selected.compatibility).toFixed(3),
  );
  const selectedWarnings = [
    ...selected.issues.filter((item) => item.severity === "warning"),
    ...(selected.compatibility < 0.75
      ? selected.compatibilityIssues.filter((item) => item.severity === "warning")
      : []),
  ];
  const model = {
    ...(isRecord(selected.original) ? selected.original : {}),
    ...canonicalizeCoordinates(selected.model),
    vocalEvidence: canonicalizeCoordinates(selected.model).vocalEvidence ?? {
          status: "not_available" as const,
          reason: "No decoded vocal or voice stem PCM evidence was supplied.",
          provenance: null,
          sampleRate: null,
          channels: null,
          frameSizeSamples: null,
          thresholds: null,
          observedVoicedWindows: [],
          observedSilentWindows: [],
        },
    vocalIntelligence: canonicalizeCoordinates(selected.model).vocalIntelligence ??
      unavailableVocalIntelligence("No verified phrase-level vocal evidence was supplied."),
    contractVersion: SONG_MODEL_CONTRACT_VERSION,
    timebase: {
      ppq: CANONICAL_SONG_MODEL_PPQ,
      originSeconds: 0,
      coordinateSystem: "seconds+ticks",
    },
    validation: {
      status: selectedWarnings.length ? "flagged" : "accepted",
      issues: selectedWarnings,
    },
    fusion: {
      selectedProvider: selected.provider,
      confidence: overallConfidence,
      decisions,
    },
  } as SongModelData;
  return { accepted: true, model: canonicalizeSongModelCoordinates(model), decisions };
}

export function validateCanonicalSongModel(input: unknown): ValidationResult<SongModelData> {
  const core = validateSongModelCore(input);
  if (!core.success) return { success: false, issues: core.issues };
  if (!isRecord(input)) {
    return {
      success: false,
      issues: [issue("INVALID_SONG_MODEL", "error", "", "Song Model must be an object.")],
    };
  }
  const issues = [...core.issues];
  if (
    input.contractVersion !== SONG_MODEL_CONTRACT_VERSION &&
    input.contractVersion !== LEGACY_SONG_MODEL_CONTRACT_VERSION
  ) {
    issues.push(issue(
      "UNSUPPORTED_CONTRACT_VERSION",
      "error",
      "contractVersion",
      `Song Model contractVersion must be ${LEGACY_SONG_MODEL_CONTRACT_VERSION} or ${SONG_MODEL_CONTRACT_VERSION}.`,
    ));
  }
  if (input.contractVersion === SONG_MODEL_CONTRACT_VERSION) {
    if (
      !isRecord(input.timebase) ||
      input.timebase.ppq !== CANONICAL_SONG_MODEL_PPQ ||
      input.timebase.originSeconds !== 0 ||
      input.timebase.coordinateSystem !== "seconds+ticks"
    ) {
      issues.push(issue(
        "INVALID_TIMEBASE",
        "error",
        "timebase",
        `Song Model ${SONG_MODEL_CONTRACT_VERSION} requires PPQ ${CANONICAL_SONG_MODEL_PPQ}, zero-second origin, and seconds+ticks coordinates.`,
      ));
    }
    validateVocalEvidence(input.vocalEvidence, isRecord(input.audio) && isFiniteNumber(input.audio.durationSeconds)
      ? input.audio.durationSeconds : undefined, issues);
    validateVocalIntelligence(
      input.vocalIntelligence,
      isRecord(input.audio) && isFiniteNumber(input.audio.durationSeconds) ? input.audio.durationSeconds : undefined,
      issues,
      input.vocalEvidence,
      Array.isArray(input.lyrics) ? input.lyrics : [],
      Array.isArray(input.melody) ? input.melody : [],
      input,
    );
    validateV2Coordinates(input, issues);
  }
  if (!isRecord(input.validation) || !["accepted", "flagged"].includes(String(input.validation.status))) {
    issues.push(issue(
      "MISSING_VALIDATION_DECISION",
      "error",
      "validation",
      "Song Model must include an accepted or flagged validation decision.",
    ));
  } else if (!Array.isArray(input.validation.issues)) {
    issues.push(issue(
      "INVALID_VALIDATION_ISSUES",
      "error",
      "validation.issues",
      "Song Model validation issues must be an array.",
    ));
  }
  if (
    !isRecord(input.fusion) ||
    !(
      input.fusion.selectedProvider === null ||
      (
        typeof input.fusion.selectedProvider === "string" &&
        input.fusion.selectedProvider.trim()
      )
    ) ||
    !isFiniteNumber(input.fusion.confidence) ||
    input.fusion.confidence < 0 ||
    input.fusion.confidence > 1 ||
    !Array.isArray(input.fusion.decisions)
  ) {
    issues.push(issue(
      "MISSING_FUSION_DECISION",
      "error",
      "fusion",
      "Song Model must include provider fusion decisions.",
    ));
  } else {
    const decisions = input.fusion.decisions;
    decisions.forEach((decision, index) => {
      const path = `fusion.decisions.${index}`;
      if (!isRecord(decision)) {
        issues.push(issue("INVALID_FUSION_DECISION", "error", path, "Fusion decision must be an object."));
        return;
      }
      if (typeof decision.provider !== "string" || !decision.provider.trim()) {
        issues.push(issue(
          "INVALID_FUSION_PROVIDER",
          "error",
          `${path}.provider`,
          "Fusion decision provider is required.",
        ));
      }
      if (!["selected", "accepted", "flagged", "rejected"].includes(String(decision.status))) {
        issues.push(issue(
          "INVALID_FUSION_STATUS",
          "error",
          `${path}.status`,
          "Fusion decision status is invalid.",
        ));
      }
      confidenceValue(decision.confidence, `${path}.confidence`, issues);
      if (!isFiniteNumber(decision.compatibility) || decision.compatibility < 0 || decision.compatibility > 1) {
        issues.push(issue(
          "INVALID_COMPATIBILITY",
          "error",
          `${path}.compatibility`,
          "Compatibility must be between 0 and 1.",
        ));
      }
      if (!Array.isArray(decision.issues)) {
        issues.push(issue(
          "INVALID_FUSION_ISSUES",
          "error",
          `${path}.issues`,
          "Fusion decision issues must be an array.",
        ));
      }
    });
    const selected = decisions.filter((decision) =>
      isRecord(decision) && decision.status === "selected"
    );
    const selectedProvider = input.fusion.selectedProvider;
    if (
      (selectedProvider === null && selected.length !== 0) ||
      (
        selectedProvider !== null &&
        (
          selected.length !== 1 ||
          !isRecord(selected[0]) ||
          selected[0].provider !== selectedProvider
        )
      )
    ) {
      issues.push(issue(
        "INVALID_SELECTED_PROVIDER",
        "error",
        "fusion.selectedProvider",
        "Fusion metadata must identify exactly one selected provider, or none when all candidates were rejected.",
      ));
    }
  }
  return issues.some((item) => item.severity === "error")
    ? { success: false, issues }
    : { success: true, data: input as SongModelData, issues };
}

export function refreshSongModelValidation(model: SongModelData): SongModelData {
  const coordinated = model.contractVersion === SONG_MODEL_CONTRACT_VERSION
    ? canonicalizeSongModelCoordinates(model)
    : model;
  const validation = model.contractVersion === SONG_MODEL_CONTRACT_VERSION
    ? validateCanonicalSongModel(coordinated)
    : validateSongModelCore(coordinated);
  return {
    ...coordinated,
    validation: {
      status: validation.issues.length ? "flagged" : "accepted",
      issues: validation.issues,
    },
  };
}

export type ArrangementEligibility =
  | { eligible: true; model: SongModelData }
  | {
      eligible: false;
      code: string;
      message: string;
      action: string;
      issues: SongModelValidationIssue[];
    };

export function evaluateArrangementEligibility(
  input: unknown,
  status: string,
  confidence: number,
): ArrangementEligibility {
  if (status !== "ready") {
    return {
      eligible: false,
      code: "SONG_MODEL_NOT_READY",
      message: "Arrangement generation is blocked because analysis is not ready.",
      action: "Wait for analysis to finish, then try again.",
      issues: [],
    };
  }
  const validation = validateCanonicalSongModel(input);
  if (!validation.success) {
    return {
      eligible: false,
      code: "INVALID_SONG_MODEL",
      message: "Arrangement generation is blocked because the Song Model failed validation.",
      action: "Re-run analysis or review the flagged tempo, structure, melody, and harmony inputs.",
      issues: validation.issues,
    };
  }
  if (validation.data.validation.status === "flagged") {
    return {
      eligible: false,
      code: "SONG_MODEL_FLAGGED",
      message: "Arrangement generation is blocked because the selected Song Model contains unresolved musical reliability flags.",
      action: "Review the flagged tempo, melody, or harmony findings and re-run analysis before arranging.",
      issues: validation.data.validation.issues,
    };
  }
  const effectiveConfidence = isFiniteNumber(confidence)
    ? Math.min(confidence, validation.data.fusion.confidence)
    : confidence;
  if (!isFiniteNumber(effectiveConfidence) || effectiveConfidence < MIN_ARRANGEMENT_CONFIDENCE) {
    return {
      eligible: false,
      code: "LOW_SONG_MODEL_CONFIDENCE",
      message: `Arrangement generation requires Song Model confidence of at least ${MIN_ARRANGEMENT_CONFIDENCE}.`,
      action: "Upload a cleaner recording or re-run analysis with another provider.",
      issues: [issue(
        "LOW_SONG_MODEL_CONFIDENCE",
        "error",
        "confidence",
        `Compatibility-adjusted confidence is ${
          isFiniteNumber(effectiveConfidence) ? effectiveConfidence : "invalid"
        }.`,
      )],
    };
  }
  return { eligible: true, model: validation.data };
}
