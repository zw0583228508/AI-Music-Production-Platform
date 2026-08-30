import type {
  ProviderFusionDecision,
  SongModelCore,
  SongModelData,
  SongModelValidationIssue,
} from "@workspace/db";

export const SONG_MODEL_CONTRACT_VERSION = "1.0" as const;
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

type MutableIssue = Omit<SongModelValidationIssue, "provider"> & { provider?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

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
    ...selected.model,
    contractVersion: SONG_MODEL_CONTRACT_VERSION,
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
  return { accepted: true, model, decisions };
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
  if (input.contractVersion !== SONG_MODEL_CONTRACT_VERSION) {
    issues.push(issue(
      "UNSUPPORTED_CONTRACT_VERSION",
      "error",
      "contractVersion",
      `Song Model contractVersion must be ${SONG_MODEL_CONTRACT_VERSION}.`,
    ));
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
  const validation = validateSongModelCore(model);
  return {
    ...model,
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
