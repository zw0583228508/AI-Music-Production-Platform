import type {
  ArrangementPlan,
  ArrangementPlanSection,
  ArtifactProvenance,
  ArrangementSection,
  InstrumentDefinition,
  MusicalNote,
  StyleSpec,
  TrackModel,
  SongModelData,
  ControlEvent,
  ArticulationEvent,
  AutomationPoint,
  TrackDirective,
} from "@workspace/db";
import { createHash } from "node:crypto";

export type PerformanceNote = MusicalNote & {
  articulation: string;
  timingOffset: number;
  releaseVelocity: number;
};

export type PerformanceProfile = {
  timing: number;
  velocityVariation: number;
  legatoOverlap: number;
  accentEvery: number;
  ccRate: number;
};

export type RenderedTrack = {
  trackModel: TrackModel;
  samples: Float32Array;
  renderer: "LOCAL_EXPRESSIVE_SYNTH" | "SFIZZ_VSCO2_CE" | "PEDALBOARD_VST3";
  rendererStatus?: "licensed-native" | "deterministic-fallback";
  fallbackReason?: string;
  rendererAttestation?: NativeRendererAttestation;
};

export type NativeRendererAttestation = {
  provider: string;
  modelVersion: string;
  assetId: string;
  assetIdentity: string;
  assetSha256: string;
  licenseOwner: string;
  licenseReference: string;
  rendererIdentity: string;
  rendererSha256: string;
  smokeOutputSha256: string;
  trackModelSha256: string;
  rendererOutputSha256: string;
};

export type LicensedInstrumentSmokeEvidence = {
  assetId: string;
  sha256: string;
  rendererIdentity: string;
  rendererSha256: string;
  trackModelRendered: boolean;
  audible: boolean;
  canonicalSensitivity: boolean;
  nativeHostAttested: boolean;
  outputSha256: string;
  pitchVariantSha256: string;
  expressionVariantSha256: string;
  peak: number;
  sampleRate: number;
  durationSeconds: number;
  format: string;
};

export type LicensedInstrumentPack = {
  candidateId?: string;
  historyId?: string;
  kind?: "vst3" | "sfz";
  assetId?: string;
  id?: string;
  identity?: string;
  licenseOwner?: string;
  licenseReference?: string;
  rendererIdentity?: string;
  sha256?: string;
  rendererSha256?: string;
  status: "unavailable" | "verified" | "active";
  smokeEvidence?: LicensedInstrumentSmokeEvidence;
  createdAt?: string;
  activatedAt?: string;
  deactivatedAt?: string;
  unavailableReason?: string;
};

export type LicensedInstrumentPackCatalog = {
  active: {
    vst3: LicensedInstrumentPack;
    sfz: LicensedInstrumentPack;
  };
  candidates: LicensedInstrumentPack[];
  history: {
    vst3: LicensedInstrumentPack[];
    sfz: LicensedInstrumentPack[];
  };
};

export class LicensedInstrumentWorkerError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
  ) {
    super(
      `Licensed instrument worker returned HTTP ${status}: ${responseText.slice(0, 500)}`,
    );
    this.name = "LicensedInstrumentWorkerError";
  }
}
type NativeRenderResult = {
  samples: Float32Array;
  attestation: NativeRendererAttestation;
};

export function licensedInstrumentWorkerConfig(): {
  endpoint: string;
  headers: Record<string, string>;
} {
  const endpoint = [
    process.env.MUSIC_AI_WORKER_URL,
    process.env.SFIZZ_RENDER_API_URL,
    process.env.PEDALBOARD_VST3_API_URL,
  ].find((value): value is string => Boolean(value?.trim()));
  if (!endpoint) {
    throw new Error("Licensed instrument worker is not configured");
  }
  const token =
    process.env.MUSIC_AI_WORKER_TOKEN ??
    process.env.SFIZZ_RENDER_API_TOKEN ??
    process.env.PEDALBOARD_VST3_API_TOKEN;
  return {
    endpoint,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  };
}

async function licensedInstrumentWorkerJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const worker = licensedInstrumentWorkerConfig();
  const response = await fetch(new URL(path, worker.endpoint), {
    ...init,
    headers: {
      ...worker.headers,
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new LicensedInstrumentWorkerError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export async function listLicensedInstrumentPacks(): Promise<LicensedInstrumentPackCatalog> {
  return licensedInstrumentWorkerJson<LicensedInstrumentPackCatalog>("/admin/assets", {
    cache: "no-store",
  });
}

export async function activateLicensedInstrumentPack(
  candidateId: string,
): Promise<LicensedInstrumentPack> {
  return licensedInstrumentWorkerJson<LicensedInstrumentPack>(
    `/admin/assets/${encodeURIComponent(candidateId)}/activate`,
    { method: "POST" },
  );
}

export async function reactivateLicensedInstrumentPack(
  historyId: string,
): Promise<LicensedInstrumentPack> {
  return licensedInstrumentWorkerJson<LicensedInstrumentPack>(
    `/admin/assets/history/${encodeURIComponent(historyId)}/activate`,
    { method: "POST" },
  );
}
export type QualityReport = {
  score: number;
  checks: Record<string, number>;
  weights: Record<string, number>;
  strengths: string[];
  weaknesses: string[];
  warnings: string[];
  evaluatedAt: string;
  renderArtifactIds: string[];
  lineageComplete: boolean;
};

export type RenderPipelineResult = {
  tracks: RenderedTrack[];
  mix: Float32Array;
  premaster: Float32Array;
  master: Float32Array;
  quality: QualityReport;
  provenance: ArtifactProvenance[];
  durationSeconds: number;
};

const clamp = (value: number, min = 0, max = 1): number =>
  Math.max(min, Math.min(max, value));

export function secondsPerBar(bpm: number, meter = "4/4"): number {
  const [rawNumerator, rawDenominator] = meter.split("/").map(Number);
  const numerator = Number.isFinite(rawNumerator) && rawNumerator > 0
    ? rawNumerator
    : 4;
  const denominator = Number.isFinite(rawDenominator) && rawDenominator > 0
    ? rawDenominator
    : 4;
  return 60 / Math.max(40, bpm || 92) * numerator * (4 / denominator);
}

const round = (value: number, digits = 4): number =>
  Number(value.toFixed(digits));

const midi = (value: number): number => Math.max(0, Math.min(127, Math.round(value)));

const hashSeed = (value: string): number => {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
};

function provenance(
  model: string,
  version: string,
  parameters: Record<string, number | string | boolean>,
  parentIds: string[] = [],
): ArtifactProvenance {
  return { model, version, parameters, parentIds, createdBy: "arrangement-engine" };
}

const RANGE = (min: number, max: number) => ({
  min,
  max,
  registers: [
    { name: "low", min, max: Math.round(min + (max - min) * 0.32), character: "warm" },
    { name: "middle", min: Math.round(min + (max - min) * 0.25), max: Math.round(min + (max - min) * 0.75), character: "core" },
    { name: "high", min: Math.round(min + (max - min) * 0.68), max, character: "bright" },
  ],
});
const directiveMappings = (id: string) => ({
  registers: {
    low: { min: id === "bass" ? 28 : 36, max: id === "bass" ? 45 : 60 },
    middle: { min: id === "bass" ? 36 : 48, max: id === "bass" ? 60 : 78 },
    high: { min: id === "bass" ? 48 : 60, max: id === "bass" ? 67 : 96 },
  },
  articulationFamilies: {
    legato: ["legato", "sustain", "normal", "finger"],
    accent: ["marcato", "hard", "pick", "snare", "kick"],
    tight: ["staccato", "spiccato", "mute", "closed_hat"],
  },
  dynamicTargets: { pp: 42, mp: 64, mf: 84, f: 108 },
  controls: { dynamics: 1, expression: 11, articulation: 32 },
});

export function getInstrumentDefinition(instrument: string, role = ""): InstrumentDefinition {
  const id = instrument.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const normalized = `${id} ${role.toLowerCase()}`;
  if (normalized.includes("drum") || normalized.includes("percussion") || normalized.includes("rhythm")) {
    return {
      id: "drums",
      family: "drums",
      playableRange: { min: 35, max: 81 },
      comfortableRange: { min: 36, max: 60 },
      registers: RANGE(35, 81).registers,
      polyphonic: true,
      maxVoices: 4,
      articulations: ["kick", "snare", "ghost", "flam", "closed_hat", "open_hat", "ride", "tom_fill"],
      constraints: { maxLeap: 46, minNoteDuration: 0.04, maxSimultaneousNotes: 4, hands: 2, feet: 2 },
      controls: { dynamics: [1, 11], expression: [11], pitchBend: false, aftertouch: false },
      directiveMappings: directiveMappings("drums"),
    };
  }
  if (normalized.includes("bass")) {
    return {
      id: "bass",
      family: "strings",
      playableRange: { min: 28, max: 67 },
      comfortableRange: { min: 36, max: 60 },
      registers: RANGE(28, 67).registers,
      polyphonic: false,
      maxVoices: 1,
      articulations: ["finger", "pick", "slap", "mute", "slide"],
      constraints: { maxLeap: 12, minNoteDuration: 0.08, maxSimultaneousNotes: 1, strings: 4 },
      controls: { dynamics: [1], expression: [11], pitchBend: true, aftertouch: false },
      directiveMappings: directiveMappings("bass"),
    };
  }
  if (normalized.includes("violin") || normalized.includes("cello") || normalized.includes("string")) {
    const cello = normalized.includes("cello");
    const range = cello ? { min: 36, max: 84 } : { min: 55, max: 103 };
    return {
      id: cello ? "cello" : "strings",
      family: "strings",
      playableRange: range,
      comfortableRange: cello ? { min: 43, max: 74 } : { min: 60, max: 91 },
      registers: RANGE(range.min, range.max).registers,
      polyphonic: true,
      maxVoices: cello ? 2 : 4,
      articulations: ["legato", "sustain", "staccato", "spiccato", "pizzicato", "tremolo", "trill", "harmonic", "vibrato"],
      constraints: { maxLeap: cello ? 12 : 10, minNoteDuration: 0.1, maxSimultaneousNotes: cello ? 2 : 4, strings: 4 },
      controls: { dynamics: [1], expression: [11], pitchBend: true, aftertouch: true },
      directiveMappings: directiveMappings(cello ? "cello" : "strings"),
    };
  }
  if (normalized.includes("horn") || normalized.includes("brass") || normalized.includes("trumpet")) {
    return {
      id: "brass",
      family: "brass",
      playableRange: { min: 40, max: 82 },
      comfortableRange: { min: 48, max: 74 },
      registers: RANGE(40, 82).registers,
      polyphonic: false,
      maxVoices: 1,
      articulations: ["legato", "marcato", "staccato", "fall", "doit", "shake", "mute"],
      constraints: { maxLeap: 12, minNoteDuration: 0.12, maxSimultaneousNotes: 1, breathSeconds: 8 },
      controls: { dynamics: [1], expression: [11], pitchBend: true, aftertouch: true },
      directiveMappings: directiveMappings("brass"),
    };
  }
  if (normalized.includes("guitar")) {
    return {
      id: "guitar",
      family: "guitar",
      playableRange: { min: 40, max: 88 },
      comfortableRange: { min: 45, max: 79 },
      registers: RANGE(40, 88).registers,
      polyphonic: true,
      maxVoices: 6,
      articulations: ["pick", "strum_up", "strum_down", "slide", "hammer_on", "pull_off", "palm_mute"],
      constraints: { maxLeap: 16, minNoteDuration: 0.08, maxSimultaneousNotes: 6, strings: 6, frets: 22 },
      controls: { dynamics: [1], expression: [11], pitchBend: true, aftertouch: false },
      directiveMappings: directiveMappings("guitar"),
    };
  }
  if (normalized.includes("pad") || normalized.includes("synth")) {
    return {
      id: "synth_pad",
      family: "synth",
      playableRange: { min: 24, max: 108 },
      comfortableRange: { min: 40, max: 88 },
      registers: RANGE(24, 108).registers,
      polyphonic: true,
      maxVoices: 8,
      articulations: ["sustain", "pluck", "rise", "fall"],
      constraints: { maxLeap: 24, minNoteDuration: 0.2, maxSimultaneousNotes: 8 },
      controls: { dynamics: [1], expression: [11], sustain: 64, pitchBend: true, aftertouch: true },
      directiveMappings: directiveMappings("synth_pad"),
    };
  }
  return {
    id: "piano",
    family: "keys",
    playableRange: { min: 21, max: 108 },
    comfortableRange: { min: 36, max: 96 },
    registers: RANGE(21, 108).registers,
    polyphonic: true,
    maxVoices: 10,
    articulations: ["soft", "normal", "hard", "sustain", "staccato"],
    constraints: { maxLeap: 24, minNoteDuration: 0.05, maxSimultaneousNotes: 10, hands: 2 },
    controls: { dynamics: [1], expression: [11], sustain: 64, pitchBend: false, aftertouch: true },
    directiveMappings: directiveMappings("piano"),
  };
}

export function createStyleSpec(
  style: string,
  controls: { density: number; harmonyComplexity: number; energy: number; orchestraSize?: number; rhythmIntensity?: number },
): StyleSpec {
  const genre = style.split(/\s+/)[0]?.toLowerCase() || "pop";
  const cinematic = style.toLowerCase().includes("cinematic") || style.toLowerCase().includes("orchestra");
  return {
    genre,
    subgenre: style.toLowerCase().replace(/\s+/g, "_"),
    era: "modern",
    tempoCharacter: controls.energy > 0.72 ? "driving" : "steady",
    rhythm: { swing: genre === "jazz" ? 0.18 : 0, syncopation: clamp(controls.density * 0.45 + (controls.rhythmIntensity ?? .6) * .4), subdivision: (controls.rhythmIntensity ?? .6) > .72 || genre === "edm" ? "16th" : "8th" },
    harmony: { complexity: controls.harmonyComplexity, tension: clamp((controls.harmonyComplexity - 1) / 9), voicing: cinematic ? "wide" : "close" },
    instrumentation: { preferredFamilies: cinematic ? ["keys", "strings", "brass", "drums"] : ["keys", "strings", "bass", "drums"], avoid: [] },
    orchestration: { density: clamp(controls.density * .65 + (controls.orchestraSize ?? .5) * .35), registerSpread: clamp((cinematic ? .72 : .48) + (controls.orchestraSize ?? .5) * .35), dynamics: controls.energy > 0.7 ? "arc" : "intimate" },
    production: { stereoWidth: cinematic ? 0.85 : 0.65, room: cinematic ? "scoring_stage" : "studio", mixProfile: "streaming" },
    dynamics: { range: cinematic ? 0.8 : 0.6, accentStrength: clamp(0.35 + controls.energy * 0.5) },
  };
}

function operationForTrack(
  track: { name: string; role: string },
  section: Pick<ArrangementSection, "energy">,
): string {
  const identity = `${track.name} ${track.role}`.toLowerCase();
  if (identity.includes("drum") || identity.includes("rhythm")) return section.energy > 0.55 ? "groove_and_fills" : "none";
  if (identity.includes("bass")) return section.energy > 0.4 ? "root_motion" : "minimal";
  if (identity.includes("string")) return section.energy > 0.72 ? "countermelody" : "pad";
  if (identity.includes("brass") || identity.includes("horn")) return section.energy > 0.65 ? "accent_stabs" : "none";
  return section.energy > 0.7 ? "rhythmic_harmony" : "main_harmony";
}

export type ArrangementBrainSection = {
  function: "intro" | "verse" | "prechorus" | "chorus" | "bridge" | "outro" | "neutral";
  targetEnergy: number;
  targetDensity: number;
  development: "initial" | "development" | "reprise" | "neutral";
};

export type ArrangementBrain = {
  version: "1.0.0";
  enabled: boolean;
  sections: ArrangementBrainSection[];
};

/**
 * A deliberately small, evidence-bound global arranger. It only interprets
 * names already present in the Song Model and its measured relative energy;
 * it never adds, moves, or renames sections.
 */
export function buildArrangementBrain(input: {
  songModel: SongModelData;
  controls: { energy: number; density: number; orchestraSize?: number };
}): ArrangementBrain {
  const sections = input.songModel.sections;
  const neutral = (): ArrangementBrain => ({
    version: "1.0.0",
    enabled: false,
    sections: sections.map(() => ({
      function: "neutral",
      targetEnergy: 0,
      targetDensity: 0,
      development: "neutral",
    })),
  });
  if (sections.length < 2) return neutral();
  const classify = (name: string): ArrangementBrainSection["function"] => {
    const value = name.toLowerCase().replace(/[_-]/g, " ");
    if (/\bintro\b|\bopening\b/.test(value)) return "intro";
    if (/\b(pre[\s ]?chorus|build|riser)\b/.test(value)) return "prechorus";
    if (/\b(chorus|drop|hook)\b/.test(value)) return "chorus";
    if (/\b(bridge|breakdown|break)\b/.test(value)) return "bridge";
    if (/\b(outro|ending|coda)\b/.test(value)) return "outro";
    if (/\bverse\b/.test(value)) return "verse";
    return "neutral";
  };
  const functions = sections.map((section) => classify(section.name));
  const recognized = functions.filter((value) => value !== "neutral").length;
  const observed = sections.map((section) => clamp(Number(section.energy)));
  const range = Math.max(...observed) - Math.min(...observed);
  // A single familiar label is insufficient to impose an invented arc. Names
  // must describe a meaningful portion of the observed form, or repeat with
  // actual energy contrast.
  const chorusCount = functions.filter((value) => value === "chorus").length;
  if (recognized < 2 && !(chorusCount >= 2 && range >= .12)) return neutral();

  const controlEnergy = clamp(input.controls.energy);
  const controlDensity = clamp(input.controls.density);
  const raw = sections.map((section, index) => {
    const fn = functions[index];
    const functionOffset = fn === "intro" ? -.18 : fn === "verse" ? -.06
      : fn === "prechorus" ? .06 : fn === "chorus" ? .16
        : fn === "bridge" ? -.14 : fn === "outro" ? -.1 : 0;
    return clamp(observed[index] * .6 + controlEnergy * .4 + functionOffset);
  });
  const lastClimax = functions.reduce((last, fn, index) => fn === "chorus" ? index : last, -1);
  if (lastClimax >= 0) raw[lastClimax] = Math.max(raw[lastClimax], ...raw) ;
  // Maintain an intelligible whole-song contour rather than allowing each
  // local section to make a discontinuous independent decision.
  const targetEnergy = raw.reduce<number[]>((result, value) => {
    if (!result.length) return [value];
    const previous = result[result.length - 1];
    result.push(clamp(value, previous - .28, previous + .28));
    return result;
  }, []);
  const occurrences = new Map<ArrangementBrainSection["function"], number>();
  const drafts = targetEnergy.map((energy, index) => {
      const fn = functions[index];
      const occurrence = occurrences.get(fn) ?? 0;
      occurrences.set(fn, occurrence + 1);
      const development: ArrangementBrainSection["development"] = fn === "chorus" && occurrence > 0
        ? (occurrence === 1 ? "development" : "reprise")
        : fn === "neutral" ? "neutral" : "initial";
      const developedEnergy = development === "development" || development === "reprise"
        ? clamp(energy + .04) : energy;
      return { function: fn, energy: developedEnergy, development };
    });
  const continuous = drafts.reduce<Array<typeof drafts[number]>>((result, draft) => {
    const previous = result.at(-1);
    result.push({
      ...draft,
      energy: previous ? clamp(draft.energy, previous.energy - .28, previous.energy + .28) : draft.energy,
    });
    return result;
  }, []);
  return {
    version: "1.0.0",
    enabled: true,
    sections: continuous.map(({ function: fn, energy, development }) => ({
      function: fn,
      targetEnergy: round(energy),
      targetDensity: round(clamp(
        controlDensity * .5 + energy * .5 +
        (development === "development" || development === "reprise" ? .04 : 0),
      )),
      development,
    })),
  };
}

export function createArrangementPlan(input: {
  arrangementId: string;
  version: number;
  songModel: SongModelData;
  style: StyleSpec;
  tracks: Array<{ id?: string; name: string; role: string }>;
  parameters: Record<string, number | string | boolean>;
  parentIds?: string[];
  arrangementBrain?: ArrangementBrain;
}): ArrangementPlan {
  const sourceSections = input.songModel.sections.length
    ? input.songModel.sections
    : [{ name: "Full Song", startBar: 1, endBar: 16, energy: input.style.dynamics.accentStrength }];
  const modulationSemitones = Number(input.parameters.modulationSemitones ?? 0);
  const orchestraSize = clamp(Number(input.parameters.orchestraSize ?? .5));
  const rhythmIntensity = clamp(Number(input.parameters.rhythmIntensity ?? .6));
  const arrangementBrain = input.arrangementBrain ?? buildArrangementBrain({
    songModel: input.songModel,
    controls: {
      energy: Number(input.parameters.energy ?? input.style.dynamics.accentStrength),
      density: Number(input.parameters.density ?? input.style.orchestration.density),
      orchestraSize,
    },
  });
  let priorLayerCount: number | undefined;
  const sections: ArrangementPlanSection[] = sourceSections.map((section, index) => {
    const brainSection = arrangementBrain.enabled ? arrangementBrain.sections[index] : undefined;
    const plannedEnergy = brainSection?.targetEnergy ?? section.energy;
    const plannedDensity = brainSection?.targetDensity ??
      clamp(input.style.orchestration.density * 0.65 + section.energy * 0.35);
    const operations = plannedEnergy > 0.75
      ? ["build_up", "countermelody"]
      : plannedEnergy < 0.3
        ? ["break"]
        : ["phrase"];
    if (index === sourceSections.length - 1 && modulationSemitones !== 0) {
      operations.push(`modulate:${modulationSemitones}`);
    }
    const directives: Record<string, TrackDirective> = {};
    const unconstrainedLayers = Math.max(1, Math.ceil(input.tracks.length *
      clamp(.25 + orchestraSize * .55 + plannedEnergy * .2)));
    const layerCount = arrangementBrain.enabled && priorLayerCount !== undefined
      ? clamp(unconstrainedLayers, Math.max(1, priorLayerCount - 1), Math.min(input.tracks.length, priorLayerCount + 1))
      : unconstrainedLayers;
    priorLayerCount = layerCount;
    const ordered = [...input.tracks].sort((left, right) =>
      Number(/bass|drum|rhythm/.test(`${right.name} ${right.role}`.toLowerCase())) -
      Number(/bass|drum|rhythm/.test(`${left.name} ${left.role}`.toLowerCase())));
    const enabledIds = new Set(ordered.slice(0, layerCount).map((track) => track.id ?? track.name));
    const tracks = Object.fromEntries(input.tracks.map((track) => {
      const identity = `${track.name} ${track.role}`.toLowerCase();
      const trackId = track.id ?? track.name;
      const operation = enabledIds.has(trackId) ? operationForTrack(track, { energy: plannedEnergy }) : "none";
      const percussion = /drum|rhythm|percussion/.test(identity);
      const bass = identity.includes("bass");
      const melodic = /vocal|voice|melody/.test(identity);
      directives[trackId] = {
        role: track.role,
        register: bass ? "low" : melodic ? "high" : plannedEnergy > .68 ? "high" : "middle",
        rhythmicActivity: round(clamp(percussion
          ? plannedEnergy * .45 + rhythmIntensity * .55
          : (input.style.rhythm.syncopation * .45 + plannedEnergy * .55) * (.55 + rhythmIntensity * .45))),
        harmonicActivity: round(clamp(percussion || melodic ? 0 : input.style.harmony.complexity / 10 * .55 + plannedEnergy * .3)),
        dynamicTarget: round(clamp(.28 + plannedEnergy * .68)),
        articulationFamily: percussion ? (plannedEnergy > .7 ? "accent" : "tight") : plannedEnergy > .72 ? "accent" : "legato",
        entry: { bar: section.startBar, mode: index === 0 ? "downbeat" : "phrase_entry" },
        exit: { bar: section.endBar, mode: index === sourceSections.length - 1 ? "cadence" : "release" },
        transition: index === 0 ? "none" : plannedEnergy > (arrangementBrain.enabled ? arrangementBrain.sections[index - 1]?.targetEnergy : sourceSections[index - 1].energy) ? "build" : "thin",
        fill: percussion && index < sourceSections.length - 1 && plannedEnergy >= .55 && rhythmIntensity >= .45,
      };
      return [track.name, operation];
    }));
    return {
      section: section.name.toLowerCase().replace(/\s+/g, "_"),
      startBar: section.startBar,
      endBar: section.endBar,
       energy: round(clamp(plannedEnergy)),
       density: round(plannedDensity),
      tracks,
      activeTracks: input.tracks
        .filter((track) => tracks[track.name] !== "none")
        .map((track) => track.id ?? track.name),
      trackDirectives: directives,
      operations,
    };
  });
  return {
    id: input.arrangementId,
    version: input.version,
    sections,
    style: input.style,
    songModelVersion: Number(input.parameters.songModelVersion ?? 0),
    parameters: input.parameters,
    provenance: provenance("ARRANGEMENT_DIRECTOR", "1.0.0", input.parameters, input.parentIds),
  };
}

function keyRoot(key: string): number {
  const match = key.match(/([A-G])([#b]?)/i);
  if (!match) return 60;
  const names: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
  return 48 + (names[`${match[1].toUpperCase()}${match[2] || ""}`] ?? 0);
}

function styleComplexity(plan: ArrangementPlan): number {
  return plan.style.harmony.complexity;
}

function canonicalChordPitchClasses(chord: SongModelData["chords"][number]): number[] {
  const legacy = legacyChordDetails(chord.symbol);
  const rootName = chord.root || legacy.root;
  const root = keyRoot(rootName) % 12;
  const quality = (chord.quality ?? legacy.quality).toLowerCase();
  const intervals = quality.includes("dim") ? [0, 3, 6]
    : quality.includes("aug") ? [0, 4, 8]
      : quality.includes("sus2") ? [0, 2, 7]
        : quality.includes("sus") ? [0, 5, 7]
          : /(^|[^a-z])m(?!aj)/.test(quality) || quality.includes("minor") ? [0, 3, 7]
            : [0, 4, 7];
  // Explicit canonical arrays win, but legacy Song Models only supplied a
  // display symbol, so its extension/alteration spelling remains musical data.
  const extensions = chord.extensions ?? legacy.extensions;
  const alterations = chord.alterations ?? legacy.alterations;
  const tokens = [...extensions, ...alterations]
    .join(" ")
    .match(/(?:maj)?(?:6|7|9|11|13)|[#b](?:5|9|11|13)/gi) ?? [];
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    const degree = Number(normalized.match(/\d+/)?.[0]);
    const interval = degree === 6 ? 9 : degree === 7 ? (normalized.includes("maj") ? 11 : 10)
      : degree === 9 ? 14 : degree === 11 ? 17 : degree === 13 ? 21 : degree === 5 ? 7 : 0;
    const altered = normalized.startsWith("#") ? interval + 1 : normalized.startsWith("b") ? interval - 1 : interval;
    if (altered && !intervals.includes(altered % 12)) intervals.push(altered % 12);
  }
  if (quality === "dominant" && extensions.some((extension) => /(?:9|11|13)/.test(extension)) && !intervals.includes(10)) {
    intervals.push(10);
  }
  let pcs = intervals.map((interval) => (root + interval) % 12);
  const inversion = Math.max(0, Math.min(chord.inversion ?? legacy.inversion, pcs.length));
  pcs = [...pcs.slice(inversion), ...pcs.slice(0, inversion)];
  const bass = chord.bass ?? legacy.bass;
  if (bass) {
    const bassPc = keyRoot(bass) % 12;
    const at = pcs.indexOf(bassPc);
    // A non-chord slash bass is a real voicing instruction, not a guessed
    // provider field, so retain it as the lowest pitch class.
    pcs = at >= 0 ? [bassPc, ...pcs.filter((pc) => pc !== bassPc)] : [bassPc, ...pcs];
  }
  return pcs;
}

function legacyChordDetails(symbol: string): {
  root: string; quality: string; extensions: string[]; alterations: string[]; bass?: string; inversion: number;
} {
  const match = symbol.trim().replace("♯", "#").replace("♭", "b")
    .match(/^([A-Ga-g][#b]?)([^/]*)?(?:\/([A-Ga-g][#b]?))?$/);
  const root = match?.[1] ?? symbol;
  const suffix = match?.[2] ?? "";
  const bass = match?.[3];
  const lower = suffix.toLowerCase();
  const quality = /(?:^|:)m(?!aj)|min/.test(lower) ? "minor"
    : /dim|ø|o/.test(lower) ? "diminished"
      : /aug|\+/.test(lower) ? "augmented"
        : /sus/.test(lower) ? "suspended"
          : (/(?:7|9|11|13)/.test(lower) && !lower.includes("maj")) ? "dominant" : "major";
  const extensions = (lower.match(/(?:maj)?(?:6|7|9|11|13)/g) ?? []);
  const alterations = (lower.match(/[#b](?:5|9|11|13)/g) ?? []);
  // A slash whose bass is a chord member implies that inversion for legacy
  // symbols. `canonicalChordPitchClasses` makes the final bass ordering.
  const triad = quality === "minor" ? [0, 3, 7] : quality === "diminished" ? [0, 3, 6] : [0, 4, 7];
  const bassPc = bass ? keyRoot(bass) % 12 : -1;
  const inversion = bassPc < 0 ? 0 : Math.max(0, triad.map((interval) => (keyRoot(root) + interval) % 12).indexOf(bassPc));
  return { root, quality, extensions, alterations, bass, inversion };
}

function readBassEvidence(songModel: SongModelData): Array<{ start: number; end: number; pitch: number; confidence?: number }> {
  return (songModel.bass ?? []).filter((note) => note.confidence >= .6);
}

export class HarmonyEngine {
  generate(songModel: SongModelData, plan: ArrangementPlan): Array<{ start: number; end: number; root: number; tones: number[]; symbol: string; function?: string; decision?: Record<string, unknown> }> {
    if (songModel.chords.length) {
      return songModel.chords.map((chord) => {
        const root = keyRoot(chord.root || chord.symbol);
        const pcs = canonicalChordPitchClasses(chord);
        // Chord evidence is authoritative when it exists.  Do not invent an
        // extension merely because a renderer can play one.
        return {
          start: chord.timing?.startSeconds ?? chord.start,
          end: chord.timing?.endSeconds ?? chord.end,
          root,
          tones: pcs.map((pc) => root - (root % 12) + pc),
          symbol: chord.symbol,
          function: chord.function ?? chord.roman,
          decision: {
            source: "song_model_chord_evidence",
            root: chord.root, quality: chord.quality, extensions: chord.extensions,
            alterations: chord.alterations, inversion: chord.inversion, bass: chord.bass,
            melodyConflictEvidence: chord.melodyConflictEvidence,
            candidateProvenance: chord.candidateProvenance,
            bassSupportEvidence: chord.bassSupportEvidence,
          },
        };
      });
    }
    const root = keyRoot(songModel.keyMap[0]?.key || "C");
    const tonicPc = root % 12;
    const minor = /minor|\bmin\b|\bm\b/i.test(songModel.keyMap[0]?.key ?? "");
    const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const barSeconds = secondsPerBar(
      songModel.tempoMap[0]?.bpm || 92,
      songModel.meterMap[0]?.meter,
    );
    const melodyAt = (start: number, end: number) => songModel.melody
      .filter((note) => note.confidence >= .6 && note.start < end && note.end > start)
      .map((note) => note.pitch % 12);
    const complexity = Math.max(1, Math.min(10, Number(plan.parameters?.harmonyComplexity ?? styleComplexity(plan))));
    const harmonicBars = complexity >= 8 ? 1 : complexity >= 5 ? 2 : 4;
    const bassEvidence = readBassEvidence(songModel);
    let priorTones: number[] = [];
    return plan.sections.flatMap((section, sectionIndex) => {
      const sectionStart = (section.startBar - 1) * barSeconds;
      const sectionEnd = section.endBar * barSeconds;
      const bars = Math.max(1, section.endBar - section.startBar + 1);
      const changes = Math.ceil(bars / harmonicBars);
      return Array.from({ length: changes }, (_, change) => {
        const bar = change * harmonicBars;
        const start = sectionStart + bar * barSeconds;
        const end = Math.min(sectionEnd, start + harmonicBars * barSeconds);
        // Candidate functions are scored against reliable melody evidence and
        // phrase position. This is deterministic, not claimed analysis output.
        const finalChange = change === changes - 1;
        const penultimate = change === changes - 2;
        const candidates = finalChange
          ? [0, 4] // tonic or dominant at a phrase boundary
          : [0, 1, 2, 3, 4, 5, 6]; // complete diatonic degree palette
        const rankedCandidates = candidates
          .map((degree) => {
            // Stack scale thirds, rather than applying one fixed third, so
            // each degree gets its actual major/minor/diminished quality.
            const pcs = [0, 2, 4].map((step) => (tonicPc + scale[(degree + step) % 7]) % 12);
            if (complexity >= 7 && (degree === 0 || degree === 4)) {
              pcs.push((tonicPc + scale[(degree + 6) % 7]) % 12);
            }
            const melody = melodyAt(start, end);
            const melodyFit = melody.length
              ? melody.filter((pitch) => pcs.includes(pitch)).length / melody.length
              : 0.5;
            const bass = bassEvidence.filter((note) => note.start < end && note.end > start);
            const bassFit = bass.length
              ? bass.filter((note) => note.pitch % 12 === (tonicPc + scale[degree]) % 12).length / bass.length
              : 0;
            const voicing = pcs.map((pc) => root - tonicPc + pc);
            const voiceLeading = priorTones.length
              ? -voicing.reduce((sum, tone, voice) => sum + Math.min(...priorTones.map((previous) => Math.abs(tone - previous))), 0) / (voicing.length * 24)
              : 0;
            const functional = (finalChange && degree === 0 ? .35 : 0) +
              (penultimate && degree === 4 ? .25 : 0) +
              (degree === (sectionIndex + bar) % 6 ? .04 : 0);
            return { degree, pcs, score: melodyFit + bassFit * .45 + functional + voiceLeading, melodyFit, bassFit, voiceLeading };
          })
          .sort((a, b) => b.score - a.score || a.degree - b.degree);
        const selected = rankedCandidates[0];
        const absoluteRoot = root - tonicPc + selected.pcs[0];
        const names = minor
          ? ["i", "ii°", "III", "iv", "v", "VI", "VII"]
          : ["I", "ii", "iii", "IV", "V", "vi", "vii°"];
        const tones = selected.pcs.map((pc) => root - tonicPc + pc);
        priorTones = tones;
        return {
          start,
          end,
          root: absoluteRoot,
          tones,
          symbol: names[selected.degree] ?? "I",
          function: names[selected.degree] ?? "I",
          decision: {
            source: "deterministic_candidate_scoring",
            score: round(selected.score),
            melodyFit: round(selected.melodyFit),
            bassFit: round(selected.bassFit),
            voiceLeading: round(selected.voiceLeading),
            harmonicBars,
            complexity,
            candidateRationale: rankedCandidates.map((candidate) => ({
              symbol: names[candidate.degree] ?? "I",
              function: names[candidate.degree] ?? "I",
              score: round(candidate.score),
              melodyFit: round(candidate.melodyFit),
              bassFit: round(candidate.bassFit),
              voiceLeading: round(candidate.voiceLeading),
              selected: candidate.degree === selected.degree,
            })),
          },
        };
      });
    });
  }
}

/**
 * Internal-only arrangement occupancy.  It is deliberately built only from
 * the v2 separation observation; melody, lyrics, and section templates are
 * not evidence of a vocal rest (or of a breath).
 */
type ArrangementSpaceMap = {
  voiced: Array<{ start: number; end: number; section: string }>;
  silent: Array<{ start: number; end: number; section: string }>;
};

type CanonicalVocalWindow = {
  start: number;
  end: number;
  coordinates?: {
    start: { seconds: number; tick: number };
    end: { seconds: number; tick: number };
  };
};

function hasCanonicalWindow(
  window: CanonicalVocalWindow,
): window is CanonicalVocalWindow & { coordinates: NonNullable<CanonicalVocalWindow["coordinates"]> } {
  return Number.isFinite(window.start) && Number.isFinite(window.end) &&
    window.end > window.start &&
    Number.isFinite(window.coordinates?.start.seconds) &&
    Number.isFinite(window.coordinates?.end.seconds) &&
    Number.isFinite(window.coordinates?.start.tick) &&
    Number.isFinite(window.coordinates?.end.tick);
}

function arrangementSectionSeconds(
  songModel: SongModelData,
  section: Pick<ArrangementPlanSection, "section" | "startBar" | "endBar">,
  fallbackBarSeconds: number,
): { start: number; end: number } {
  const source = songModel.sections.find((candidate) =>
    candidate.startBar === section.startBar && candidate.endBar === section.endBar)
    ?? songModel.sections.find((candidate) =>
      candidate.name.toLowerCase().replace(/\s+/g, "_") === section.section);
  if (source?.coordinates &&
    Number.isFinite(source.coordinates.start.seconds) &&
    Number.isFinite(source.coordinates.end.seconds) &&
    source.coordinates.end.seconds > source.coordinates.start.seconds) {
    return {
      start: source.coordinates.start.seconds,
      end: source.coordinates.end.seconds,
    };
  }
  const bars = songModel.bars
    .filter((bar) => bar.bar >= section.startBar && bar.bar <= section.endBar)
    .sort((left, right) => left.bar - right.bar);
  if (bars.length) {
    const start = bars[0].coordinates?.start.seconds ?? bars[0].start;
    const end = bars.at(-1)!.coordinates?.end.seconds ?? bars.at(-1)!.end;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) return { start, end };
  }
  return {
    start: (section.startBar - 1) * fallbackBarSeconds,
    end: section.endBar * fallbackBarSeconds,
  };
}

function createArrangementSpaceMap(
  songModel: SongModelData,
  plan: ArrangementPlan,
  fallbackBarSeconds: number,
): ArrangementSpaceMap | undefined {
  const evidence = songModel.contractVersion === "2.0" ? songModel.vocalEvidence : undefined;
  // A detected status is not enough: use only windows represented on the
  // canonical timeline, and require actual observed voiced occupancy.
  if (evidence?.status !== "detected" ||
    !evidence.observedVoicedWindows.some(hasCanonicalWindow) ||
    ![...evidence.observedVoicedWindows, ...evidence.observedSilentWindows].every(hasCanonicalWindow)) {
    return undefined;
  }
  const clip = (
    windows: typeof evidence.observedVoicedWindows,
  ) => plan.sections.flatMap((section) => {
    const bounds = arrangementSectionSeconds(songModel, section, fallbackBarSeconds);
    return windows.flatMap((window) => {
      // Coordinates are the canonical source of timing for this v2-only
      // behavior; the duplicated second fields are retained for compatibility.
      const start = Math.max(bounds.start, window.coordinates!.start.seconds);
      const end = Math.min(bounds.end, window.coordinates!.end.seconds);
      return end > start ? [{ start: round(start), end: round(end), section: section.section }] : [];
    });
  }).sort((left, right) => left.start - right.start || left.end - right.end ||
    left.section.localeCompare(right.section));
  return {
    // These arrays remain independently observed states: silence is never
    // synthesized as the complement of voice.
    voiced: clip(evidence.observedVoicedWindows),
    silent: clip(evidence.observedSilentWindows),
  };
}

function intersectsObservedVoice(
  start: number,
  end: number,
  spaceMap: ArrangementSpaceMap | undefined,
): boolean {
  return Boolean(spaceMap?.voiced.some((window) => start < window.end && end > window.start));
}

export class CompositionEngine {
  compose(input: {
    songModel: SongModelData;
    plan: ArrangementPlan;
    tracks: Array<{ id: string; name: string; role: string; instrument?: string }>;
    harmony: ReturnType<HarmonyEngine["generate"]>;
    spaceMap?: ArrangementSpaceMap;
  }): Array<TrackModel> {
    const bpm = Math.max(40, input.songModel.tempoMap[0]?.bpm || 92);
    const beat = 60 / bpm;
    const barSeconds = secondsPerBar(
      bpm,
      input.songModel.meterMap[0]?.meter,
    );
    return input.tracks.map((track) => {
      const definition = getInstrumentDefinition(track.instrument || track.name, track.role);
      const notes: MusicalNote[] = [];
      const appliedDirectives: NonNullable<TrackModel["appliedDirectives"]> = [];
      const identity = `${track.name} ${track.role}`.toLowerCase();
      if (identity.includes("vocal") && input.songModel.melody.length) {
        // Melody evidence is never extrapolated. It is merely split at
        // explicitly active section boundaries so a vocal arrangement can
        // enter/leave without leaking notes through inactive sections.
        input.plan.sections.forEach((section, sectionIndex) => {
          const sectionStart = (section.startBar - 1) * barSeconds;
          const sectionEnd = section.endBar * barSeconds;
          const action = section.tracks[track.id] ?? section.tracks[track.name] ?? "main_harmony";
          const active = section.activeTracks
            ? section.activeTracks.includes(track.id) || section.activeTracks.includes(track.name)
            : action !== "none";
          if (!active || action === "none") return;
          const directive = section.trackDirectives?.[track.id] ?? section.trackDirectives?.[track.name];
          if (directive) {
            appliedDirectives.push({
              section: section.section,
              startBar: section.startBar,
              endBar: section.endBar,
              start: sectionStart,
              end: sectionEnd,
              directive,
            });
          }
          input.songModel.melody.forEach((note, noteIndex) => {
            const start = Math.max(sectionStart, note.start);
            const end = Math.min(sectionEnd, note.end);
            if (end <= start) return;
            notes.push({
              id: `${track.id}-melody-${noteIndex}-${sectionIndex}`,
              start: round(start),
              duration: round(end - start),
              pitch: Math.max(definition.playableRange.min, Math.min(definition.playableRange.max, midi(note.pitch))),
              velocity: midi(note.velocity * 127),
              voice: "melody",
            });
          });
        });
      } else if (!identity.includes("vocal")) {
        input.plan.sections.forEach((section, sectionIndex) => {
          const sectionStart = (section.startBar - 1) * barSeconds;
          const sectionEnd = section.endBar * barSeconds;
          const action = section.tracks[track.id] ?? section.tracks[track.name] ?? "main_harmony";
          const active = section.activeTracks
            ? section.activeTracks.includes(track.id) || section.activeTracks.includes(track.name)
            : action !== "none";
          if (!active || action === "none") return;
          const directive = section.trackDirectives?.[track.id] ??
            section.trackDirectives?.[track.name];
          if (directive) {
            appliedDirectives.push({
              section: section.section,
              startBar: section.startBar,
              endBar: section.endBar,
              start: sectionStart,
              end: sectionEnd,
              directive,
            });
          }
          const rhythmic = directive?.rhythmicActivity ?? section.density;
          const step = identity.includes("drum") || identity.includes("rhythm")
            ? beat * (rhythmic > .7 ? .5 : 1)
            : beat * (directive?.harmonicActivity && directive.harmonicActivity > .65 ? 1 : 2);
          for (let time = sectionStart; time < sectionEnd; time += step) {
            const beatIndex = Math.round((time - sectionStart) / beat);
            const chord = input.harmony.find((candidate) =>
              candidate.start <= time + .001 && candidate.end > time + .001)
              ?? input.harmony.find((candidate) => candidate.start < sectionEnd && candidate.end > sectionStart);
            const chordTone = chord?.tones[(beatIndex + sectionIndex) % (chord?.tones.length || 1)] ?? 60;
            let pitch = identity.includes("bass")
              ? chordTone - 24
              : identity.includes("drum") || identity.includes("rhythm")
                ? [36, 42, 38, 42][beatIndex % 4]
                : chordTone + (directive?.register === "high" || identity.includes("string") || identity.includes("brass") ? 12 : 0);
            const targetRegister = directive?.register
              ? definition.registers.find((register) => register.name === directive.register)
              : undefined;
            const preferred = targetRegister ?? definition.comfortableRange;
            while (pitch < preferred.min) pitch += 12;
            while (pitch > preferred.max) pitch -= 12;
            pitch = Math.max(preferred.min, Math.min(preferred.max, pitch));
            pitch = Math.max(definition.playableRange.min, Math.min(definition.playableRange.max, pitch));
            const isEntry = Math.abs(time - sectionStart) < .001;
            const isExit = time + step >= sectionEnd;
            const duration = round(Math.min(
              step * (identity.includes("pad") ? 1.8 : isExit ? .65 : .9),
              sectionEnd - time,
            ));
            // Do not replace a measured vocal rest with a guessed one. The
            // observed silent map is intentionally permissive; only measured
            // voiced occupancy removes a phrase/fill event.
            if (!intersectsObservedVoice(time, time + duration, input.spaceMap)) {
              notes.push({
                id: `${track.id}-${sectionIndex}-${beatIndex}`,
                start: round(time),
                duration,
                pitch: midi(pitch),
                velocity: midi(42 + (directive?.dynamicTarget ?? section.energy) * 66 +
                  (isEntry ? 6 : 0) + (directive?.transition === "build" ? beatIndex * .5 : 0) +
                  (beatIndex % 4 === 0 ? 8 : 0)),
                voice: identity.includes("bass") ? "bass" : identity.includes("drum") ? "percussion" : "harmony",
              });
            }
            if (directive?.fill && (identity.includes("drum") || identity.includes("rhythm")) && isExit &&
              !intersectsObservedVoice(Math.max(sectionStart, sectionEnd - beat * .5), sectionEnd - beat * .28, input.spaceMap)) {
              notes.push({
                id: `${track.id}-${sectionIndex}-${beatIndex}-fill`,
                start: round(Math.max(sectionStart, sectionEnd - beat * .5)),
                duration: round(Math.max(definition.constraints.minNoteDuration, beat * .22)),
                pitch: 45,
                velocity: midi(62 + section.energy * 55),
                voice: "percussion",
              });
            }
          }
        });
      }
      return {
        id: track.id,
        instrument: definition.id,
        instrumentDefinition: definition,
        role: track.role,
        notes,
        cc: [],
        articulations: [],
        automation: [],
        directive: appliedDirectives.length === 1 ? appliedDirectives[0].directive : undefined,
        appliedDirectives,
        mapping: {
          midiChannel: definition.family === "drums" ? 9 : undefined,
          program: definition.id === "bass" ? 33 : definition.family === "strings" ? 48 : 0,
          articulationMap: Object.fromEntries(definition.articulations.map((articulation, index) => [articulation, 24 + index])),
          controlMap: definition.directiveMappings?.controls,
        },
        source: "COMPOSITION_ENGINE",
        version: 1,
        provenance: provenance("COMPOSITION_ENGINE", "1.0.0", { bpm }),
      };
    });
  }
}

export class ModulationEngine {
  transpose(
    trackModels: TrackModel[],
    section: Pick<ArrangementPlanSection, "section" | "startBar" | "endBar">,
    semitones: number,
    bpm: number,
    meter = "4/4",
  ): TrackModel[] {
    const barSeconds = secondsPerBar(bpm, meter);
    const start = (section.startBar - 1) * barSeconds;
    const end = section.endBar * barSeconds;
    return trackModels.map((track) => ({
      ...track,
      notes: track.notes.map((note) => {
        let pitch = midi(note.pitch + (note.start >= start && note.start < end ? semitones : 0));
        const range = track.instrumentDefinition.playableRange;
        while (pitch < range.min) pitch += 12;
        while (pitch > range.max) pitch -= 12;
        return { ...note, pitch: Math.max(range.min, Math.min(range.max, pitch)) };
      }),
      source: "MODULATION_ENGINE",
      version: track.version + 1,
      provenance: provenance("MODULATION_ENGINE", "1.0.0", {
        semitones,
        sectionName: section.section,
        parentModel: track.provenance.model,
      }, [track.id]),
    }));
  }
}

export function applyPlanModulations(
  trackModels: TrackModel[],
  plan: ArrangementPlan,
  bpm: number,
  meter = "4/4",
): TrackModel[] {
  return plan.sections.reduce((tracks, section) => {
    const operation = section.operations.find((item) => item.startsWith("modulate:"));
    if (!operation) return tracks;
    const semitones = Number(operation.slice("modulate:".length));
    return Number.isFinite(semitones) && semitones !== 0
      ? new ModulationEngine().transpose(tracks, section, semitones, bpm, meter)
      : tracks;
  }, trackModels);
}

export class VoiceLeadingEngine {
  apply(trackModels: TrackModel[]): TrackModel[] {
    return trackModels.map((track) => {
      let previous = Math.round((track.instrumentDefinition.comfortableRange.min + track.instrumentDefinition.comfortableRange.max) / 2);
      const notes = track.notes.map((note) => {
        const range = track.instrumentDefinition.playableRange;
        let pitch = midi(note.pitch);
        while (pitch < range.min) pitch += 12;
        while (pitch > range.max) pitch -= 12;
        const maxLeap = track.instrumentDefinition.constraints.maxLeap;
        while (Math.abs(pitch - previous) > maxLeap) pitch += pitch < previous ? 12 : -12;
        pitch = Math.max(range.min, Math.min(range.max, pitch));
        previous = pitch;
        return { ...note, pitch };
      });
      return {
        ...track,
        notes,
        source: "VOICE_LEADING_ENGINE",
        version: track.version + 1,
        provenance: provenance("VOICE_LEADING_ENGINE", "1.0.0", { maxLeap: track.instrumentDefinition.constraints.maxLeap }, [track.provenance.model]),
      };
    });
  }
}

export class PerformanceEngine {
  perform(
    track: TrackModel,
    style: StyleSpec,
    seed = 0,
    spaceMap?: ArrangementSpaceMap,
  ): TrackModel {
    const profile: PerformanceProfile = /vocal|voice|melody/i.test(track.role)
      // Section-gated source melody must not be humanized across a hard
      // arrangement boundary; its evidence timing is preserved exactly.
      ? { timing: 0, velocityVariation: 6, legatoOverlap: 0.02, accentEvery: 4, ccRate: 2 }
      : track.instrumentDefinition.family === "drums"
      ? { timing: 0.012, velocityVariation: 9, legatoOverlap: 0, accentEvery: 4, ccRate: 2 }
      : track.instrumentDefinition.family === "strings"
        ? { timing: 0.018, velocityVariation: 6, legatoOverlap: 0.04, accentEvery: 4, ccRate: 4 }
        : { timing: 0.009, velocityVariation: 7, legatoOverlap: 0.02, accentEvery: 4, ccRate: 2 };
    const randomSeed = hashSeed(`${track.id}:${seed}:${style.subgenre}`);
    const variation = (index: number) => Math.sin((randomSeed % 997 + index * 17) * 0.71) * profile.velocityVariation;
    const notes: MusicalNote[] = [];
    const articulations: ArticulationEvent[] = [];
    const cc: ControlEvent[] = [];
    const automation: AutomationPoint[] = [];
    track.notes.forEach((note, index) => {
      const appliedDirective = track.appliedDirectives?.find(
        (item) => item.start <= note.start && item.end > note.start,
      )?.directive ?? track.directive;
      const offset = Math.sin((randomSeed % 31 + index * 13) * 0.37) * profile.timing;
      const directiveVelocity = appliedDirective?.dynamicTarget === undefined
        ? 0
        : (appliedDirective.dynamicTarget - .5) * 18;
      const velocity = midi(note.velocity + directiveVelocity + variation(index) + (index % profile.accentEvery === 0 ? style.dynamics.accentStrength * 10 : 0));
      const preferredArticulation = track.instrumentDefinition.family === "drums"
        ? (note.pitch === 38 && index % 4 !== 0 ? "ghost" : note.pitch === 36 ? "kick" : "closed_hat")
        : track.instrumentDefinition.family === "strings"
          ? (note.duration < 0.25 ? "spiccato" : "legato")
          : note.duration < 0.2 ? "staccato" : "sustain";
      const directedArticulation = appliedDirective?.articulationFamily &&
        track.instrumentDefinition.directiveMappings?.articulationFamilies?.[appliedDirective.articulationFamily]
          ?.find((candidate) => track.instrumentDefinition.articulations.includes(candidate));
      const articulation = track.instrumentDefinition.articulations.includes(directedArticulation ?? preferredArticulation)
        ? directedArticulation ?? preferredArticulation
        : track.instrumentDefinition.articulations[0] ?? "normal";
      const performed = {
        ...note,
        start: Math.max(0, round(note.start + offset)),
        duration: round(note.duration + (articulation === "legato" ? profile.legatoOverlap : 0)),
        velocity,
      };
      // Timing variation/legato must not reintroduce an intersection that
      // composition deliberately removed. Vocal events are never filtered.
      if (!/vocal|voice|melody/i.test(track.role) &&
        intersectsObservedVoice(performed.start, performed.start + performed.duration, spaceMap)) {
        return;
      }
      notes.push(performed);
      articulations.push({
        time: Math.max(0, round(note.start + offset)),
        name: articulation,
        keyswitch: track.instrumentDefinition.family === "drums"
          ? undefined
          : 24 + Math.max(0, track.instrumentDefinition.articulations.indexOf(articulation)),
        intensity: velocity / 127,
      });
      if (track.instrumentDefinition.controls.pitchBend && index % 8 === 0) {
        automation.push({ parameter: "pitch_bend", time: Math.max(0, round(note.start + offset)), value: round(Math.sin(index * 0.7) * 0.08) });
      }
      if (track.instrumentDefinition.controls.aftertouch && index % 4 === 0) {
        automation.push({ parameter: "aftertouch", time: Math.max(0, round(note.start + offset)), value: round(velocity / 127) });
      }
    });
    const lastTime = notes.at(-1)?.start ?? 0;
    for (let time = 0; time <= lastTime + 0.01; time += 1 / profile.ccRate) {
      const phase = lastTime ? time / lastTime : 0;
      if (track.instrumentDefinition.controls.dynamics.includes(1)) {
        cc.push({ controller: 1, time: round(time), value: round(0.35 + Math.sin(phase * Math.PI) * 0.35) * 127 });
      }
      if (track.instrumentDefinition.controls.expression.includes(11)) {
        cc.push({ controller: 11, time: round(time), value: round(clamp(0.62 + Math.sin(phase * Math.PI) * 0.3)) * 127 });
      }
    }
    if (track.instrumentDefinition.controls.sustain) cc.push({ controller: 64, time: 0, value: 127 });
    return {
      ...track,
      notes,
      cc,
      articulations,
      automation,
      source: "PERFORMANCE_ENGINE",
      version: track.version + 1,
      provenance: provenance("PERFORMANCE_ENGINE", "1.0.0", { seed, timing: profile.timing, humanized: true }, [track.provenance.model]),
    };
  }
}

export class SoundLibraryRegistry {
  resolve(instrument: InstrumentDefinition): { library: string; vendor: string; patch: string; renderProvider: "LOCAL_EXPRESSIVE_SYNTH"; articulation: string[] } {
    return {
      library: "Local Expressive Preview",
      vendor: "Replit Workspace",
      patch: instrument.id,
      renderProvider: "LOCAL_EXPRESSIVE_SYNTH",
      articulation: instrument.articulations,
    };
  }
}

function waveform(instrument: InstrumentDefinition, frequency: number, time: number, articulation: string): number {
  const phase = 2 * Math.PI * frequency * time;
  if (instrument.family === "drums") return Math.sin(phase * (1 + Math.exp(-time * 24) * 3)) * Math.exp(-time * 18);
  if (instrument.family === "brass") return (Math.sin(phase) * 0.72 + Math.sin(phase * 2) * 0.18) * (articulation === "staccato" ? Math.exp(-time * 12) : 1);
  if (instrument.family === "strings") return (Math.sin(phase) * 0.7 + Math.sin(phase * 2) * 0.2 + Math.sin(phase * 3) * 0.08) * (0.85 + 0.15 * Math.sin(time * 5));
  if (instrument.family === "guitar") return (Math.sin(phase) * 0.68 + Math.sin(phase * 2) * 0.16) * Math.exp(-time * 3.5);
  return Math.sin(phase) * 0.72 + Math.sin(phase * 2) * 0.12 + Math.sin(phase * 0.5) * 0.08;
}

export class LocalExpressiveRenderer {
  render(track: TrackModel, sampleRate: number, durationSeconds: number): Float32Array {
    const output = new Float32Array(Math.ceil(sampleRate * durationSeconds) * 2);
    for (const note of track.notes) {
      const startFrame = Math.max(0, Math.floor(note.start * sampleRate));
      const endFrame = Math.min(output.length / 2, Math.ceil((note.start + note.duration) * sampleRate));
      const frequency = 440 * 2 ** ((note.pitch - 69) / 12);
      const articulation = track.articulations.find((event) => Math.abs(event.time - note.start) < 0.05)?.name || "sustain";
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        const age = (frame - startFrame) / sampleRate;
        const remaining = (endFrame - frame) / sampleRate;
        const attack = Math.min(1, age * 80);
        const release = Math.min(1, remaining * 30);
        const sample = waveform(track.instrumentDefinition, frequency, age, articulation) * attack * release * (note.velocity / 127) * 0.22;
        output[frame * 2] += sample;
        output[frame * 2 + 1] += sample;
      }
    }
    return output;
  }
}

export class SfzRenderer {
  readonly providerId = "SFIZZ_VSCO2_CE";

  isConfigured(): boolean {
    return Boolean(process.env.SFIZZ_RENDER_API_URL);
  }

  assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error("sfizz/VSCO renderer is not configured");
    }
  }

  async render(track: TrackModel, sampleRate: number, durationSeconds: number): Promise<Float32Array> {
    return (await this.renderAttested(track, sampleRate, durationSeconds)).samples;
  }

  async renderAttested(
    track: TrackModel,
    sampleRate: number,
    durationSeconds: number,
  ): Promise<NativeRenderResult> {
    this.assertConfigured();
    return renderRemoteInstrument({
      endpoint: process.env.SFIZZ_RENDER_API_URL!,
      token: process.env.SFIZZ_RENDER_API_TOKEN,
      provider: this.providerId,
      track,
      sampleRate,
      durationSeconds,
      // The worker resolves the selected licensed library from its private
      // asset manifest. Never send a private filesystem path over the wire.
      parameters: {},
    });
  }
}

export class PedalboardRenderer {
  readonly providerId = "PEDALBOARD_VST3";

  isConfigured(): boolean {
    return Boolean(process.env.PEDALBOARD_VST3_API_URL);
  }

  assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error("Pedalboard VST3 renderer is not configured");
    }
  }

  async render(track: TrackModel, sampleRate: number, durationSeconds: number): Promise<Float32Array> {
    return (await this.renderAttested(track, sampleRate, durationSeconds)).samples;
  }

  async renderAttested(
    track: TrackModel,
    sampleRate: number,
    durationSeconds: number,
  ): Promise<NativeRenderResult> {
    this.assertConfigured();
    return renderRemoteInstrument({
      endpoint: process.env.PEDALBOARD_VST3_API_URL!,
      token: process.env.PEDALBOARD_VST3_API_TOKEN,
      provider: "VST3",
      track,
      sampleRate,
      durationSeconds,
      parameters: {},
    });
  }
}

async function renderRemoteInstrument(input: {
  endpoint: string;
  token?: string;
  provider: string;
  track: TrackModel;
  sampleRate: number;
  durationSeconds: number;
  parameters: Record<string, string>;
}): Promise<NativeRenderResult> {
  const headers = {
    "Content-Type": "application/json",
    ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
  };
  const healthResponse = await fetch(
    new URL(`/health?provider=${encodeURIComponent(input.provider)}`, input.endpoint),
    {
      headers,
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!healthResponse.ok) {
    throw new Error(`${input.provider} health returned HTTP ${healthResponse.status}`);
  }
  const health = await healthResponse.json() as {
    healthy?: boolean;
    provider?: string;
    modelVersion?: string;
    runtimeReady?: boolean;
    smokeTested?: boolean;
    asset?: {
      id?: string;
      identity?: string;
      sha256?: string;
      licenseOwner?: string;
      licenseReference?: string;
      rendererIdentity?: string;
      rendererSha256?: string;
    };
    smokeEvidence?: {
      assetId?: string;
      sha256?: string;
      trackModelRendered?: boolean;
      audible?: boolean;
      canonicalSensitivity?: boolean;
      nativeHostAttested?: boolean;
      outputSha256?: string;
      rendererSha256?: string;
    };
  };
  const asset = health.asset;
  const smoke = health.smokeEvidence;
  if (
    health.healthy !== true ||
    health.runtimeReady !== true ||
    health.smokeTested !== true ||
    health.provider !== input.provider ||
    !health.modelVersion ||
    !asset?.id ||
    !asset.identity ||
    !asset.sha256 ||
    !asset.licenseOwner ||
    !asset.licenseReference ||
    !asset.rendererIdentity ||
    !asset.rendererSha256 ||
    smoke?.assetId !== asset.id ||
    smoke.sha256 !== asset.sha256 ||
    smoke.rendererSha256 !== asset.rendererSha256 ||
    smoke.trackModelRendered !== true ||
    smoke.audible !== true ||
    smoke.canonicalSensitivity !== true ||
    smoke.nativeHostAttested !== true ||
    !smoke.outputSha256
  ) {
    throw new Error(`${input.provider} renderer is not backed by a healthy attested asset`);
  }
  const trackModelSha256 = createHash("sha256")
    .update(canonicalJson(input.track))
    .digest("hex");
  const response = await fetch(new URL("/render", input.endpoint), {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: input.provider,
      trackModel: input.track,
      sampleRate: input.sampleRate,
      durationSeconds: input.durationSeconds,
      parameters: input.parameters,
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) throw new Error(`${input.provider} renderer returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${input.provider} renderer returned unattested audio`);
  }
  const payload = await response.json() as {
    provider?: string;
    trackModelId?: string;
    trackModelSha256?: string;
    outputSha256?: string;
    audio_base64?: string;
    asset?: {
      id?: string;
      identity?: string;
      sha256?: string;
      licenseOwner?: string;
      licenseReference?: string;
      rendererIdentity?: string;
      rendererSha256?: string;
    };
  };
  if (
    payload.provider !== input.provider ||
    payload.trackModelId !== input.track.id ||
    payload.trackModelSha256 !== trackModelSha256 ||
    typeof payload.outputSha256 !== "string" ||
    typeof payload.audio_base64 !== "string" ||
    payload.asset?.id !== asset.id ||
    payload.asset.identity !== asset.identity ||
    payload.asset.sha256 !== asset.sha256 ||
    payload.asset.licenseOwner !== asset.licenseOwner ||
    payload.asset.licenseReference !== asset.licenseReference ||
    payload.asset.rendererIdentity !== asset.rendererIdentity ||
    payload.asset.rendererSha256 !== asset.rendererSha256
  ) {
    throw new Error(`${input.provider} renderer returned an incomplete attestation`);
  }
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.audio_base64) ||
    payload.audio_base64.length % 4 !== 0
  ) {
    throw new Error(`${input.provider} renderer returned invalid audio encoding`);
  }
  const audio = Buffer.from(payload.audio_base64, "base64");
  const outputSha256 = createHash("sha256").update(audio).digest("hex");
  if (payload.outputSha256 !== outputSha256) {
    throw new Error(`${input.provider} renderer output checksum did not match returned audio`);
  }
  return {
    samples: decodePcm16Wav(audio, input.sampleRate),
    attestation: {
      provider: input.provider,
      modelVersion: health.modelVersion,
      assetId: asset.id,
      assetIdentity: asset.identity,
      assetSha256: asset.sha256,
      licenseOwner: asset.licenseOwner,
      licenseReference: asset.licenseReference,
      rendererIdentity: asset.rendererIdentity,
      rendererSha256: asset.rendererSha256,
      smokeOutputSha256: smoke.outputSha256,
      trackModelSha256,
      rendererOutputSha256: outputSha256,
    },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function decodePcm16Wav(buffer: Buffer, expectedSampleRate: number): Float32Array {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Renderer did not return a WAV file");
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if ((channels !== 1 && channels !== 2) || bitsPerSample !== 16 || sampleRate !== expectedSampleRate) {
    throw new Error("Renderer WAV must be mono/stereo 16-bit PCM at the requested sample rate");
  }
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (type === "data") {
      dataOffset = offset + 8;
      dataSize = Math.min(size, buffer.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error("Renderer WAV is missing a data chunk");
  const inputSamples = Math.floor(dataSize / 2);
  const frames = Math.floor(inputSamples / channels);
  const output = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const left = buffer.readInt16LE(dataOffset + frame * channels * 2) / 32768;
    const right = channels === 2
      ? buffer.readInt16LE(dataOffset + (frame * channels + 1) * 2) / 32768
      : left;
    output[frame * 2] = left;
    output[frame * 2 + 1] = right;
  }
  return output;
}

export class MixGraph {
  mix(rendered: RenderedTrack[], style: StyleSpec, durationFrames: number): Float32Array {
    const mixed = new Float32Array(durationFrames * 2);
    rendered.forEach(({ trackModel, samples }, index) => {
      const bus = trackModel.instrumentDefinition.family;
      const busGain = bus === "drums" ? 0.92 : bus === "brass" ? 0.78 : bus === "strings" ? 0.72 : 0.84;
      const pan = ((index % 5) - 2) * 0.1 * style.production.stereoWidth;
      for (let i = 0; i < mixed.length; i += 2) {
        const sectionGain = 0.88 + 0.12 * Math.sin((i / 2 / durationFrames) * Math.PI);
        mixed[i] += samples[i] * busGain * sectionGain * (1 - Math.max(0, pan));
        mixed[i + 1] += samples[i + 1] * busGain * sectionGain * (1 + Math.min(0, pan));
      }
    });
    let peak = 0;
    for (const value of mixed) peak = Math.max(peak, Math.abs(value));
    const trim = peak > 0.88 ? 0.88 / peak : 1;
    for (let i = 0; i < mixed.length; i += 1) mixed[i] *= trim;
    return mixed;
  }
}

export class QualityEngine {
  assess(
    trackModels: TrackModel[],
    mix: Float32Array,
    plan: ArrangementPlan,
    options: {
      lineageComplete?: boolean;
      renderArtifactIds?: string[];
      evaluatedAt?: string;
      bpm?: number;
      meter?: string;
    } = {},
  ): QualityReport {
    const notes = trackModels.flatMap((track) => track.notes);
    const playable = trackModels.length ? trackModels.reduce((sum, track) => sum + track.notes.filter((note) => note.pitch >= track.instrumentDefinition.playableRange.min && note.pitch <= track.instrumentDefinition.playableRange.max).length, 0) / Math.max(1, notes.length) : 0;
    const beatsPerSecond = Math.max(40, options.bpm ?? 92) / 60;
    const aligned = notes.length ? notes.filter((note) => {
      const sixteenthPosition = note.start * beatsPerSecond * 4;
      return note.start >= 0 &&
        note.duration > 0 &&
        Math.abs(sixteenthPosition - Math.round(sixteenthPosition)) < 0.2;
    }).length / notes.length : 0;
    const structure = plan.sections.length ? 1 : 0;
    let peak = 0;
    let squared = 0;
    let phaseDifference = 0;
    let activeFrames = 0;
    let clippedSamples = 0;
    for (const value of mix) peak = Math.max(peak, Math.abs(value));
    for (let i = 0; i < mix.length; i += 2) {
      squared += mix[i] ** 2 + mix[i + 1] ** 2;
      phaseDifference += Math.abs(mix[i] - mix[i + 1]);
      if (Math.max(Math.abs(mix[i]), Math.abs(mix[i + 1])) > 0.0005) activeFrames += 1;
    }
    for (const value of mix) if (Math.abs(value) >= 0.99) clippedSamples += 1;
    const rms = Math.sqrt(squared / Math.max(1, mix.length));
    const pitchClasses = new Set(notes.map((note) => note.pitch % 12));
    const harmonicCompatibility = clamp(1 - Math.max(0, pitchClasses.size - 9) * 0.08);
    const simultaneousClashes = trackModels.reduce((count, track) => {
      const sorted = [...track.notes].sort((left, right) => left.start - right.start);
      return count + sorted.filter((note, index) => {
        const previous = sorted[index - 1];
        return previous && note.start < previous.start + previous.duration && Math.abs(note.pitch - previous.pitch) === 1;
      }).length;
    }, 0);
    const checks = {
      rhythmicAlignment: aligned,
      harmonicCompatibility,
      melodyPreservation: trackModels.some((track) => track.role === "melody") ? 1 : 0.75,
      chordValidity: pitchClasses.size >= 3 ? 1 : 0.6,
      structure,
      styleAdherence: clamp(1 - Math.abs(plan.style.orchestration.density - Math.min(1, notes.length / Math.max(1, plan.sections.length * 32)))),
      instrumentPlayability: playable,
      clashes: clamp(1 - simultaneousClashes / Math.max(1, notes.length)),
      clipping: peak < 0.99 ? 1 : 0,
      dynamics: clamp(rms / 0.18),
      phase: clamp(1 - phaseDifference / Math.max(1, mix.length / 2)),
      loudness: clamp(rms / 0.12),
    };
    const barSeconds = secondsPerBar(options.bpm ?? 92, options.meter);
    const sectionCoverage = plan.sections.length
      ? plan.sections.filter((section) => {
          const sectionStart = Math.max(0, (section.startBar ?? 1) - 1) *
            barSeconds;
          const sectionEnd = Math.max(
            sectionStart,
            (section.endBar ?? section.startBar ?? 1) * barSeconds,
          );
          return notes.some((note) =>
            note.start < sectionEnd &&
            note.start + note.duration > sectionStart);
        }).length / plan.sections.length
      : 0;
    const requiredChecks: Record<string, number> = {
      silence: mix.length > 0 ? activeFrames / Math.max(1, mix.length / 2) : 0,
      clipping: mix.length > 0 ? 1 - clippedSamples / mix.length : 0,
      notePlayability: playable,
      timing: aligned,
      sectionCoverage,
      lineage: options.lineageComplete === false ? 0 : 1,
    };
    const weights = {
      silence: 0.15,
      clipping: 0.15,
      notePlayability: 0.2,
      timing: 0.15,
      sectionCoverage: 0.15,
      lineage: 0.2,
    };
    const score = round(Object.entries(weights).reduce(
      (sum, [name, weight]) => sum + requiredChecks[name] * weight,
      0,
    ), 3);
    const dimensionLabels: Record<string, string> = {
      silence: "audible signal",
      clipping: "headroom",
      notePlayability: "note playability",
      timing: "timing",
      sectionCoverage: "section coverage",
      lineage: "lineage",
    };
    const dimensions = Object.entries(requiredChecks)
      .sort(([, left], [, right]) => right - left);
    const warnings = [
      ...(playable < 0.98 ? ["Some notes were constrained to the instrument's playable range."] : []),
      ...(requiredChecks.silence < 0.2 ? ["The render is mostly silent."] : []),
      ...(requiredChecks.clipping < 0.99 ? ["The render contains clipped samples."] : []),
      ...(requiredChecks.sectionCoverage < 1 ? ["One or more planned sections contain no rendered notes."] : []),
      ...(requiredChecks.lineage < 1 ? ["Render lineage is incomplete."] : []),
    ];
    return {
      score,
      checks: { ...checks, ...requiredChecks },
      weights,
      strengths: dimensions.slice(0, 2).map(([name]) => dimensionLabels[name] ?? name),
      weaknesses: dimensions.slice(-2).reverse().map(([name]) => dimensionLabels[name] ?? name),
      warnings,
      evaluatedAt: options.evaluatedAt ?? new Date().toISOString(),
      renderArtifactIds: options.renderArtifactIds ?? [],
      lineageComplete: requiredChecks.lineage === 1,
    };
  }
}

export class MasterEngine {
  process(source: Float32Array, profile: string): { premaster: Float32Array; master: Float32Array } {
    const premaster = new Float32Array(source.length);
    let peak = 0;
    for (let i = 0; i < source.length; i += 1) {
      premaster[i] = source[i] * 0.94;
      peak = Math.max(peak, Math.abs(premaster[i]));
    }
    const target = profile === "CLASSICAL" ? 0.72 : profile === "LOUD" ? 0.96 : profile === "DYNAMIC" ? 0.82 : 0.89;
    const master = new Float32Array(source.length);
    const gain = peak ? target / peak : 1;
    for (let i = 0; i < source.length; i += 1) master[i] = Math.max(-0.99, Math.min(0.99, Math.tanh(premaster[i] * 1.35) * gain));
    return { premaster, master };
  }
}

export function buildTrackModels(input: {
  songModel: SongModelData;
  plan: ArrangementPlan;
  tracks: Array<{ id: string; name: string; role: string; instrument?: string }>;
  style: StyleSpec;
  seed?: number;
}): TrackModel[] {
  const harmony = new HarmonyEngine().generate(input.songModel, input.plan);
  const bpm = input.songModel.tempoMap[0]?.bpm ?? 92;
  const spaceMap = createArrangementSpaceMap(
    input.songModel,
    input.plan,
    secondsPerBar(bpm, input.songModel.meterMap[0]?.meter),
  );
  const composed = new CompositionEngine().compose({
    songModel: input.songModel, plan: input.plan, tracks: input.tracks, harmony, spaceMap,
  });
  const modulated = applyPlanModulations(
    composed,
    input.plan,
    bpm,
    input.songModel.meterMap[0]?.meter,
  );
  const voiced = new VoiceLeadingEngine().apply(modulated);
  // Version is part of the identity: regenerating a saved Song Model produces
  // byte-stable expressive events, while a corrected model intentionally does not.
  const deterministicSeed = hashSeed(
    `${input.plan.id}:song-model:${input.plan.songModelVersion}:${input.seed ?? 0}`,
  );
  return voiced.map((track) =>
    new PerformanceEngine().perform(track, input.style, deterministicSeed, spaceMap));
}

function chordPitchClasses(symbol: string): number[] {
  const match = symbol.trim().match(/^([A-Ga-g])([#b]?)(.*)$/);
  if (!match) return [0, 4, 7];
  const roots: Record<string, number> = {
    C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4,
    F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9,
    "A#": 10, Bb: 10, B: 11,
  };
  const root = roots[`${match[1].toUpperCase()}${match[2]}`] ?? 0;
  const quality = match[3].toLowerCase();
  const intervals = quality.includes("dim")
    ? [0, 3, 6]
    : quality.includes("aug")
      ? [0, 4, 8]
      : quality.includes("sus2")
        ? [0, 2, 7]
        : quality.includes("sus")
          ? [0, 5, 7]
          : quality.startsWith("m") && !quality.startsWith("maj")
            ? [0, 3, 7]
            : [0, 4, 7];
  if (quality.includes("7")) intervals.push(quality.includes("maj7") ? 11 : 10);
  return intervals.map((interval) => (root + interval) % 12);
}

function nearestChordPitch(
  pitch: number,
  pitchClasses: number[],
  range: InstrumentDefinition["playableRange"],
): number {
  let best = Math.max(range.min, Math.min(range.max, pitch));
  let distance = Number.POSITIVE_INFINITY;
  for (let candidate = range.min; candidate <= range.max; candidate += 1) {
    if (!pitchClasses.includes(candidate % 12)) continue;
    const nextDistance = Math.abs(candidate - pitch);
    if (nextDistance < distance) {
      best = candidate;
      distance = nextDistance;
    }
  }
  return best;
}

function playableEditorArticulation(
  selected: string,
  definition: InstrumentDefinition,
): string {
  if (definition.articulations.includes(selected)) return selected;
  const aliases: Record<string, string[]> = {
    accent: ["marcato", "hard", "pick", "kick", "spiccato", "staccato", "sustain"],
    ghost: ["ghost", "soft", "mute", "palm_mute", "staccato", "sustain"],
    sustain: ["sustain", "legato", "finger", "normal"],
    staccato: ["staccato", "spiccato", "pick", "palm_mute", "normal"],
  };
  return aliases[selected]?.find((name) => definition.articulations.includes(name))
    ?? definition.articulations[0]
    ?? "normal";
}

export function applyArrangementEditorChanges(input: {
  trackModels: TrackModel[];
  sections: ArrangementSection[];
  tracks: Array<{ id: string; name: string; role: string }>;
  bpm: number;
  meter: string;
}): TrackModel[] {
  const secondsPerBeat = 60 / Math.max(40, input.bpm || 92);
  const [rawNumerator, rawDenominator] = input.meter.split("/").map(Number);
  const numerator = Number.isFinite(rawNumerator) && rawNumerator > 0 ? rawNumerator : 4;
  const denominator = Number.isFinite(rawDenominator) && rawDenominator > 0 ? rawDenominator : 4;
  const quarterBeatsPerBar = numerator * (4 / denominator);
  const normalize = (value: string) => value.trim().toLowerCase();

  return input.trackModels.map((trackModel) => {
    const descriptor = input.tracks.find((track) => track.id === trackModel.id);
    let notes = [...trackModel.notes];
    let cc = [...trackModel.cc];
    let articulations = [...trackModel.articulations];
    let edited = false;

    for (const section of input.sections) {
      if (!section.startBar || !section.endBar) continue;
      const start = (section.startBar - 1) * quarterBeatsPerBar * secondsPerBeat;
      const end = section.endBar * quarterBeatsPerBar * secondsPerBeat;
      const editorEntry = Object.entries(section.midiTracks ?? {}).find(([key]) => {
        const normalized = normalize(key);
        return normalized === normalize(trackModel.id) ||
          normalized === normalize(descriptor?.name ?? "") ||
          normalized === normalize(descriptor?.role ?? trackModel.role);
      })?.[1];

      if (editorEntry) {
        notes = notes.filter((note) => note.start < start || note.start >= end);
        articulations = articulations.filter((event) => event.time < start || event.time >= end);
        for (const note of editorEntry.notes) {
          const noteStart = start + note.start * secondsPerBeat;
          const duration = Math.max(
            trackModel.instrumentDefinition.constraints.minNoteDuration,
            note.duration * secondsPerBeat,
          );
          const pitch = Math.max(
            trackModel.instrumentDefinition.playableRange.min,
            Math.min(trackModel.instrumentDefinition.playableRange.max, note.pitch),
          );
          notes.push({
            id: note.id,
            start: round(noteStart),
            duration: round(Math.min(duration, Math.max(0.001, end - noteStart))),
            pitch,
            velocity: midi(note.velocity),
            voice: trackModel.role,
          });
          articulations.push({
            time: round(noteStart),
            name: playableEditorArticulation(
              note.articulation,
              trackModel.instrumentDefinition,
            ),
            intensity: round(note.velocity / 127),
          });
        }
        cc = cc.filter((event) => event.time < start || event.time >= end);
        editorEntry.cc.forEach((value, index) => {
          const ratio = editorEntry.cc.length <= 1 ? 0 : index / (editorEntry.cc.length - 1);
          cc.push({ controller: 11, time: round(start + (end - start) * ratio), value: midi(value) });
        });
        edited = true;
      } else if (section.chords?.length) {
        notes = notes.map((note) => {
          if (note.start < start || note.start >= end) return note;
          const relativeBeat = (note.start - start) / secondsPerBeat;
          const chord = section.chords!.find((candidate) =>
            relativeBeat >= candidate.startBeat &&
            relativeBeat < candidate.startBeat + candidate.durationBeats);
          if (!chord) return note;
          const classes = chordPitchClasses(chord.symbol);
          const target = descriptor?.role === "bass"
            ? nearestChordPitch(note.pitch - 12, [classes[0]], trackModel.instrumentDefinition.playableRange)
            : nearestChordPitch(note.pitch, classes, trackModel.instrumentDefinition.playableRange);
          return { ...note, pitch: target };
        });
        edited = true;
      }

      if (section.transposeSemitones) {
        notes = notes.map((note) => note.start >= start && note.start < end
          ? {
              ...note,
              pitch: Math.max(
                trackModel.instrumentDefinition.playableRange.min,
                Math.min(
                  trackModel.instrumentDefinition.playableRange.max,
                  note.pitch + section.transposeSemitones!,
                ),
              ),
            }
          : note);
        edited = true;
      }
      for (const point of section.automation ?? []) {
        cc.push({
          controller: 11,
          time: round((point.bar - 1) * quarterBeatsPerBar * secondsPerBeat),
          value: midi(point.value * 127),
        });
        edited = true;
      }
    }

    if (!edited) return trackModel;
    return {
      ...trackModel,
      notes: notes.sort((left, right) => left.start - right.start),
      cc: cc.sort((left, right) => left.time - right.time),
      articulations: articulations.sort((left, right) => left.time - right.time),
      source: "ARRANGEMENT_EDITOR",
      version: trackModel.version + 1,
      provenance: provenance(
        "ARRANGEMENT_EDITOR",
        "1.0.0",
        { baseTrackModelVersion: trackModel.version },
        trackModel.provenance.parentIds,
      ),
    };
  });
}

export function renderMusicPipeline(input: {
  songModel: SongModelData;
  plan: ArrangementPlan;
  tracks: Array<{ id: string; name: string; role: string; instrument?: string; volume?: number }>;
  trackModels?: TrackModel[];
  style: StyleSpec;
  seed?: number;
  masterProfile: string;
  durationSeconds?: number;
  sampleRate?: number;
  quality?: {
    lineageComplete?: boolean;
    renderArtifactIds?: string[];
    evaluatedAt?: string;
    bpm?: number;
    meter?: string;
  };
}): RenderPipelineResult {
  const sampleRate = input.sampleRate ?? 44_100;
  const trackModels = input.trackModels !== undefined
    ? input.trackModels
    : buildTrackModels(input);
  const finalNoteEnd = Math.max(0, ...trackModels.flatMap((track) =>
    track.notes.map((note) => note.start + note.duration)));
  const bpm = input.quality?.bpm ?? input.songModel.tempoMap[0]?.bpm ?? 92;
  const meter = input.quality?.meter ??
    input.songModel.meterMap[0]?.meter ??
    "4/4";
  const barSeconds = secondsPerBar(bpm, meter);
  const plannedEnd = Math.max(
    0,
    ...input.plan.sections.map((section) => section.endBar * barSeconds),
  );
  const durationSeconds = Math.max(
    1,
    input.durationSeconds ??
      (plannedEnd > 0 ? plannedEnd + 1 : finalNoteEnd + 1 || 8),
  );
  const registry = new SoundLibraryRegistry();
  const localRenderer = new LocalExpressiveRenderer();
  const rendered = trackModels.map((trackModel) => {
    const provider = registry.resolve(trackModel.instrumentDefinition).renderProvider;
    const volume = input.tracks.find((track) => track.id === trackModel.id)?.volume ?? 0;
    const gain = 10 ** (volume / 20);
    const samples = localRenderer.render(trackModel, sampleRate, durationSeconds);
    if (gain !== 1) {
      for (let index = 0; index < samples.length; index += 1) samples[index] *= gain;
    }
    return {
      trackModel,
      renderer: provider,
      samples,
    };
  });
  const mix = new MixGraph().mix(rendered, input.style, Math.ceil(sampleRate * durationSeconds));
  const mastered = new MasterEngine().process(mix, input.masterProfile);
  const quality = new QualityEngine().assess(trackModels, mix, input.plan, {
    ...input.quality,
    bpm,
    meter,
  });
  const renderProvenance = rendered.map(({ trackModel, renderer }) => provenance(renderer, "1.0.0", { sampleRate, durationSeconds }, [trackModel.provenance.model]));
  return {
    tracks: rendered,
    mix,
    premaster: mastered.premaster,
    master: mastered.master,
    quality,
    provenance: [input.plan.provenance, ...trackModels.map((track) => track.provenance), ...renderProvenance, provenance("MIX_GRAPH", "1.0.0", { trackCount: rendered.length }), provenance("QUALITY_ENGINE", "1.0.0", { score: quality.score }), provenance("MASTER_ENGINE", "1.0.0", { profile: input.masterProfile })],
    durationSeconds,
  };
}
