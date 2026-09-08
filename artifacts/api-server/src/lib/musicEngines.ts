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
  ArrangementHierarchy,
  CompositionIntelligencePlan,
  CompositionIntelligenceVersion,
  MotifTransformation,
  OrchestrationRole,
  PhraseIntention,
  GenerationPreferenceSnapshot,
  StyleGrammar,
} from "@workspace/db";
import { createHash } from "node:crypto";
import { CANONICAL_PPQ, createCanonicalTimeline } from "./canonicalTimeline";

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
  rendererStatus?: "licensed-native" | "preview-only";
  fallbackReason?: string;
  rendererAttestation?: NativeRendererAttestation;
};

export type NativeRendererAttestation = {
  contractVersion: "1.0";
  provider: string;
  modelVersion: string;
  runtimeIdentity: string;
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
  performedMaterialSha256: string;
  sampleRate: number;
  frameCount: number;
  durationSeconds: number;
};

export type InstrumentPerformanceCapability = {
  family: InstrumentDefinition["family"];
  nativeRenderers: Array<"PEDALBOARD_VST3" | "SFIZZ_VSCO2_CE">;
  articulationProfile: string;
  timingProfile: string;
  dynamicsProfile: string;
};

const PERFORMANCE_CAPABILITIES: Record<InstrumentDefinition["family"], InstrumentPerformanceCapability> = {
  keys: { family: "keys", nativeRenderers: ["PEDALBOARD_VST3", "SFIZZ_VSCO2_CE"], articulationProfile: "key-attack-and-pedal", timingProfile: "phrase-locked-keyboard", dynamicsProfile: "velocity-and-expression" },
  strings: { family: "strings", nativeRenderers: ["PEDALBOARD_VST3", "SFIZZ_VSCO2_CE"], articulationProfile: "bowed-and-pizzicato", timingProfile: "phrase-legato", dynamicsProfile: "continuous-bow-expression" },
  brass: { family: "brass", nativeRenderers: ["PEDALBOARD_VST3", "SFIZZ_VSCO2_CE"], articulationProfile: "breath-and-tongue", timingProfile: "breath-phrase", dynamicsProfile: "breath-expression" },
  drums: { family: "drums", nativeRenderers: ["PEDALBOARD_VST3", "SFIZZ_VSCO2_CE"], articulationProfile: "kit-limb-articulation", timingProfile: "meter-aware-groove", dynamicsProfile: "accent-and-ghost-note" },
  guitar: { family: "guitar", nativeRenderers: ["PEDALBOARD_VST3", "SFIZZ_VSCO2_CE"], articulationProfile: "pick-strum-and-fret", timingProfile: "string-aware-phrase", dynamicsProfile: "pick-velocity" },
  voice: { family: "voice", nativeRenderers: ["PEDALBOARD_VST3", "SFIZZ_VSCO2_CE"], articulationProfile: "source-phrase-preserving", timingProfile: "canonical-source-locked", dynamicsProfile: "phrase-expression" },
  synth: { family: "synth", nativeRenderers: ["PEDALBOARD_VST3", "SFIZZ_VSCO2_CE"], articulationProfile: "patch-articulation", timingProfile: "phrase-locked-synth", dynamicsProfile: "velocity-expression-aftertouch" },
};

export function getInstrumentPerformanceCapability(
  instrument: InstrumentDefinition,
): InstrumentPerformanceCapability {
  return PERFORMANCE_CAPABILITIES[instrument.family];
}

export function performedMaterialSha256(track: TrackModel): string {
  return createHash("sha256").update(canonicalJson({
    id: track.id,
    instrument: track.instrument,
    role: track.role,
    notes: track.notes,
    cc: track.cc,
    articulations: track.articulations,
    automation: track.automation,
    mapping: track.mapping ?? null,
  })).digest("hex");
}

export function canonicalPerformanceTimelineSha256(songModel: SongModelData): string {
  const phrases = songModel.contractVersion === "2.0" &&
    songModel.vocalIntelligence?.phrases.status === "detected"
    ? songModel.vocalIntelligence.phrases.events.map((phrase) => ({
        id: phrase.id,
        start: phrase.start,
        end: phrase.end,
        coordinates: phrase.coordinates ?? null,
      }))
    : [];
  return createHash("sha256").update(canonicalJson({
    ppq: songModel.timebase?.ppq ?? 480,
    tempoMap: songModel.tempoMap,
    meterMap: songModel.meterMap,
    bars: songModel.bars.map((bar) => bar.coordinates ?? {
      bar: bar.bar, start: bar.start, end: bar.end,
    }),
    phrases,
  })).digest("hex");
}

export function canonicalPerformancePhraseIds(songModel: SongModelData): string[] {
  return songModel.contractVersion === "2.0" &&
    songModel.vocalIntelligence?.phrases.status === "detected"
    ? songModel.vocalIntelligence.phrases.events.map((phrase) => phrase.id)
    : [];
}

export function compositionEvidenceSha256(
  songModel: SongModelData,
  songModelVersion: number,
): string {
  return createHash("sha256").update(canonicalJson({
    songModelVersion,
    songModel,
  })).digest("hex");
}

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
  productionReadiness?: {
    ready: boolean;
    status: "production-ready" | "preview-only";
    reasons: string[];
    performedMaterialSha256: string;
    midiAgreementSha256: string;
  };
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

export function canonicalMotifFingerprint(
  notes: Array<Pick<MusicalNote, "start" | "duration" | "pitch">>,
): string {
  if (!notes.length) return createHash("sha256").update("motif:empty").digest("hex");
  const ordered = [...notes].sort((left, right) =>
    left.start - right.start || left.pitch - right.pitch || left.duration - right.duration);
  const originTime = ordered[0].start;
  const originPitch = ordered[0].pitch;
  return createHash("sha256").update(canonicalJson(ordered.map((note) => ({
    onset: round(note.start - originTime),
    duration: round(note.duration),
    interval: note.pitch - originPitch,
  })))).digest("hex");
}
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
  generationPreference?: GenerationPreferenceSnapshot | null,
): StyleSpec {
  const genre = style.split(/\s+/)[0]?.toLowerCase() || "pop";
  const normalizedStyle = style.toLowerCase();
  const cinematic = normalizedStyle.includes("cinematic") || normalizedStyle.includes("orchestra");
  const jazz = genre === "jazz";
  const electronic = /edm|electro|techno|house|synth/.test(normalizedStyle);
  const sparse = /ambient|minimal|ballad/.test(normalizedStyle);
  const grammarVocabulary: StyleGrammar["vocabulary"] = {
    groove: jazz ? "swung" : /house|techno|edm/.test(normalizedStyle)
      ? "four_on_floor" : (controls.rhythmIntensity ?? .6) > .68 ? "syncopated" : "straight",
    voicing: generationPreference?.effects.voicingCharacter ??
      (jazz ? "drop_two" : cinematic ? "wide" : electronic ? "open" : "close"),
    articulation: jazz ? "accented" : electronic ? "pulsed" : sparse ? "legato" : "tight",
    instrumentation: cinematic ? "orchestral" : electronic ? "electronic"
      : jazz ? "acoustic" : "hybrid",
    phraseBehavior: jazz ? "call_response" : sparse ? "sparse_answers"
      : cinematic ? "motivic" : "continuous",
    fills: sparse ? "none" : jazz ? "frequent" : cinematic ? "sectional" : "cadential",
    transitions: cinematic ? "orchestral_swell" : electronic ? "riser"
      : sparse ? "thin_build" : "hard_cut",
    development: cinematic ? "dynamic_arc" : electronic ? "additive"
      : jazz ? "transformative" : "repetition",
  };
  const grammarEvidenceSha256 = createHash("sha256").update(canonicalJson({
    style: normalizedStyle.replace(/\s+/g, " ").trim(),
    controls,
    generationPreferenceEvidenceSha256: generationPreference?.evidenceSha256 ?? null,
    vocabulary: grammarVocabulary,
  })).digest("hex");
  const preferenceDensity = generationPreference?.effects.orchestrationDensity ?? 0;
  return {
    genre,
    subgenre: style.toLowerCase().replace(/\s+/g, "_"),
    era: "modern",
    tempoCharacter: controls.energy > 0.72 ? "driving" : "steady",
    rhythm: { swing: jazz ? 0.18 : 0, syncopation: clamp(controls.density * 0.45 + (controls.rhythmIntensity ?? .6) * .4), subdivision: (controls.rhythmIntensity ?? .6) > .72 || electronic ? "16th" : "8th" },
    harmony: { complexity: controls.harmonyComplexity, tension: clamp((controls.harmonyComplexity - 1) / 9), voicing: grammarVocabulary.voicing },
    instrumentation: { preferredFamilies: cinematic ? ["keys", "strings", "brass", "drums"] : electronic ? ["synth", "drums", "bass", "keys"] : ["keys", "strings", "bass", "drums"], avoid: [] },
    orchestration: { density: clamp(controls.density * .65 + (controls.orchestraSize ?? .5) * .35 + preferenceDensity), registerSpread: clamp((cinematic ? .72 : .48) + (controls.orchestraSize ?? .5) * .35), dynamics: controls.energy > 0.7 ? "arc" : "intimate" },
    production: { stereoWidth: cinematic ? 0.85 : 0.65, room: cinematic ? "scoring_stage" : "studio", mixProfile: "streaming" },
    dynamics: { range: cinematic ? 0.8 : 0.6, accentStrength: clamp(0.35 + controls.energy * 0.5) },
    grammar: { version: "1.0", evidenceSha256: grammarEvidenceSha256, vocabulary: grammarVocabulary },
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

type OrchestrationAssignment = {
  trackId: string;
  role: OrchestrationRole;
  register: "low" | "middle" | "high";
  doublingTrackId: string | null;
};
export type ArrangementBrainSection = {
  function: "intro" | "verse" | "prechorus" | "chorus" | "bridge" | "outro" | "neutral";
  targetEnergy: number;
  targetDensity: number;
  development: "initial" | "development" | "reprise" | "neutral";
  tension: number;
  release: number;
  materialSourceSectionIndex: number | null;
};

export type ArrangementBrain = {
  version: "1.0.0" | "2.0.0";
  compositionVersion: CompositionIntelligenceVersion;
  enabled: boolean;
  sections: ArrangementBrainSection[];
};

export function noOpArrangementHierarchy(
  arrangementId: string,
  reason = "legacy_plan_without_hierarchy",
): ArrangementHierarchy {
  return {
    version: "1.0",
    status: "no_op",
    reason,
    precedence: ["song", "section", "phrase", "bar", "event"],
    song: { id: arrangementId, intent: "preserve_observed_form", climaxSectionId: null },
    sections: [],
    phrases: [],
    bars: [],
    events: [],
  };
}

export function ensureArrangementPlanHierarchy<T extends ArrangementPlan>(plan: T): T {
  const legacy = plan as T & { hierarchy?: ArrangementHierarchy };
  return legacy.hierarchy
    ? plan
    : { ...plan, hierarchy: noOpArrangementHierarchy(plan.id) };
}

const canonicalRange = (value: { coordinates?: { start: { seconds: number; bar: number }; end: { seconds: number; bar: number } } }) =>
  value.coordinates &&
  Number.isFinite(value.coordinates.start.seconds) &&
  Number.isFinite(value.coordinates.end.seconds) &&
  value.coordinates.end.seconds > value.coordinates.start.seconds
    ? value.coordinates
    : undefined;

function meterAtBar(songModel: SongModelData, bar: number): string {
  return songModel.meterMap
    .filter((change) => change.bar <= bar)
    .at(-1)?.meter ?? "4/4";
}

function buildSharedGroovePlan(
  songModel: SongModelData,
  hierarchy: ArrangementHierarchy,
  reasoning: Pick<CompositionIntelligencePlan, "seed" | "evidenceSha256" | "phrases" | "instrumentRoles">,
  style: StyleSpec,
): NonNullable<CompositionIntelligencePlan["groove"]> {
  const timeline = createCanonicalTimeline(
    songModel.tempoMap.map(({ time, bpm }) => ({ time, bpm })),
    songModel.meterMap.map(({ bar, meter }) => ({ bar, meter })),
  );
  const subdivision = style.rhythm.subdivision === "16th" ? "16th" as const : "8th" as const;
  const roles = reasoning.instrumentRoles.flatMap((role) => {
    const responsibility = role.function === "foundation" ? "foundation" as const
      : role.function === "pulse" ? "pulse" as const
      : role.function === "harmony" ? "syncopation" as const
      : null;
    return responsibility ? [{ trackId: role.trackId, responsibility }] : [];
  });
  const motifByRef = new Map<string, string>();
  const motifs = reasoning.phrases.map((phrase) => {
    const source = motifByRef.get(phrase.motifRef) ?? null;
    const id = `groove-motif:${hashSeed(`${reasoning.evidenceSha256}:${reasoning.seed}:${phrase.id}:${phrase.motifRef}`)}`;
    if (!source) motifByRef.set(phrase.motifRef, id);
    return {
      id,
      sourceMotifId: source,
      phraseId: phrase.id,
      variation: phrase.intent === "answer" ? "answer" as const
        : phrase.intent === "develop" || phrase.intent === "build" ? "develop" as const
        : "state" as const,
    };
  });
  const events: NonNullable<CompositionIntelligencePlan["groove"]>["events"] = [];
  const arrangementSpaces = songModel.contractVersion === "2.0" &&
    songModel.vocalIntelligence?.arrangementSpace.status === "detected"
    ? songModel.vocalIntelligence.arrangementSpace.windows.filter((window) => canonicalRange(window))
    : [];
  for (const phrase of reasoning.phrases) {
    const section = hierarchy.sections.find((candidate) => candidate.id === phrase.sectionId);
    const motif = motifs.find((candidate) => candidate.phraseId === phrase.id)!;
    if (!section) continue;
    if (phrase.intent === "answer" && phrase.startBar > 1) {
      const phraseStartTick = timeline.barToTick(phrase.startBar);
      const pickupBeatTicks = CANONICAL_PPQ * 4 /
        (Number(meterAtBar(songModel, phrase.startBar).split("/")[1]) || 4);
      const pickupTick = Math.max(0, Math.round(phraseStartTick - pickupBeatTicks / 2));
      const pickupSection = hierarchy.sections.find((candidate) =>
        candidate.startBar <= phrase.startBar - 1 && candidate.endBar >= phrase.startBar - 1) ?? section;
      for (const role of roles) {
        const musical = timeline.tickToMusicalPosition(pickupTick);
        events.push({
          id: `groove-event:${hashSeed(`${reasoning.seed}:${phrase.id}:${role.trackId}:${pickupTick}:pickup`)}`,
          motifId: motif.id,
          sectionId: pickupSection.id,
          phraseId: phrase.id,
          trackId: role.trackId,
          responsibility: role.responsibility,
          gesture: "pickup",
          sharedAccentId: null,
          coordinate: {
            seconds: round(timeline.tickToSeconds(pickupTick)),
            tick: pickupTick,
            ...musical,
          },
          durationTicks: Math.max(1, Math.round(pickupBeatTicks * .3)),
          velocity: midi(64 + phrase.tension * 28),
        });
      }
    }
    for (let bar = phrase.startBar; bar <= phrase.endBar; bar += 1) {
      const startTick = timeline.barToTick(bar);
      const endTick = timeline.barToTick(bar + 1);
      const meter = meterAtBar(songModel, bar).split("/").map(Number);
      const beatTicks = CANONICAL_PPQ * 4 / (meter[1] || 4);
      const beatCount = meter[0] || 4;
      const barInfo = hierarchy.bars.find((candidate) =>
        candidate.sectionId === section.id && candidate.bar === bar);
      const exactSpace = arrangementSpaces
        .filter((window) => {
          const range = canonicalRange(window)!;
          return range.start.seconds < timeline.tickToSeconds(endTick) &&
            range.end.seconds > timeline.tickToSeconds(startTick) &&
            (!window.sections.length || window.sections.some((name) =>
              name.toLowerCase().replace(/\s+/g, "_") === section.sourceSection));
        })
        .map((window) => {
          const range = canonicalRange(window)!;
          return {
            startTick: Math.max(startTick, timeline.secondsToTick(range.start.seconds)),
            endTick: Math.min(endTick, timeline.secondsToTick(range.end.seconds)),
          };
        })
        .filter((range) => range.endTick > range.startTick)
        .sort((left, right) => right.endTick - left.endTick)[0];
      const finalBar = bar === phrase.endBar;
      const boundaryGesture = finalBar && section.function === "outro" ? "break" as const
        : finalBar && exactSpace ? "fill" as const
        : finalBar && phrase.intent === "build" ? "push" as const
        : finalBar && phrase.intent === "develop" ? "anticipation" as const
        : "state" as const;
      for (const role of roles) {
        const positions = role.responsibility === "pulse"
          ? Array.from({ length: beatCount }, (_, index) => index * beatTicks)
          : role.responsibility === "foundation"
            ? [0, Math.max(Math.round(beatTicks * 1.5), endTick - startTick - beatTicks / 2)]
            : Array.from({ length: Math.max(1, beatCount - 1) }, (_, index) =>
                index * beatTicks + beatTicks / 2);
        const gestureOffsets = new Map<number, typeof boundaryGesture>();
        if (boundaryGesture === "break" && finalBar) positions.splice(1);
        if ((boundaryGesture === "anticipation" || boundaryGesture === "push") && finalBar) {
          const boundaryOffset = endTick - startTick - beatTicks / 2;
          positions.push(boundaryOffset);
          gestureOffsets.set(Math.round(boundaryOffset), boundaryGesture);
        }
        if (boundaryGesture === "fill" && finalBar && role.responsibility === "pulse" && exactSpace) {
          const fillOffsets = [
            Math.max(exactSpace.startTick, exactSpace.endTick - beatTicks / 2) - startTick,
            Math.max(exactSpace.startTick, exactSpace.endTick - beatTicks / 4) - startTick,
          ];
          positions.push(...fillOffsets);
          fillOffsets.forEach((offset) => gestureOffsets.set(Math.round(offset), "fill"));
        }
        const unique = [...new Set(positions.map(Math.round))].sort((a, b) => a - b);
        unique.forEach((offset, eventIndex) => {
          const tick = startTick + offset;
          if (tick < startTick || tick >= endTick) return;
          const strongBeat = offset === 0 || offset === Math.round(beatTicks * 2);
          const sharedAccentId = strongBeat ? `groove-accent:${bar}:${offset}` : null;
          const gesture = gestureOffsets.get(offset) ??
            (boundaryGesture === "break" && finalBar && eventIndex === unique.length - 1
              ? "break" : "state");
          const musical = timeline.tickToMusicalPosition(tick);
          const baseDurationTicks = Math.max(1, Math.round(beatTicks * (
            role.responsibility === "foundation" ? .72 : role.responsibility === "pulse" ? .22 : .38
          )));
          const durationTicks = gesture === "fill" && exactSpace
            ? Math.max(1, Math.min(baseDurationTicks, exactSpace.endTick - tick))
            : baseDurationTicks;
          events.push({
            id: `groove-event:${hashSeed(`${reasoning.seed}:${phrase.id}:${role.trackId}:${tick}:${gesture}`)}`,
            motifId: motif.id,
            sectionId: section.id,
            phraseId: phrase.id,
            trackId: role.trackId,
            responsibility: gesture === "fill" ? "fill" : sharedAccentId ? "accent" : role.responsibility,
            gesture,
            sharedAccentId,
            coordinate: {
              seconds: round(timeline.tickToSeconds(tick)),
              tick,
              ...musical,
            },
            durationTicks,
            velocity: midi(58 + phrase.tension * 34 + (sharedAccentId ? 12 : 0) -
              (phrase.intent === "release" ? 8 : 0)),
          });
        });
      }
    }
  }
  const gesturePriority: Record<typeof events[number]["gesture"], number> = {
    state: 0,
    pickup: 1,
    anticipation: 2,
    push: 3,
    break: 4,
    fill: 5,
  };
  const phrasePriority = (phraseId: string) => {
    const phrase = reasoning.phrases.find((candidate) => candidate.id === phraseId);
    const intentPriority: Record<CompositionIntelligencePlan["phrases"][number]["intent"], number> = {
      state: 0,
      develop: 1,
      answer: 2,
      build: 3,
      release: 4,
      protect_vocal: 5,
    };
    return {
      intent: phrase ? intentPriority[phrase.intent] : 0,
      span: phrase ? phrase.endBar - phrase.startBar : Number.MAX_SAFE_INTEGER,
    };
  };
  const collisionSafeEvents = [...events.reduce((selected, event) => {
    const key = `${event.trackId}:${event.coordinate.tick}`;
    const current = selected.get(key);
    const candidatePhrase = phrasePriority(event.phraseId);
    const currentPhrase = current ? phrasePriority(current.phraseId) : null;
    if (!current || gesturePriority[event.gesture] > gesturePriority[current.gesture] ||
      (gesturePriority[event.gesture] === gesturePriority[current.gesture] &&
        (candidatePhrase.intent > currentPhrase!.intent ||
          (candidatePhrase.intent === currentPhrase!.intent &&
            (candidatePhrase.span < currentPhrase!.span ||
              (candidatePhrase.span === currentPhrase!.span &&
                event.phraseId.localeCompare(current.phraseId) < 0)))))) {
      selected.set(key, event);
    }
    return selected;
  }, new Map<string, typeof events[number]>()).values()];
  return {
    version: "1.0",
    seed: reasoning.seed,
    evidenceSha256: reasoning.evidenceSha256,
    subdivision,
    roles,
    motifs,
    events: collisionSafeEvents.sort((left, right) =>
      left.coordinate.tick - right.coordinate.tick || left.trackId.localeCompare(right.trackId)),
  };
}

function buildArrangementHierarchy(
  arrangementId: string,
  songModel: SongModelData,
  brain: ArrangementBrain,
  sections: ArrangementPlanSection[],
): ArrangementHierarchy {
  if (!brain.enabled) {
    return noOpArrangementHierarchy(arrangementId, "insufficient_structural_evidence");
  }

  const phraseEvidence = songModel.contractVersion === "2.0" &&
    songModel.vocalIntelligence?.phrases.status === "detected"
    ? songModel.vocalIntelligence.phrases.events.filter((event) => canonicalRange(event))
    : [];
  const spaceEvidence = songModel.contractVersion === "2.0" &&
    songModel.vocalIntelligence?.arrangementSpace.status === "detected"
    ? songModel.vocalIntelligence.arrangementSpace.windows.filter((window) => canonicalRange(window))
    : [];
  const phrases: ArrangementHierarchy["phrases"] = [];
  const bars: ArrangementHierarchy["bars"] = [];
  const events: ArrangementHierarchy["events"] = [];
  const hierarchySections = sections.map((section, index) => {
    const sectionId = `section:${section.section}:${index + 1}`;
    const sectionPhrases = phraseEvidence.filter((phrase) => {
      const range = canonicalRange(phrase)!;
      return range.start.bar <= section.endBar && range.end.bar >= section.startBar;
    }).map((phrase) => {
      const range = canonicalRange(phrase)!;
      const id = `phrase:${sectionId}:${phrase.id}`;
      phrases.push({
        id,
        sectionId,
        startBar: Math.max(section.startBar, range.start.bar),
        endBar: Math.min(section.endBar, range.end.bar),
        confidence: round(clamp(phrase.confidence)),
        intent: "protect_vocal_phrase",
      });
      return id;
    });
    const barIds: string[] = [];
    for (let bar = section.startBar; bar <= section.endBar; bar += 1) {
      const id = `bar:${sectionId}:${bar}`;
      barIds.push(id);
      const phraseIds = phrases
        .filter((phrase) => phrase.sectionId === sectionId && phrase.startBar <= bar && phrase.endBar >= bar)
        .map((phrase) => phrase.id);
      const available = spaceEvidence.some((window) => {
        const range = canonicalRange(window)!;
        return (window.bars.includes(bar) || (range.start.bar <= bar && range.end.bar >= bar)) &&
          (!window.sections.length || window.sections.some((name) =>
            name.toLowerCase().replace(/\s+/g, "_") === section.section));
      });
      const vocalSpace = phraseIds.length ? "occupied" : available ? "available" : "unknown";
      bars.push({ id, sectionId, bar, meter: meterAtBar(songModel, bar), phraseIds, vocalSpace });
      for (const trackId of section.activeTracks ?? []) {
        const vocal = /vocal|voice/.test(trackId.toLowerCase());
        events.push({
          id: `event:${sectionId}:${bar}:${trackId}`,
          sectionId,
          barId: id,
          trackId,
          intent: vocal ? "follow_section" : vocalSpace === "occupied" ? "support_vocal" :
            vocalSpace === "available" ? "use_vocal_space" : "follow_section",
          source: vocalSpace === "occupied" ? "vocal_phrase" :
            vocalSpace === "available" ? "vocal_space" : "section",
        });
      }
    }
    return {
      id: sectionId,
      sourceSection: section.section,
      startBar: section.startBar,
      endBar: section.endBar,
      function: brain.sections[index]?.function ?? "neutral",
      development: brain.sections[index]?.development ?? "neutral",
      targetEnergy: section.energy,
      targetDensity: section.density,
      phraseIds: sectionPhrases,
      barIds,
    };
  });
  const climax = hierarchySections.reduce<typeof hierarchySections[number] | null>(
    (best, section) => !best || section.targetEnergy >= best.targetEnergy ? section : best,
    null,
  );
  return {
    version: "1.0",
    status: "applied",
    reason: null,
    precedence: ["song", "section", "phrase", "bar", "event"],
    song: { id: arrangementId, intent: "development_arc", climaxSectionId: climax?.id ?? null },
    sections: hierarchySections,
    phrases,
    bars,
    events,
  };
}

/**
 * A deliberately small, evidence-bound global arranger. It only interprets
 * names already present in the Song Model and its measured relative energy;
 * it never adds, moves, or renames sections.
 */
export function buildArrangementBrain(input: {
  songModel: SongModelData;
  controls: { energy: number; density: number; orchestraSize?: number };
  compositionVersion?: CompositionIntelligenceVersion;
}): ArrangementBrain {
  const sections = input.songModel.sections;
  const neutral = (): ArrangementBrain => ({
    version: input.compositionVersion === "2.0" ? "2.0.0" : "1.0.0",
    compositionVersion: input.compositionVersion ?? "1.0",
    enabled: false,
    sections: sections.map(() => ({
      function: "neutral",
      targetEnergy: 0,
      targetDensity: 0,
      development: "neutral",
      tension: 0,
      release: 0,
      materialSourceSectionIndex: null,
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
  const firstOccurrence = new Map<ArrangementBrainSection["function"], number>();
  const drafts = targetEnergy.map((energy, index) => {
      const fn = functions[index];
      const occurrence = occurrences.get(fn) ?? 0;
      occurrences.set(fn, occurrence + 1);
      if (!firstOccurrence.has(fn)) firstOccurrence.set(fn, index);
      const development: ArrangementBrainSection["development"] = fn === "chorus" && occurrence > 0
        ? (occurrence === 1 ? "development" : "reprise")
        : fn === "neutral" ? "neutral" : "initial";
      const developedEnergy = development === "development" || development === "reprise"
        ? clamp(energy + .04) : energy;
      const previousEnergy = index ? targetEnergy[index - 1] : 0;
      return {
        function: fn,
        energy: developedEnergy,
        development,
        tension: clamp(developedEnergy * .72 + Math.max(0, developedEnergy - previousEnergy) * .55),
        release: clamp(Math.max(0, previousEnergy - developedEnergy) + (fn === "outro" ? .45 : .08)),
        materialSourceSectionIndex: occurrence > 0 ? firstOccurrence.get(fn) ?? null : null,
      };
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
    version: input.compositionVersion === "2.0" ? "2.0.0" : "1.0.0",
    compositionVersion: input.compositionVersion ?? "1.0",
    enabled: true,
    sections: continuous.map(({ function: fn, energy, development, tension, release, materialSourceSectionIndex }) => ({
      function: fn,
      targetEnergy: round(energy),
      targetDensity: round(clamp(
        controlDensity * .5 + energy * .5 +
        (development === "development" || development === "reprise" ? .04 : 0),
      )),
      development,
      tension: round(tension),
      release: round(release),
      materialSourceSectionIndex,
    })),
  };
}

function createArrangementPlanWithOrchestration(input: {
  arrangementId: string;
  version: number;
  songModel: SongModelData;
  style: StyleSpec;
  tracks: Array<{ id?: string; name: string; role: string }>;
  parameters: Record<string, number | string | boolean>;
  parentIds?: string[];
  arrangementBrain?: ArrangementBrain;
  compositionVersion?: CompositionIntelligenceVersion;
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
    compositionVersion: input.compositionVersion,
  });
  let priorLayerCount: number | undefined;
  const sectionAssignments: OrchestrationAssignment[][] = [];
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
    const plannedAssignments = planSectionOrchestration({
      tracks: input.tracks,
      sectionFunction: brainSection?.function ?? "neutral",
      energy: plannedEnergy,
      density: plannedDensity,
      orchestraSize,
      sectionIndex: index,
    });
    const unconstrainedLayers = plannedAssignments.length;
    const smoothedLayerCount = arrangementBrain.enabled && priorLayerCount !== undefined
      ? Math.round(clamp(unconstrainedLayers, Math.max(1, priorLayerCount - 1), Math.min(input.tracks.length, priorLayerCount + 1)))
      : unconstrainedLayers;
    const layerCount = brainSection && brainSection.release > .35 && priorLayerCount !== undefined
      ? Math.max(1, Math.min(smoothedLayerCount, priorLayerCount - 1))
      : smoothedLayerCount;
    priorLayerCount = layerCount;
    const assignments = plannedAssignments.slice(0, layerCount);
    sectionAssignments.push(assignments);
    const assignmentByTrack = new Map(assignments.map((assignment) => [assignment.trackId, assignment]));
    const enabledIds = new Set(assignmentByTrack.keys());
    const tracks = Object.fromEntries(input.tracks.map((track) => {
      const identity = `${track.name} ${track.role}`.toLowerCase();
      const trackId = track.id ?? track.name;
      const assignment = assignmentByTrack.get(trackId);
      const operation = enabledIds.has(trackId) ? operationForTrack(track, { energy: plannedEnergy }) : "none";
      const percussion = /drum|rhythm|percussion/.test(identity);
      const bass = identity.includes("bass");
      const melodic = /vocal|voice|melody/.test(identity);
      directives[trackId] = {
        role: track.role,
        musicalFunction: assignment?.role,
        register: assignment?.register ?? (bass ? "low" : melodic ? "high" : "middle"),
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
        ...(assignment?.doublingTrackId ? { doublingTrackId: assignment.doublingTrackId } : {}),
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
  const compositionVersion = input.compositionVersion ?? arrangementBrain.compositionVersion;
  const evidenceSha256 = compositionEvidenceSha256(
    input.songModel,
    Number(input.parameters.songModelVersion ?? 0),
  );
  const roleForTrack = (track: typeof input.tracks[number]): CompositionIntelligencePlan["instrumentRoles"][number]["function"] => {
    const identity = `${track.name} ${track.role}`.toLowerCase();
    if (/bass/.test(identity)) return "foundation";
    if (/drum|rhythm|percussion/.test(identity)) return "pulse";
    if (/vocal|voice|melody|lead/.test(identity)) return "lead";
    if (/string|brass|counter/.test(identity)) return "counterline";
    if (/pad|texture|ambient/.test(identity)) return "texture";
    return "harmony";
  };
  const hierarchy = buildArrangementHierarchy(input.arrangementId, input.songModel, arrangementBrain, sections);
  const previousCarrier = new Map<string, string>();
  const motifByFunction = new Map<string, string>();
  const motifRecords: CompositionIntelligencePlan["motifs"] = [];
  const roleOwners = input.tracks.map((track) => ({
    trackId: track.id ?? track.name,
    role: roleForTrack(track),
    sourceVocal: /vocal|voice/.test(`${track.name} ${track.role}`.toLowerCase()),
  }));
  const foregroundOwners = roleOwners.filter((role) =>
    !role.sourceVocal &&
    (role.role === "lead" || role.role === "counterline" || role.role === "harmony"));
  const transformationFor = (
    development: ArrangementBrainSection["development"] | undefined,
    phraseIndex: number,
    hasVocal: boolean,
    hasSpace: boolean,
  ): MotifTransformation => hasSpace ? "answering_gesture"
    : hasVocal ? "repetition"
    : development === "development"
      ? (["rhythmic_variation", "register_displacement", "orchestral_handoff"] as const)[phraseIndex % 3]
      : development === "reprise" ? "augmentation"
      : phraseIndex % 2 ? "diminution" : "repetition";
  const compositionPhrases: CompositionIntelligencePlan["phrases"] = hierarchy.sections.flatMap((section, index) => {
    const brainSection = arrangementBrain.sections[index];
    const observedPhrases = section.phraseIds.map((id) => {
      const phrase = hierarchy.phrases.find((candidate) => candidate.id === id)!;
      const sourceId = id.split(":").at(-1);
      const source = input.songModel.vocalIntelligence?.phrases.events.find((event) =>
        event.id === sourceId);
      const range = source ? canonicalRange(source) : undefined;
      return {
        id, startBar: phrase.startBar, endBar: phrase.endBar, protectsVocal: true,
        startSeconds: range?.start.seconds, endSeconds: range?.end.seconds,
        response: undefined,
      };
    });
    const midpoint = Math.floor((section.startBar + section.endBar) / 2);
    const phraseRanges = observedPhrases.length ? observedPhrases
      : compositionVersion === "2.0" && section.endBar - section.startBar >= 3
        ? [
            { id: `phrase:${section.id}:a`, startBar: section.startBar, endBar: midpoint, protectsVocal: false, response: undefined },
            { id: `phrase:${section.id}:b`, startBar: midpoint + 1, endBar: section.endBar, protectsVocal: false, response: undefined },
          ]
        : [{ id: `phrase:${section.id}:whole`, startBar: section.startBar, endBar: section.endBar, protectsVocal: false, response: undefined }];
    const availableResponses = input.songModel.contractVersion === "2.0" &&
      input.songModel.vocalIntelligence?.arrangementSpace.status === "detected"
      ? input.songModel.vocalIntelligence.arrangementSpace.windows.flatMap((response) => {
          const range = canonicalRange(response);
          return range && range.start.bar <= section.endBar && range.end.bar >= section.startBar &&
            (!response.sections.length || response.sections.some((name) =>
              name.toLowerCase().replace(/\s+/g, "_") === section.sourceSection))
            ? [{
                id: `phrase:${section.id}:response:${response.id}`,
                startBar: range.start.bar,
                endBar: range.end.bar,
                startSeconds: range.start.seconds,
                endSeconds: range.end.seconds,
                protectsVocal: false,
                response,
              }]
            : [];
        }) : [];
    const existingMotif = motifByFunction.get(section.function);
    const motifRef = existingMotif ?? `motif:${hashSeed(`${evidenceSha256}:${section.function}:${section.id}`)}`;
    if (!existingMotif) motifByFunction.set(section.function, motifRef);
    return [...phraseRanges, ...availableResponses].map((phrase, phraseIndex) => {
      const hasVocal = phrase.protectsVocal;
      const hasSpace = Boolean(phrase.response);
      const intention: PhraseIntention = compositionVersion !== "2.0" ? "support"
        : hasVocal ? (foregroundOwners.length ? "silence" : "support")
        : hasSpace ? "response"
        : brainSection?.development === "development" ? "foreground"
        : (brainSection?.tension ?? 0) > .62 ? "transition" : "support";
      const transformation = transformationFor(
        brainSection?.development, phraseIndex, hasVocal, hasSpace,
      );
      const ownerTrackId = intention === "silence" ? null
        : foregroundOwners[(index + phraseIndex) % Math.max(1, foregroundOwners.length)]?.trackId ?? null;
      const phraseMotifRef = transformation === "repetition"
        ? motifRef : `${motifRef}:${transformation}:${hashSeed(phrase.id)}`;
      const parentMotifId = phraseMotifRef === motifRef ? null : motifRef;
      if (!motifRecords.some((motif) => motif.id === phraseMotifRef)) {
        motifRecords.push({
          id: phraseMotifRef,
          fingerprint: canonicalMotifFingerprint([]),
          sourceSectionId: section.id,
          sourcePhraseId: phrase.id,
          parentMotifId,
          transformation,
          ownerTrackId,
          evidenceSha256,
        });
      }
      return {
        id: phrase.id,
        sectionId: section.id,
        startBar: phrase.startBar,
        endBar: phrase.endBar,
        startSeconds: "startSeconds" in phrase ? phrase.startSeconds : undefined,
        endSeconds: "endSeconds" in phrase ? phrase.endSeconds : undefined,
        intent: compositionVersion !== "2.0" ? "state" as const
          : hasVocal ? "protect_vocal" as const
          : hasSpace ? "answer" as const
          : brainSection?.development === "development" ? "develop" as const
          : brainSection?.development === "reprise" ? "answer" as const
          : (brainSection?.tension ?? 0) > .62 ? "build" as const
          : (brainSection?.release ?? 0) > .35 ? "release" as const
          : phraseIndex ? "develop" as const : "state" as const,
        tension: compositionVersion === "2.0" ? brainSection?.tension ?? 0 : 0,
        motifRef: phraseMotifRef,
        sourceMotifRef: parentMotifId ?? (existingMotif ? motifRef : null),
        intention,
        transformation,
        responseToPhraseId: hasSpace && phrase.response?.phraseBeforeId
          ? hierarchy.phrases.find((candidate) =>
              candidate.id.endsWith(`:${phrase.response!.phraseBeforeId}`))?.id ?? null
          : null,
        ownerTrackId,
      };
    });
  });
  const compositionIntelligence: CompositionIntelligencePlan = {
    version: compositionVersion,
    mode: compositionVersion === "2.0" ? "reasoning_core" : "legacy",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: Number(input.parameters.seed ?? 0),
    evidenceSha256,
    songIntent: compositionVersion === "2.0" && arrangementBrain.enabled
      ? "develop_observed_form" : "preserve_observed_form",
    tensionRelease: hierarchy.sections.map((section, index) => ({
      sectionId: section.id,
      tension: compositionVersion === "2.0" ? arrangementBrain.sections[index]?.tension ?? 0 : 0,
      release: compositionVersion === "2.0" ? arrangementBrain.sections[index]?.release ?? 0 : 0,
    })),
    phrases: compositionPhrases,
    motifs: motifRecords,
    instrumentRoles: input.tracks.map((track) => ({
      trackId: track.id ?? track.name,
      function: roleForTrack(track),
      authority: "project_track",
    })),
    orchestrationAssignments: hierarchy.sections.flatMap((section, sectionIndex) => {
      const phrases = compositionPhrases
        .filter((phrase) => phrase.sectionId === section.id)
        .map((phrase) => phrase.id);
      const base = sectionAssignments[sectionIndex];
      const melodicIndexes = base.flatMap((assignment, assignmentIndex) =>
        ["hook", "response", "countermelody"].includes(assignment.role) ? [assignmentIndex] : []);
      return phrases.flatMap((phraseId, phraseIndex) => {
        const phraseAssignments = base.map((assignment, assignmentIndex) => {
          const melodicPosition = melodicIndexes.indexOf(assignmentIndex);
          if (melodicPosition < 0 || melodicIndexes.length < 2 || phraseIndex === 0) return assignment;
          const sourceIndex = melodicIndexes[
            (melodicPosition + phraseIndex) % melodicIndexes.length
          ];
          const source = base[sourceIndex];
          return { ...assignment, role: source.role, register: source.register };
        });
        return phraseAssignments.map((assignment) => {
        const idea = ["hook", "response", "countermelody"].includes(assignment.role)
          ? `melodic:${assignment.role}` : `${assignment.role}:${assignment.register}`;
        const prior = previousCarrier.get(idea) ?? null;
        const handoffFromTrackId = prior && prior !== assignment.trackId ? prior : null;
        previousCarrier.set(idea, assignment.trackId);
        if (phraseIndex === 0 && handoffFromTrackId) {
          const directive = sections[sectionIndex].trackDirectives?.[assignment.trackId];
          if (directive) directive.handoffFromTrackId = handoffFromTrackId;
        }
        return {
          sectionId: section.id,
          phraseId,
          trackId: assignment.trackId,
          role: assignment.role,
          register: assignment.register,
          handoffFromTrackId,
          doublingTrackId: assignment.doublingTrackId,
        };
        });
      });
    }),
  };
  if (compositionVersion === "2.0") {
    compositionIntelligence.groove = buildSharedGroovePlan(
      input.songModel,
      hierarchy,
      compositionIntelligence,
      input.style,
    );
  }
  return {
    id: input.arrangementId,
    version: input.version,
    sections,
    style: input.style,
    songModelVersion: Number(input.parameters.songModelVersion ?? 0),
    parameters: input.parameters,
    provenance: provenance("ARRANGEMENT_DIRECTOR", compositionVersion === "2.0" ? "2.0.0" : "1.0.0", {
      ...input.parameters,
      compositionVersion,
      compositionEvidenceSha256: evidenceSha256,
    }, input.parentIds),
    hierarchy,
    compositionIntelligence,
  };
}
function createArrangementPlanWithStyle(input: {
  arrangementId: string;
  version: number;
  songModel: SongModelData;
  style: StyleSpec;
  tracks: Array<{ id?: string; name: string; role: string }>;
  parameters: Record<string, number | string | boolean>;
  parentIds?: string[];
  arrangementBrain?: ArrangementBrain;
  compositionVersion?: CompositionIntelligenceVersion;
  generationPreference?: GenerationPreferenceSnapshot | null;
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
    compositionVersion: input.compositionVersion,
  });
  let priorLayerCount: number | undefined;
  const sections: ArrangementPlanSection[] = sourceSections.map((section, index) => {
    const brainSection = arrangementBrain.enabled ? arrangementBrain.sections[index] : undefined;
    const plannedEnergy = brainSection?.targetEnergy ?? section.energy;
    const plannedDensity = brainSection?.targetDensity ??
      clamp(input.style.orchestration.density * 0.65 + section.energy * 0.35);
    const preference = input.generationPreference?.effects;
    const grammar = input.parameters.styleGrammarVersion === "1.0"
      ? input.style.grammar?.vocabulary
      : undefined;
    const operations = plannedEnergy > 0.75
      ? ["build_up", "countermelody"]
      : plannedEnergy < 0.3
        ? ["break"]
        : ["phrase"];
    if (grammar) operations.push(`groove:${grammar.groove}`);
    if (grammar) operations.push(`instrumentation:${grammar.instrumentation}`);
    if (grammar) operations.push(`fills:${grammar.fills}`);
    if (grammar?.phraseBehavior === "call_response" &&
      (preference?.responseFrequency ?? .5) >= .45) operations.push("call_response");
    if (grammar?.phraseBehavior === "continuous") operations.push("continuous_phrase");
    if (grammar?.phraseBehavior === "sparse_answers") operations.push("sparse_answers");
    if (grammar?.phraseBehavior === "motivic") operations.push("motivic_phrase");
    if (preference?.development === "progressive") operations.push("develop_motif");
    else if (preference?.development === "restrained") operations.push("preserve_motif");
    else if (grammar?.development === "transformative") operations.push("transform_motif");
    else if (grammar?.development === "additive") operations.push("additive_layers");
    else if (grammar?.development === "dynamic_arc") operations.push("dynamic_arc");
    else if (grammar?.development === "repetition") operations.push("repeat_motif");
    if (index === sourceSections.length - 1 && modulationSemitones !== 0) {
      operations.push(`modulate:${modulationSemitones}`);
    }
    const directives: Record<string, TrackDirective> = {};
    const unconstrainedLayers = Math.max(1, Math.ceil(input.tracks.length *
      clamp(.25 + orchestraSize * .55 + plannedEnergy * .2 +
        (preference?.orchestrationDensity ?? 0))));
    const layerCount = arrangementBrain.enabled && priorLayerCount !== undefined
      ? clamp(unconstrainedLayers, Math.max(1, priorLayerCount - 1), Math.min(input.tracks.length, priorLayerCount + 1))
      : unconstrainedLayers;
    priorLayerCount = layerCount;
    const emphasis = preference?.roleEmphasis;
    const roleScore = (track: typeof input.tracks[number]) => {
      const identity = `${track.name} ${track.role}`.toLowerCase();
      const family = getInstrumentDefinition(track.name, track.role).family;
      const grammarFamilies: Record<NonNullable<typeof grammar>["instrumentation"], string[]> = {
        acoustic: ["keys", "strings", "guitar", "drums"],
        electronic: ["synth", "drums"],
        hybrid: ["keys", "strings", "guitar", "drums", "synth"],
        orchestral: ["keys", "strings", "brass", "drums"],
      };
      const grammarFamilyBoost = grammar &&
        grammarFamilies[grammar.instrumentation].includes(family) ? 1 : 0;
      const emphasisBoost = emphasis === "foundation" && /bass/.test(identity) ? 3 :
        emphasis === "pulse" && /drum|rhythm|percussion/.test(identity) ? 3 :
        emphasis === "counterline" && /string|brass|counter|melody/.test(identity) ? 3 :
        emphasis === "texture" && /pad|synth|texture/.test(identity) ? 3 :
        emphasis === "harmony" && /piano|keys|guitar|harmony/.test(identity) ? 3 : 0;
      return emphasisBoost + grammarFamilyBoost;
    };
    const ordered = [...input.tracks].sort((left, right) =>
      roleScore(right) - roleScore(left) ||
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
      const grammarVoicing = grammar?.voicing === "wide" ? "wide" :
        grammar?.voicing === "close" || grammar?.voicing === "drop_two" ? "close" :
        "open";
      const voicingCharacter = preference?.voicingCharacter ?? grammarVoicing;
      directives[trackId] = {
        role: track.role,
        register: bass ? "low" : melodic ? "high" :
          voicingCharacter === "wide" ? (index % 2 ? "high" : "low") :
          voicingCharacter === "close" ? "middle" :
          plannedEnergy > .68 ? "high" : "middle",
        rhythmicActivity: round(clamp((percussion
          ? plannedEnergy * .45 + rhythmIntensity * .55
          : (input.style.rhythm.syncopation * .45 + plannedEnergy * .55) *
            (.55 + rhythmIntensity * .45)) *
          (melodic || /counter|string|brass/.test(identity)
            ? .7 + (preference?.responseFrequency ?? .5) * .6
            : 1))),
        harmonicActivity: round(clamp(percussion || melodic ? 0 :
          input.style.harmony.complexity / 10 * .55 + plannedEnergy * .3 +
          ((preference?.responseFrequency ?? .5) - .5) * .7)),
        dynamicTarget: round(clamp(.28 + plannedEnergy * .68 +
          ((preference?.transitionIntensity ?? .5) - .5) * .15)),
        articulationFamily: grammar?.articulation === "legato" ? "legato" :
          grammar?.articulation === "accented" ? "accent" :
          grammar?.articulation === "tight" || grammar?.articulation === "pulsed" ? "tight" :
          percussion ? (plannedEnergy > .7 ? "accent" : "tight") :
          plannedEnergy > .72 ? "accent" : "legato",
        entry: { bar: section.startBar, mode: index === 0 ? "downbeat" : "phrase_entry" },
        exit: { bar: section.endBar, mode: index === sourceSections.length - 1 ? "cadence" : "release" },
        transition: index === 0 ? "none" :
          grammar?.transitions === "hard_cut" ? "cut" :
          grammar?.transitions === "orchestral_swell" ? "swell" :
          grammar?.transitions === "riser" ? "riser" :
          (preference?.transitionIntensity ?? .5) > .62 ? "build" :
          plannedEnergy > (arrangementBrain.enabled ? arrangementBrain.sections[index - 1]?.targetEnergy : sourceSections[index - 1].energy) ? "build" : "thin",
        fill: percussion && index < sourceSections.length - 1 &&
          (grammar?.fills === "frequent" ||
            (plannedEnergy >= .55 && rhythmIntensity >= .45)) &&
          grammar?.fills !== "none" &&
          (grammar?.fills === "frequent" || index % 2 === 0 ||
            (preference?.transitionIntensity ?? .5) > .62),
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
  const compositionVersion = input.compositionVersion ?? arrangementBrain.compositionVersion;
  const evidenceSha256 = compositionEvidenceSha256(
    input.songModel,
    Number(input.parameters.songModelVersion ?? 0),
  );
  const roleForTrack = (track: typeof input.tracks[number]): CompositionIntelligencePlan["instrumentRoles"][number]["function"] => {
    const identity = `${track.name} ${track.role}`.toLowerCase();
    if (/bass/.test(identity)) return "foundation";
    if (/drum|rhythm|percussion/.test(identity)) return "pulse";
    if (/vocal|voice|melody|lead/.test(identity)) return "lead";
    if (/string|brass|counter/.test(identity)) return "counterline";
    if (/pad|texture|ambient/.test(identity)) return "texture";
    return "harmony";
  };
  const hierarchy = buildArrangementHierarchy(input.arrangementId, input.songModel, arrangementBrain, sections);
  const motifByFunction = new Map<string, string>();
  const compositionIntelligence: CompositionIntelligencePlan = {
    version: compositionVersion,
    mode: compositionVersion === "2.0" ? "reasoning_core" : "legacy",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: Number(input.parameters.seed ?? 0),
    evidenceSha256,
    songIntent: compositionVersion === "2.0" && arrangementBrain.enabled
      ? "develop_observed_form" : "preserve_observed_form",
    tensionRelease: hierarchy.sections.map((section, index) => ({
      sectionId: section.id,
      tension: compositionVersion === "2.0" ? arrangementBrain.sections[index]?.tension ?? 0 : 0,
      release: compositionVersion === "2.0" ? arrangementBrain.sections[index]?.release ?? 0 : 0,
    })),
    phrases: hierarchy.sections.flatMap((section, index) => {
      const brainSection = arrangementBrain.sections[index];
      const phraseIds = section.phraseIds.length ? section.phraseIds : [`phrase:${section.id}:whole`];
      const existingMotif = motifByFunction.get(section.function);
      const motifRef = existingMotif ?? `motif:${hashSeed(`${evidenceSha256}:${section.function}:${section.id}`)}`;
      if (!existingMotif) motifByFunction.set(section.function, motifRef);
      return phraseIds.map((id, phraseIndex) => ({
        id,
        sectionId: section.id,
        startBar: hierarchy.phrases.find((phrase) => phrase.id === id)?.startBar ?? section.startBar,
        endBar: hierarchy.phrases.find((phrase) => phrase.id === id)?.endBar ?? section.endBar,
        intent: compositionVersion !== "2.0" ? "state" as const
          : section.phraseIds.length ? "protect_vocal" as const
          : brainSection?.development === "development" ? "develop" as const
          : brainSection?.development === "reprise" ? "answer" as const
          : (brainSection?.tension ?? 0) > .62 ? "build" as const
          : (brainSection?.release ?? 0) > .35 ? "release" as const
          : phraseIndex ? "develop" as const : "state" as const,
        tension: compositionVersion === "2.0" ? brainSection?.tension ?? 0 : 0,
        motifRef,
        sourceMotifRef: existingMotif ?? null,
        intention: "support",
        transformation: "repetition",
        responseToPhraseId: null,
        ownerTrackId: null,
      }));
    }),
    instrumentRoles: input.tracks.map((track) => ({
      trackId: track.id ?? track.name,
      function: roleForTrack(track),
      authority: "project_track",
    })),
    motifs: [],
  };
  if (compositionVersion === "2.0") {
    compositionIntelligence.groove = buildSharedGroovePlan(
      input.songModel,
      hierarchy,
      compositionIntelligence,
      input.style,
    );
  }
  return {
    id: input.arrangementId,
    version: input.version,
    sections,
    style: input.style,
    songModelVersion: Number(input.parameters.songModelVersion ?? 0),
    parameters: input.parameters,
    provenance: provenance("ARRANGEMENT_DIRECTOR", compositionVersion === "2.0" ? "2.0.0" : "1.0.0", {
      ...input.parameters,
      compositionVersion,
      compositionEvidenceSha256: evidenceSha256,
      styleGrammarVersion: input.style.grammar?.version ?? "legacy",
      styleGrammarEvidenceSha256: input.style.grammar?.evidenceSha256 ?? "legacy",
      generationPreferenceVersion: input.generationPreference?.calibrationVersion ?? 0,
      generationPreferenceEvidenceSha256: input.generationPreference?.evidenceSha256 ?? "none",
    }, input.parentIds),
    hierarchy,
    compositionIntelligence,
    generationPreference: input.generationPreference ?? null,
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
  compositionVersion?: CompositionIntelligenceVersion;
  generationPreference?: GenerationPreferenceSnapshot | null;
}): ArrangementPlan {
  const orchestrationPlan = createArrangementPlanWithOrchestration(input);
  const stylePlan = createArrangementPlanWithStyle(input);
  return {
    ...orchestrationPlan,
    sections: orchestrationPlan.sections.map((section, index) => {
      const styledSection = stylePlan.sections[index];
      if (!styledSection) return section;
      const trackIds = new Set([
        ...Object.keys(section.trackDirectives ?? {}),
        ...Object.keys(styledSection.trackDirectives ?? {}),
      ]);
      return {
        ...section,
        activeTracks: input.generationPreference
          ? styledSection.activeTracks
          : section.activeTracks,
        tracks: input.generationPreference
          ? styledSection.tracks
          : section.tracks,
        operations: [...new Set([...section.operations, ...styledSection.operations])],
        trackDirectives: Object.fromEntries([...trackIds].map((trackId) => [
          trackId,
          {
            ...section.trackDirectives?.[trackId],
            ...styledSection.trackDirectives?.[trackId],
            musicalFunction: section.trackDirectives?.[trackId]?.musicalFunction,
            handoffFromTrackId: section.trackDirectives?.[trackId]?.handoffFromTrackId,
          },
        ])),
      };
    }),
    compositionIntelligence: ({
      ...orchestrationPlan.compositionIntelligence,
      ...(orchestrationPlan.compositionIntelligence?.groove
        ? {
          groove: {
            ...orchestrationPlan.compositionIntelligence.groove,
            events: orchestrationPlan.compositionIntelligence.groove.events.map((event) => {
              const hierarchyIndex = orchestrationPlan.hierarchy.sections.findIndex((section) =>
                section.id === event.sectionId);
              const fillMode = stylePlan.sections[hierarchyIndex]?.operations
                .find((operation) => operation.startsWith("fills:"))
                ?.slice("fills:".length);
              return fillMode === "frequent" && event.responsibility === "pulse"
                ? {
                  ...event,
                  gesture: "fill" as const,
                  velocity: midi((event.velocity ?? 72) + 5),
                }
                : event;
            }),
          },
        }
        : {}),
    }) as CompositionIntelligencePlan,
    provenance: {
      ...orchestrationPlan.provenance,
      parameters: {
        ...orchestrationPlan.provenance.parameters,
        styleGrammarVersion: input.style.grammar?.version ?? "legacy",
        styleGrammarEvidenceSha256: input.style.grammar?.evidenceSha256 ?? "legacy",
        generationPreferenceVersion: input.generationPreference?.calibrationVersion ?? 0,
        generationPreferenceEvidenceSha256: input.generationPreference?.evidenceSha256 ?? "none",
      },
    },
    generationPreference: input.generationPreference ?? null,
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

function arrangementBarRangeSeconds(
  songModel: SongModelData,
  startBar: number,
  endBar: number,
  fallbackBarSeconds: number,
): { start: number; end: number } {
  const bars = songModel.bars
    .filter((bar) => bar.bar >= startBar && bar.bar <= endBar)
    .sort((left, right) => left.bar - right.bar);
  if (bars.length) {
    const start = bars[0].coordinates?.start.seconds ?? bars[0].start;
    const end = bars.at(-1)!.coordinates?.end.seconds ?? bars.at(-1)!.end;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) return { start, end };
  }
  return {
    start: (startBar - 1) * fallbackBarSeconds,
    end: endBar * fallbackBarSeconds,
  };
}
function createArrangementSpaceMap(
  songModel: SongModelData,
  plan: ArrangementPlan,
  fallbackBarSeconds: number,
): ArrangementSpaceMap | undefined {
  const intelligence = songModel.contractVersion === "2.0" ? songModel.vocalIntelligence : undefined;
  const canonicalPhrases = intelligence?.phrases.status === "detected"
    ? intelligence.phrases.events.filter(hasCanonicalWindow)
    : [];
  const canonicalSpace = intelligence?.arrangementSpace.status === "detected"
    ? intelligence.arrangementSpace.windows.filter(hasCanonicalWindow)
    : [];
  const evidence = songModel.contractVersion === "2.0" ? songModel.vocalEvidence : undefined;
  // A detected status is not enough: use only windows represented on the
  // canonical timeline, and require actual observed voiced occupancy.
  const canonicalEvidence = evidence?.status === "detected" &&
    evidence.observedVoicedWindows.some(hasCanonicalWindow) &&
    [...evidence.observedVoicedWindows, ...evidence.observedSilentWindows].every(hasCanonicalWindow)
    ? evidence
    : undefined;
  if (!canonicalPhrases.length && !canonicalSpace.length && !canonicalEvidence) {
    return undefined;
  }
  const clip = (
    windows: Array<{ coordinates?: { start: { seconds: number }; end: { seconds: number } } }>,
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
    voiced: clip([
      ...canonicalPhrases,
      ...(canonicalEvidence?.observedVoicedWindows ?? []),
    ]),
    silent: clip([
      ...canonicalSpace,
      ...(canonicalEvidence?.observedSilentWindows ?? []),
    ]),
  };
}

function intersectsObservedVoice(
  start: number,
  end: number,
  spaceMap: ArrangementSpaceMap | undefined,
): boolean {
  return Boolean(spaceMap?.voiced.some((window) => start < window.end && end > window.start));
}

function hierarchyEventIntent(
  plan: ArrangementPlan,
  sectionIndex: number,
  trackId: string,
  trackName: string,
  time: number,
  songModel: SongModelData,
  fallbackBarSeconds: number,
): ArrangementHierarchy["events"][number]["intent"] | undefined {
  if (plan.hierarchy?.status !== "applied") return undefined;
  const section = plan.hierarchy.sections[sectionIndex];
  if (!section) return undefined;
  const bar = plan.hierarchy.bars.find((candidate) => {
    if (candidate.sectionId !== section.id) return false;
    const observed = songModel.bars.find((source) => source.bar === candidate.bar);
    const start = observed?.coordinates?.start.seconds ?? observed?.start ??
      (candidate.bar - 1) * fallbackBarSeconds;
    const end = observed?.coordinates?.end.seconds ?? observed?.end ??
      candidate.bar * fallbackBarSeconds;
    return time >= start && time < end;
  });
  return bar
    ? plan.hierarchy.events.find((event) =>
      event.barId === bar.id && (event.trackId === trackId || event.trackId === trackName))?.intent
    : undefined;
}

function compositionPhraseAtTime(
  plan: ArrangementPlan,
  songModel: SongModelData,
  sectionIndex: number,
  time: number,
  fallbackBarSeconds: number,
): CompositionIntelligencePlan["phrases"][number] | undefined {
  const reasoning = plan.compositionIntelligence;
  const section = plan.hierarchy?.sections[sectionIndex];
  if (reasoning?.version !== "2.0" || !section) return undefined;
  const observedBar = songModel.bars.find((bar) => {
    const start = bar.coordinates?.start.seconds ?? bar.start;
    const end = bar.coordinates?.end.seconds ?? bar.end;
    return time >= start && time < end;
  })?.bar;
  const bar = observedBar ?? Math.floor(time / fallbackBarSeconds) + 1;
  return reasoning.phrases
    .filter((phrase) =>
      phrase.sectionId === section.id &&
      (phrase.startSeconds === undefined || time >= phrase.startSeconds) &&
      (phrase.endSeconds === undefined || time < phrase.endSeconds) &&
      phrase.startBar <= bar &&
      phrase.endBar >= bar)
    .sort((left, right) =>
      (left.endBar - left.startBar) - (right.endBar - right.startBar) ||
      left.startBar - right.startBar ||
      left.id.localeCompare(right.id))[0];
}

function orchestrationAssignmentAtTime(
  plan: ArrangementPlan,
  songModel: SongModelData,
  sectionIndex: number,
  trackId: string,
  time: number,
  fallbackBarSeconds: number,
) {
  const assignments = plan.compositionIntelligence?.orchestrationAssignments;
  const section = plan.hierarchy?.sections[sectionIndex];
  if (!assignments?.length || !section) return undefined;
  const phrase = compositionPhraseAtTime(plan, songModel, sectionIndex, time, fallbackBarSeconds);
  const exact = assignments.find((assignment) =>
    assignment.sectionId === section.id &&
    assignment.trackId === trackId &&
    (!phrase || assignment.phraseId === phrase.id));
  if (phrase && assignments.some((assignment) =>
    assignment.sectionId === section.id && assignment.phraseId === phrase.id)) return exact;
  return exact ?? assignments.find((assignment) =>
      assignment.sectionId === section.id && assignment.trackId === trackId);
}
function hierarchySpaceMapForTrack(
  songModel: SongModelData,
  plan: ArrangementPlan,
  trackId: string,
  spaceMap: ArrangementSpaceMap | undefined,
  fallbackBarSeconds: number,
): ArrangementSpaceMap | undefined {
  if (!spaceMap || plan.hierarchy?.status !== "applied") return spaceMap;
  if (plan.compositionIntelligence?.groove?.roles.some((role) => role.trackId === trackId)) {
    return spaceMap;
  }
  const supportedBars = new Set(plan.hierarchy.events
    .filter((event) => event.trackId === trackId && event.intent === "support_vocal")
    .map((event) => event.barId));
  return {
    silent: spaceMap.silent,
    voiced: spaceMap.voiced.filter((window) =>
      plan.hierarchy.bars.some((bar) => {
        if (!supportedBars.has(bar.id)) return false;
        const section = plan.hierarchy.sections.find((candidate) => candidate.id === bar.sectionId);
        if (section?.sourceSection !== window.section) return false;
        const observed = songModel.bars.find((source) => source.bar === bar.bar);
        const start = observed?.coordinates?.start.seconds ?? observed?.start ??
          (bar.bar - 1) * fallbackBarSeconds;
        const end = observed?.coordinates?.end.seconds ?? observed?.end ??
          bar.bar * fallbackBarSeconds;
        return window.start < end && window.end > start;
      })),
  };
}

export class CompositionEngine {
  private composeWithCoordinatedGroove(input: {
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
    const grooveTimeline = input.plan.compositionIntelligence?.groove
      ? createCanonicalTimeline(
          input.songModel.tempoMap.map(({ time, bpm: eventBpm }) => ({ time, bpm: eventBpm })),
          input.songModel.meterMap.map(({ bar, meter }) => ({ bar, meter })),
        )
      : undefined;
    const composed = input.tracks.map((track) => {
      const definition = getInstrumentDefinition(track.instrument || track.name, track.role);
      const notes: MusicalNote[] = [];
      const appliedDirectives: NonNullable<TrackModel["appliedDirectives"]> = [];
      const identity = `${track.name} ${track.role}`.toLowerCase();
      if (identity.includes("vocal") && input.songModel.melody.length) {
        // Melody evidence is never extrapolated. It is merely split at
        // explicitly active section boundaries so a vocal arrangement can
        // enter/leave without leaking notes through inactive sections.
        input.plan.sections.forEach((section, sectionIndex) => {
          const bounds = arrangementSectionSeconds(input.songModel, section, barSeconds);
          const sectionStart = bounds.start;
          const sectionEnd = bounds.end;
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
      } else if (input.plan.compositionIntelligence?.version === "2.0" &&
        identity.includes("bass") && readBassEvidence(input.songModel).length) {
        input.plan.sections.forEach((section, sectionIndex) => {
          const bounds = arrangementSectionSeconds(input.songModel, section, barSeconds);
          const action = section.tracks[track.id] ?? section.tracks[track.name] ?? "root_motion";
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
              start: bounds.start,
              end: bounds.end,
              directive,
            });
          }
          readBassEvidence(input.songModel).forEach((note, noteIndex) => {
            const start = Math.max(bounds.start, note.start);
            const end = Math.min(bounds.end, note.end);
            if (end <= start) return;
            notes.push({
              id: `${track.id}:observed-bass:${noteIndex}:${sectionIndex}`,
              start: round(start),
              duration: round(end - start),
              pitch: Math.max(definition.playableRange.min,
                Math.min(definition.playableRange.max, midi(note.pitch))),
              velocity: 82,
              voice: "bass-evidence",
            });
          });
        });
      } else if (!identity.includes("vocal")) {
        input.plan.sections.forEach((section, sectionIndex) => {
          const bounds = arrangementSectionSeconds(input.songModel, section, barSeconds);
          const sectionStart = bounds.start;
          const sectionEnd = bounds.end;
          const action = section.tracks[track.id] ?? section.tracks[track.name] ?? "main_harmony";
          const active = section.activeTracks
            ? section.activeTracks.includes(track.id) || section.activeTracks.includes(track.name)
            : action !== "none";
          if (!active || action === "none") return;
          const directive = section.trackDirectives?.[track.id] ??
            section.trackDirectives?.[track.name];
          const reasoning = input.plan.compositionIntelligence?.version === "2.0"
            ? input.plan.compositionIntelligence : undefined;
          const hierarchySection = input.plan.hierarchy?.sections[sectionIndex];
          const roleDecision = reasoning?.instrumentRoles.find((role) => role.trackId === track.id);
          const sectionArc = hierarchySection
            ? reasoning?.tensionRelease.find((arc) => arc.sectionId === hierarchySection.id)
            : undefined;
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
          const rhythmic = clamp((directive?.rhythmicActivity ?? section.density) +
            (reasoning ? (sectionArc?.tension ?? 0) * .12 : 0));
          const musicalFunction = directive?.musicalFunction;
          const grooveEvents = reasoning?.groove?.events.filter((event) =>
            event.trackId === track.id && event.sectionId === hierarchySection?.id);
          const step = identity.includes("drum") || identity.includes("rhythm")
            ? beat * (rhythmic > .7 ? .5 : 1)
            : musicalFunction === "pulse" || musicalFunction === "groove" ? beat
            : musicalFunction === "accent" || musicalFunction === "transition" ? beat * 4
            : musicalFunction === "pad" || musicalFunction === "texture" ? beat * 4
            : beat * (directive?.harmonicActivity && directive.harmonicActivity > .65 ? 1 : 2);
          const materializationEvents = grooveEvents?.length
            ? grooveEvents.map((event) => ({
                time: event.coordinate.seconds,
                duration: grooveTimeline!.tickToSeconds(
                  event.coordinate.tick + event.durationTicks,
                ) - grooveTimeline!.tickToSeconds(event.coordinate.tick),
                velocity: event.velocity,
                gesture: event.gesture,
                id: event.id,
              }))
            : Array.from(
                { length: Math.max(0, Math.ceil((sectionEnd - sectionStart) / step)) },
                (_, index) => ({
                  time: sectionStart + index * step,
                  duration: step,
                  velocity: undefined,
                  gesture: "state",
                  id: `${track.id}-${sectionIndex}-${index}`,
                }),
              );
          for (const grooveEvent of materializationEvents) {
            const time = grooveEvent.time;
            if (time < sectionStart || time >= sectionEnd) continue;
            const phraseDecision = compositionPhraseAtTime(
              input.plan, input.songModel, sectionIndex, time, barSeconds,
            );
            const orchestrationAssignment = orchestrationAssignmentAtTime(
              input.plan, input.songModel, sectionIndex, track.id, time, barSeconds,
            );
            if (reasoning?.orchestrationAssignments?.length && !orchestrationAssignment) continue;
            const eventFunction = orchestrationAssignment?.role ?? musicalFunction;
            const motifOffset = phraseDecision
              ? (hashSeed(`${phraseDecision.motifRef}:${eventFunction ?? roleDecision?.function ?? "harmony"}`) % 3) - 1
              : 0;
            const beatIndex = Math.round((time - sectionStart) / beat);
            const chord = input.harmony.find((candidate) =>
              candidate.start <= time + .001 && candidate.end > time + .001)
              ?? input.harmony.find((candidate) => candidate.start < sectionEnd && candidate.end > sectionStart);
            const chordTone = chord?.tones[(beatIndex + sectionIndex) % (chord?.tones.length || 1)] ?? 60;
            let pitch = identity.includes("bass")
              ? chordTone - 24
              : identity.includes("drum") || identity.includes("rhythm")
                ? eventFunction === "groove"
                  ? [36, 46, 38, 42][beatIndex % 4]
                  : eventFunction === "transition"
                    ? [41, 43, 45, 47][beatIndex % 4]
                    : eventFunction === "accent"
                      ? [49, 42, 49, 42][beatIndex % 4]
                      : [36, 42, 38, 42][beatIndex % 4]
                : chordTone + (directive?.register === "high" || identity.includes("string") || identity.includes("brass") ? 12 : 0);
            if (reasoning && !identity.includes("drum") && !identity.includes("rhythm")) {
              pitch += motifOffset * (eventFunction === "countermelody" ||
                roleDecision?.function === "counterline" ? 2 : 1);
              if (phraseDecision?.intent === "answer" && beatIndex % 2 === 1) pitch -= 2;
            }
            const targetRegisterName = orchestrationAssignment?.register ?? directive?.register;
            const targetRegister = targetRegisterName
              ? definition.registers.find((register) => register.name === targetRegisterName)
              : undefined;
            const preferred = targetRegister ?? definition.comfortableRange;
            while (pitch < preferred.min) pitch += 12;
            while (pitch > preferred.max) pitch -= 12;
            pitch = Math.max(preferred.min, Math.min(preferred.max, pitch));
            pitch = Math.max(definition.playableRange.min, Math.min(definition.playableRange.max, pitch));
            const isEntry = Math.abs(time - sectionStart) < .001;
            const isExit = time + step >= sectionEnd;
            const eventStep = grooveEvents?.length ? grooveEvent.duration : step;
            const duration = round(Math.min(
              eventStep * (eventFunction === "pad" || eventFunction === "texture" ||
                identity.includes("pad") ? 1.8 : isExit ? .65 : .9),
              sectionEnd - time,
            ));
            const hierarchyIntent = hierarchyEventIntent(
              input.plan, sectionIndex, track.id, track.name, time, input.songModel, barSeconds,
            );
            // Do not replace a measured vocal rest with a guessed one. The
            // observed silent map is intentionally permissive; only measured
            // voiced occupancy removes a phrase/fill event.
            const protectObservedVoice = Boolean(grooveEvents?.length) ||
              hierarchyIntent === "support_vocal";
            if (!protectObservedVoice ||
              !intersectsObservedVoice(time, time + duration, input.spaceMap)) {
              notes.push({
                id: grooveEvents?.length ? grooveEvent.id : `${track.id}-${sectionIndex}-${beatIndex}`,
                start: round(time),
                duration,
                pitch: midi(pitch),
                velocity: grooveEvent.velocity === undefined
                  ? midi(42 + (directive?.dynamicTarget ?? section.energy) * 66 +
                    (reasoning ? (sectionArc?.tension ?? 0) * 10 - (sectionArc?.release ?? 0) * 8 +
                      (phraseDecision?.tension ?? 0) * 4 : 0) +
                    (isEntry ? 6 : 0) + (directive?.transition === "build" ? beatIndex * .5 : 0) +
                    (beatIndex % 4 === 0 ? 8 : 0))
                  : midi(grooveEvent.velocity + (sectionArc?.tension ?? 0) * 10 -
                    (sectionArc?.release ?? 0) * 8 + (phraseDecision?.tension ?? 0) * 4),
                voice: eventFunction ?? (identity.includes("bass") ? "foundation" :
                  identity.includes("drum") ? "pulse" : "harmonic_support"),
              });
            }
            if (!grooveEvents?.length && directive?.fill && (identity.includes("drum") || identity.includes("rhythm")) && isExit &&
              (hierarchyIntent === undefined || hierarchyIntent === "use_vocal_space" || hierarchyIntent === "follow_section") &&
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
        version: input.plan.compositionIntelligence?.version === "2.0" ? 2 : 1,
        provenance: provenance(
          "COMPOSITION_ENGINE",
          input.plan.compositionIntelligence?.version === "2.0" ? "2.0.0" : "1.0.0",
          {
            bpm,
            compositionVersion: input.plan.compositionIntelligence?.version ?? "1.0",
            compositionEvidenceSha256: input.plan.compositionIntelligence?.evidenceSha256 ?? "legacy",
          },
        ),
      };
    });
    const doubled = materializeExplicitDoublings(composed, input.plan, input.songModel, barSeconds);
    const reasoning = input.plan.compositionIntelligence;
    if (reasoning?.version !== "2.0") return doubled;
    const shaped = doubled.map((track) => {
      const role = reasoning.instrumentRoles.find((candidate) => candidate.trackId === track.id);
      const notes = track.notes.flatMap((note, index) => {
        const sectionIndex = input.plan.sections.findIndex((section) => {
          const bounds = arrangementSectionSeconds(input.songModel, section, barSeconds);
          return note.start >= bounds.start && note.start < bounds.end;
        });
        const phrase = compositionPhraseAtTime(
          input.plan, input.songModel, sectionIndex, note.start, barSeconds,
        );
        if (!phrase) return [note];
        const motif = reasoning.motifs?.find((candidate) => candidate.id === phrase.motifRef);
        const foreground = role?.function === "lead" || role?.function === "counterline";
        if (phrase.intention === "silence" && foreground) return [];
        if (phrase.intention === "response" && phrase.ownerTrackId !== track.id) return [];
        if (phrase.intention === "foreground" && foreground &&
          phrase.ownerTrackId && phrase.ownerTrackId !== track.id) return [];
        if (phrase.transformation === "augmentation" && index % 2 === 1) return [];
        let pitch = note.pitch;
        if (track.instrumentDefinition.family !== "drums") {
          if (phrase.transformation === "register_displacement") pitch += 12;
          if (phrase.transformation === "answering_gesture" && index % 2 === 1) pitch -= 3;
          while (pitch > track.instrumentDefinition.playableRange.max) pitch -= 12;
          while (pitch < track.instrumentDefinition.playableRange.min) pitch += 12;
        }
        const durationScale = phrase.transformation === "augmentation" ? 1.5
          : phrase.transformation === "diminution" ? .5 : 1;
        const duration = round(Math.max(
          track.instrumentDefinition.constraints.minNoteDuration,
          Math.min(
            note.duration * durationScale,
            phrase.endSeconds === undefined ? Number.POSITIVE_INFINITY : phrase.endSeconds - note.start,
          ),
        ));
        return [{
          ...note,
          id: note.id,
          pitch: midi(pitch),
          duration,
          motif: motif ? {
            id: motif.id,
            fingerprint: motif.fingerprint,
            parentMotifId: motif.parentMotifId,
            transformation: phrase.transformation,
            phraseId: phrase.id,
            intention: phrase.intention,
            evidenceSha256: motif.evidenceSha256,
            windowEndSeconds: phrase.intention === "response" ? phrase.endSeconds : undefined,
          } : note.motif,
        }];
      });
      for (const phrase of reasoning.phrases.filter((candidate) =>
        candidate.intention === "response" &&
        candidate.ownerTrackId === track.id &&
        candidate.startSeconds !== undefined &&
        candidate.endSeconds !== undefined)) {
        if (notes.some((note) => note.motif?.phraseId === phrase.id)) continue;
        const motif = reasoning.motifs?.find((candidate) => candidate.id === phrase.motifRef);
        const responseStart = phrase.startSeconds!;
        const responseEnd = phrase.endSeconds!;
        const minimum = track.instrumentDefinition.constraints.minNoteDuration;
        const duration = round(Math.min(.35, responseEnd - responseStart));
        if (!motif || duration < minimum) continue;
        notes.push({
          id: `${track.id}:${Math.round(responseStart * 1_000_000)}:response`,
          start: responseStart,
          duration,
          pitch: Math.round((track.instrumentDefinition.comfortableRange.min +
            track.instrumentDefinition.comfortableRange.max) / 2),
          velocity: 76,
          voice: "response",
          motif: {
            id: motif.id,
            fingerprint: motif.fingerprint,
            parentMotifId: motif.parentMotifId,
            transformation: phrase.transformation,
            phraseId: phrase.id,
            intention: phrase.intention,
            evidenceSha256: motif.evidenceSha256,
            windowEndSeconds: responseEnd,
          },
        });
      }
      return { ...track, notes: notes.sort((left, right) => left.start - right.start || left.id.localeCompare(right.id)) };
    });
    return synchronizeMotifLineage(shaped, reasoning);
  }
  private composeWithoutSharedGroove(input: {
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
    const composed = input.tracks.map((track) => {
      const definition = getInstrumentDefinition(track.instrument || track.name, track.role);
      const notes: MusicalNote[] = [];
      const appliedDirectives: NonNullable<TrackModel["appliedDirectives"]> = [];
      const identity = `${track.name} ${track.role}`.toLowerCase();
      if (identity.includes("vocal") && input.songModel.melody.length) {
        // Melody evidence is never extrapolated. It is merely split at
        // explicitly active section boundaries so a vocal arrangement can
        // enter/leave without leaking notes through inactive sections.
        input.plan.sections.forEach((section, sectionIndex) => {
          const bounds = arrangementSectionSeconds(input.songModel, section, barSeconds);
          const sectionStart = bounds.start;
          const sectionEnd = bounds.end;
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
          const bounds = arrangementSectionSeconds(input.songModel, section, barSeconds);
          const sectionStart = bounds.start;
          const sectionEnd = bounds.end;
          const action = section.tracks[track.id] ?? section.tracks[track.name] ?? "main_harmony";
          const active = section.activeTracks
            ? section.activeTracks.includes(track.id) || section.activeTracks.includes(track.name)
            : action !== "none";
          if (!active || action === "none") return;
          const directive = section.trackDirectives?.[track.id] ??
            section.trackDirectives?.[track.name];
          const reasoning = input.plan.compositionIntelligence?.version === "2.0"
            ? input.plan.compositionIntelligence : undefined;
          const hierarchySection = input.plan.hierarchy?.sections[sectionIndex];
          const roleDecision = reasoning?.instrumentRoles.find((role) => role.trackId === track.id);
          const sectionArc = hierarchySection
            ? reasoning?.tensionRelease.find((arc) => arc.sectionId === hierarchySection.id)
            : undefined;
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
          const rhythmic = clamp((directive?.rhythmicActivity ?? section.density) +
            (reasoning ? (sectionArc?.tension ?? 0) * .12 : 0));
          const musicalFunction = directive?.musicalFunction;
          const step = identity.includes("drum") || identity.includes("rhythm")
            ? beat * (rhythmic > .7 ? .5 : 1)
            : musicalFunction === "pulse" || musicalFunction === "groove" ? beat
            : musicalFunction === "accent" || musicalFunction === "transition" ? beat * 4
            : musicalFunction === "pad" || musicalFunction === "texture" ? beat * 4
            : beat * (directive?.harmonicActivity && directive.harmonicActivity > .65 ? 1 : 2);
          for (let time = sectionStart; time < sectionEnd; time += step) {
            const phraseDecision = compositionPhraseAtTime(
              input.plan, input.songModel, sectionIndex, time, barSeconds,
            );
            const orchestrationAssignment = orchestrationAssignmentAtTime(
              input.plan, input.songModel, sectionIndex, track.id, time, barSeconds,
            );
            if (reasoning?.orchestrationAssignments?.length && !orchestrationAssignment) continue;
            const eventFunction = orchestrationAssignment?.role ?? musicalFunction;
            const motifOffset = phraseDecision
              ? (hashSeed(`${phraseDecision.motifRef}:${eventFunction ?? roleDecision?.function ?? "harmony"}`) % 3) - 1
              : 0;
            const beatIndex = Math.round((time - sectionStart) / beat);
            const chord = input.harmony.find((candidate) =>
              candidate.start <= time + .001 && candidate.end > time + .001)
              ?? input.harmony.find((candidate) => candidate.start < sectionEnd && candidate.end > sectionStart);
            const chordTone = chord?.tones[(beatIndex + sectionIndex) % (chord?.tones.length || 1)] ?? 60;
            let pitch = identity.includes("bass")
              ? chordTone - 24
              : identity.includes("drum") || identity.includes("rhythm")
                ? eventFunction === "groove"
                  ? [36, 46, 38, 42][beatIndex % 4]
                  : eventFunction === "transition"
                    ? [41, 43, 45, 47][beatIndex % 4]
                    : eventFunction === "accent"
                      ? [49, 42, 49, 42][beatIndex % 4]
                      : [36, 42, 38, 42][beatIndex % 4]
                : chordTone + (directive?.register === "high" || identity.includes("string") || identity.includes("brass") ? 12 : 0);
            if (reasoning && !identity.includes("drum") && !identity.includes("rhythm")) {
              pitch += motifOffset * (eventFunction === "countermelody" ||
                roleDecision?.function === "counterline" ? 2 : 1);
              if (phraseDecision?.intent === "answer" && beatIndex % 2 === 1) pitch -= 2;
            }
            const targetRegisterName = orchestrationAssignment?.register ?? directive?.register;
            const targetRegister = targetRegisterName
              ? definition.registers.find((register) => register.name === targetRegisterName)
              : undefined;
            const preferred = targetRegister ?? definition.comfortableRange;
            while (pitch < preferred.min) pitch += 12;
            while (pitch > preferred.max) pitch -= 12;
            pitch = Math.max(preferred.min, Math.min(preferred.max, pitch));
            pitch = Math.max(definition.playableRange.min, Math.min(definition.playableRange.max, pitch));
            const isEntry = Math.abs(time - sectionStart) < .001;
            const isExit = time + step >= sectionEnd;
            const duration = round(Math.min(
              step * (musicalFunction === "pad" || musicalFunction === "texture" ||
                identity.includes("pad") ? 1.8 : isExit ? .65 : .9),
              sectionEnd - time,
            ));
            const hierarchyIntent = hierarchyEventIntent(
              input.plan, sectionIndex, track.id, track.name, time, input.songModel, barSeconds,
            );
            // Do not replace a measured vocal rest with a guessed one. The
            // observed silent map is intentionally permissive; only measured
            // voiced occupancy removes a phrase/fill event.
            if (hierarchyIntent !== "support_vocal" ||
              !intersectsObservedVoice(time, time + duration, input.spaceMap)) {
              notes.push({
                id: `${track.id}-${sectionIndex}-${beatIndex}`,
                start: round(time),
                duration,
                pitch: midi(pitch),
                velocity: midi(42 + (directive?.dynamicTarget ?? section.energy) * 66 +
                  (reasoning ? (sectionArc?.tension ?? 0) * 10 - (sectionArc?.release ?? 0) * 8 +
                    (phraseDecision?.tension ?? 0) * 4 : 0) +
                  (isEntry ? 6 : 0) + (directive?.transition === "build" ? beatIndex * .5 : 0) +
                  (beatIndex % 4 === 0 ? 8 : 0)),
                voice: eventFunction ?? (identity.includes("bass") ? "foundation" :
                  identity.includes("drum") ? "pulse" : "harmonic_support"),
              });
            }
            if (directive?.fill && (identity.includes("drum") || identity.includes("rhythm")) && isExit &&
              (hierarchyIntent === undefined || hierarchyIntent === "use_vocal_space" || hierarchyIntent === "follow_section") &&
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
        version: input.plan.compositionIntelligence?.version === "2.0" ? 2 : 1,
        provenance: provenance(
          "COMPOSITION_ENGINE",
          input.plan.compositionIntelligence?.version === "2.0" ? "2.0.0" : "1.0.0",
          {
            bpm,
            compositionVersion: input.plan.compositionIntelligence?.version ?? "1.0",
            compositionEvidenceSha256: input.plan.compositionIntelligence?.evidenceSha256 ?? "legacy",
          },
        ),
      };
    });
    return synchronizeMotifLineage(
      materializeExplicitDoublings(composed, input.plan, input.songModel, barSeconds),
      input.plan.compositionIntelligence,
    );
  }
  private composeWithStyleGrammar(input: {
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
          const bounds = arrangementSectionSeconds(input.songModel, section, barSeconds);
          const sectionStart = bounds.start;
          const sectionEnd = bounds.end;
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
          const bounds = arrangementSectionSeconds(input.songModel, section, barSeconds);
          const sectionStart = bounds.start;
          const sectionEnd = bounds.end;
          const action = section.tracks[track.id] ?? section.tracks[track.name] ?? "main_harmony";
          const active = section.activeTracks
            ? section.activeTracks.includes(track.id) || section.activeTracks.includes(track.name)
            : action !== "none";
          if (!active || action === "none") return;
          const directive = section.trackDirectives?.[track.id] ??
            section.trackDirectives?.[track.name];
          const reasoning = input.plan.compositionIntelligence?.version === "2.0"
            ? input.plan.compositionIntelligence : undefined;
          const hierarchySection = input.plan.hierarchy?.sections[sectionIndex];
          const roleDecision = reasoning?.instrumentRoles.find((role) => role.trackId === track.id);
          const sectionArc = hierarchySection
            ? reasoning?.tensionRelease.find((arc) => arc.sectionId === hierarchySection.id)
            : undefined;
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
          const rhythmic = clamp((directive?.rhythmicActivity ?? section.density) +
            (reasoning ? (sectionArc?.tension ?? 0) * .12 : 0));
          const groove = section.operations.find((operation) =>
            operation.startsWith("groove:"))?.slice("groove:".length);
          const instrumentation = section.operations.find((operation) =>
            operation.startsWith("instrumentation:"))?.slice("instrumentation:".length);
          const fillMode = section.operations.find((operation) =>
            operation.startsWith("fills:"))?.slice("fills:".length);
          const step = identity.includes("drum") || identity.includes("rhythm")
            ? beat * (groove === "four_on_floor" ? 1 :
              groove === "syncopated" || rhythmic > .7 ? .5 : 1)
            : beat * (directive?.harmonicActivity && directive.harmonicActivity > .65 ? 1 : 2);
          for (let time = sectionStart; time < sectionEnd; time += step) {
            const phraseDecision = compositionPhraseAtTime(
              input.plan, input.songModel, sectionIndex, time, barSeconds,
            );
            const motifOffset = phraseDecision
              ? (hashSeed(`${phraseDecision.motifRef}:${roleDecision?.function ?? "harmony"}`) % 3) - 1
              : 0;
            const beatIndex = Math.round((time - sectionStart) / beat);
            const chord = input.harmony.find((candidate) =>
              candidate.start <= time + .001 && candidate.end > time + .001)
              ?? input.harmony.find((candidate) => candidate.start < sectionEnd && candidate.end > sectionStart);
            const chordTone = chord?.tones[(beatIndex + sectionIndex) % (chord?.tones.length || 1)] ?? 60;
            let pitch = identity.includes("bass")
              ? chordTone - 24
              : identity.includes("drum") || identity.includes("rhythm")
                ? fillMode !== undefined &&
                  (directive?.fill || fillMode === "frequent") &&
                  beatIndex % 4 === 3
                  ? 45
                  : [36, 42, 38, 42][beatIndex % 4]
                : chordTone + (directive?.register === "high" || identity.includes("string") || identity.includes("brass") ? 12 : 0);
            if (instrumentation === "electronic" && identity.includes("synth")) pitch += 12;
            if (instrumentation === "acoustic" && /piano|guitar|keys/.test(identity)) pitch -= 12;
            if (instrumentation === "orchestral" && /string|brass/.test(identity)) pitch += 12;
            if (reasoning && !identity.includes("drum") && !identity.includes("rhythm")) {
              pitch += motifOffset * (roleDecision?.function === "counterline" ? 2 : 1);
              if (phraseDecision?.intent === "answer" && beatIndex % 2 === 1) pitch -= 2;
              if (section.operations.includes("develop_motif")) {
                pitch += (sectionIndex + beatIndex) % 3;
              }
              if (section.operations.includes("transform_motif")) {
                pitch += beatIndex % 3 - 1;
              }
              if (section.operations.includes("motivic_phrase")) {
                pitch += motifOffset;
              }
              if (section.operations.includes("preserve_motif")) {
                pitch -= motifOffset;
              }
              if (section.operations.includes("repeat_motif")) {
                pitch -= sectionIndex % 2;
              }
            }
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
              step * (identity.includes("pad") ? 1.8 :
                section.operations.includes("continuous_phrase") ? .98 :
                isExit ? .65 : .9),
              sectionEnd - time,
            ));
            const hierarchyIntent = hierarchyEventIntent(
              input.plan, sectionIndex, track.id, track.name, time, input.songModel, barSeconds,
            );
            const callResponseRest = section.operations.includes("call_response") &&
              /counter|string|brass/.test(identity) &&
              Math.floor(beatIndex / 2) % 2 === 0;
            const sparseAnswerRest = section.operations.includes("sparse_answers") &&
              /counter|string|brass/.test(identity) &&
              beatIndex % 4 !== 3;
            const grooveOffset = groove === "swung" && beatIndex % 2 === 1
              ? beat / 6
              : groove === "syncopated" && beatIndex % 2 === 1
                ? beat / 8
                : 0;
            // Do not replace a measured vocal rest with a guessed one. The
            // observed silent map is intentionally permissive; only measured
            // voiced occupancy removes a phrase/fill event.
            if (!callResponseRest && !sparseAnswerRest &&
              (hierarchyIntent !== "support_vocal" ||
              !intersectsObservedVoice(time, time + duration, input.spaceMap))) {
              notes.push({
                id: `${track.id}-${sectionIndex}-${beatIndex}`,
                start: round(Math.min(sectionEnd - definition.constraints.minNoteDuration,
                  time + grooveOffset)),
                duration,
                pitch: midi(pitch),
                velocity: midi(42 + (directive?.dynamicTarget ?? section.energy) * 66 +
                  (reasoning ? (sectionArc?.tension ?? 0) * 10 - (sectionArc?.release ?? 0) * 8 +
                    (phraseDecision?.tension ?? 0) * 4 : 0) +
                  (isEntry ? 6 : 0) +
                  (["build", "swell", "riser"].includes(directive?.transition ?? "")
                    ? beatIndex * .5 : 0) +
                  (directive?.transition === "cut" && isExit ? -12 : 0) +
                  (section.operations.includes("dynamic_arc")
                    ? Math.sin((time - sectionStart) / Math.max(.001, sectionEnd - sectionStart) * Math.PI) * 10
                    : 0) +
                  (section.operations.includes("additive_layers") ? sectionIndex * 2 : 0) +
                  (beatIndex % 4 === 0 ? 8 : 0)),
                voice: identity.includes("bass") ? "bass" : identity.includes("drum") ? "percussion" : "harmony",
              });
            }
            if (directive?.fill && (identity.includes("drum") || identity.includes("rhythm")) && isExit &&
              (hierarchyIntent === undefined || hierarchyIntent === "use_vocal_space" || hierarchyIntent === "follow_section") &&
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
        version: input.plan.compositionIntelligence?.version === "2.0" ? 2 : 1,
        provenance: provenance(
          "COMPOSITION_ENGINE",
          input.plan.compositionIntelligence?.version === "2.0" ? "2.0.0" : "1.0.0",
          {
            bpm,
            compositionVersion: input.plan.compositionIntelligence?.version ?? "1.0",
            compositionEvidenceSha256: input.plan.compositionIntelligence?.evidenceSha256 ?? "legacy",
          },
        ),
      };
    });
  }

  compose(input: {
    songModel: SongModelData;
    plan: ArrangementPlan;
    tracks: Array<{ id: string; name: string; role: string; instrument?: string }>;
    harmony: ReturnType<HarmonyEngine["generate"]>;
    spaceMap?: ArrangementSpaceMap;
  }): Array<TrackModel> {
    const styled = this.composeWithStyleGrammar(input);
    const coordinated = this.composeWithCoordinatedGroove(input);
    const bpm = Math.max(40, input.songModel.tempoMap[0]?.bpm || 92);
    const fallbackBarSeconds = secondsPerBar(bpm, input.songModel.meterMap[0]?.meter);
    const grooveTrackIds = new Set(
      input.plan.compositionIntelligence?.groove?.roles.map((role) => role.trackId) ?? [],
    );
    if (!grooveTrackIds.size) return styled;
    const hasGrammar = input.plan.sections.some((section) =>
      section.operations.some((operation) =>
        operation.startsWith("groove:") ||
        operation.startsWith("instrumentation:") ||
        operation.startsWith("fills:")));
    if (!hasGrammar) return coordinated;
    return coordinated.map((track) => {
      const sourceTrack = input.tracks.find((candidate) => candidate.id === track.id);
      const evidenceBackedVocal = input.songModel.melody.length > 0 &&
        /vocal|voice|melody/.test(`${sourceTrack?.name ?? ""} ${sourceTrack?.role ?? ""}`.toLowerCase());
      if (evidenceBackedVocal) return track;
      return {
        ...track,
        notes: track.notes.map((note, index, notes) => {
          const sectionIndex = input.plan.sections.findIndex((candidate) => {
            const bounds = arrangementSectionSeconds(input.songModel, candidate, fallbackBarSeconds);
            return note.start >= bounds.start && note.start < bounds.end;
          });
          const section = input.plan.sections[Math.max(0, sectionIndex)];
          const bounds = arrangementSectionSeconds(input.songModel, section, fallbackBarSeconds);
          const directive = section.trackDirectives?.[track.id] ??
            section.trackDirectives?.[input.tracks.find((item) => item.id === track.id)?.name ?? ""];
          const operationValue = (prefix: string) => section.operations
            .find((operation) => operation.startsWith(prefix))
            ?.slice(prefix.length);
          const grooveMode = operationValue("groove:");
          const instrumentation = operationValue("instrumentation:");
          const fillMode = operationValue("fills:");
          const isPercussion = note.voice === "percussion";
          const sectionProgress = clamp(
            (note.start - bounds.start) / Math.max(.001, bounds.end - bounds.start),
          );
          const nextStart = notes[index + 1]?.start ?? bounds.end;
          const phraseScale = section.operations.includes("continuous_phrase") ? 1.35 :
            section.operations.includes("sparse_answers") ? .65 :
            section.operations.includes("call_response") ? .8 : 1;
          const developmentShift = section.operations.includes("transform_motif") ||
            section.operations.includes("develop_motif")
            ? index % 2 === 0 ? 0 : 2
            : section.operations.includes("additive_layers") ? Math.min(4, sectionIndex) :
            section.operations.includes("repeat_motif") ? 0 : 0;
          const instrumentationShift = instrumentation === "electronic"
            ? isPercussion ? 1 : 12
            : instrumentation === "orchestral" && !isPercussion ? 12 : 0;
          const fillPitch = fillMode === "frequent" && isPercussion &&
            (notes[index + 1]?.start ?? bounds.end) >= bounds.end
            ? 45
            : note.pitch;
          const grooveVelocity = grooveMode === "swung" ? (index % 2 ? -7 : 4) :
            grooveMode === "syncopated" ? (index % 4 === 2 ? 8 : -2) :
            grooveMode === "laid_back" ? -5 :
            grooveMode === "driving" ? 6 : 0;
          const responseVelocity = isPercussion ? 0 :
            ((directive?.harmonicActivity ?? .5) - .5) * 18;
          const instrumentationVelocity = instrumentation === "electronic" ? 4 :
            instrumentation === "acoustic" ? -3 :
            instrumentation === "orchestral" ? 2 : 0;
          const fillVelocity = fillMode === "frequent" && isPercussion ? 3 : 0;
          const transitionVelocity = ["build", "swell", "riser"].includes(directive?.transition ?? "")
            ? sectionProgress * 10
            : directive?.transition === "cut" ? -sectionProgress * 8 : 0;
          const developmentVelocity = section.operations.includes("transform_motif") ||
            section.operations.includes("develop_motif")
            ? index % 2 === 0 ? -4 : 6
            : section.operations.includes("additive_layers") ? sectionIndex * 2 :
            section.operations.includes("dynamic_arc") ? Math.sin(sectionProgress * Math.PI) * 8 :
            0;
          return {
            ...note,
            duration: round(Math.max(
              track.instrumentDefinition.constraints.minNoteDuration,
              Math.min(note.duration * phraseScale, Math.max(
                track.instrumentDefinition.constraints.minNoteDuration,
                nextStart - note.start,
              )),
            )),
            pitch: midi(fillPitch + instrumentationShift + developmentShift),
            velocity: midi(note.velocity + grooveVelocity + instrumentationVelocity +
              fillVelocity + responseVelocity + transitionVelocity + developmentVelocity),
          };
        }),
      };
    });
  }
}

type HarmonySpan = ReturnType<HarmonyEngine["generate"]>[number];
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

/**
 * Applies v2 reasoning to externally composed canonical events. Provider audio
 * has no TrackModels and remains outside this symbolic boundary.
 */
export function applyCompositionIntelligence(
  trackModels: TrackModel[],
  plan: ArrangementPlan,
  songModel: SongModelData,
): TrackModel[] {
  const reasoning = plan.compositionIntelligence;
  if (reasoning?.version !== "2.0") return trackModels;
  if (reasoning.evidenceSha256 !== compositionEvidenceSha256(songModel, plan.songModelVersion)) {
    throw new Error("Composition Intelligence v2 evidence does not match the canonical plan");
  }
  const bpm = songModel.tempoMap[0]?.bpm ?? 92;
  const fallbackBarSeconds = secondsPerBar(bpm, songModel.meterMap[0]?.meter);
  const transformedTracks = trackModels.map((track) => {
    const role = reasoning.instrumentRoles.find((candidate) => candidate.trackId === track.id);
    const notes = track.notes.flatMap((note, noteIndex) => {
      const sectionIndex = plan.sections.findIndex((section) => {
        const bounds = arrangementSectionSeconds(songModel, section, fallbackBarSeconds);
        return note.start >= bounds.start && note.start < bounds.end;
      });
      const hierarchySection = plan.hierarchy.sections[sectionIndex];
      const phrase = compositionPhraseAtTime(
        plan, songModel, sectionIndex, note.start, fallbackBarSeconds,
      );
      const arc = hierarchySection
        ? reasoning.tensionRelease.find((candidate) => candidate.sectionId === hierarchySection.id)
        : undefined;
      if (!phrase) return [note];
      const assignment = orchestrationAssignmentAtTime(
        plan, songModel, sectionIndex, track.id, note.start, fallbackBarSeconds,
      );
      if (reasoning.orchestrationAssignments?.length && !assignment) return [];
      const eventFunction = assignment?.role ?? role?.function ?? "harmony";
      const motif = reasoning.motifs?.find((candidate) => candidate.id === phrase.motifRef);
      const foreground = role?.function === "lead" || role?.function === "counterline";
      if (phrase.intention === "silence" && foreground) return [];
      if (phrase.intention === "response" && phrase.ownerTrackId !== track.id) return [];
      if (phrase.intention === "foreground" && foreground &&
        phrase.ownerTrackId && phrase.ownerTrackId !== track.id) return [];
      if (track.instrumentDefinition.family === "drums" &&
        (eventFunction === "pulse" && noteIndex % 2 === 1 ||
          eventFunction === "groove" && noteIndex % 2 === 0)) return [];
      const motifOffset = (hashSeed(`${phrase.motifRef}:${eventFunction}`) % 3) - 1;
      const pitched = track.instrumentDefinition.family === "drums"
        ? note.pitch
        : note.pitch + motifOffset * (eventFunction === "countermelody" ||
          role?.function === "counterline" ? 2 : 1);
      const register = assignment
        ? track.instrumentDefinition.registers.find((candidate) =>
          candidate.name === assignment.register)
        : undefined;
      let boundedPitch = pitched;
      if (register && track.instrumentDefinition.family !== "drums") {
        while (boundedPitch < register.min) boundedPitch += 12;
        while (boundedPitch > register.max) boundedPitch -= 12;
      }
      return [{
        ...note,
        pitch: midi(Math.max(
          track.instrumentDefinition.playableRange.min,
          Math.min(track.instrumentDefinition.playableRange.max, boundedPitch),
        )),
        velocity: midi(note.velocity + (arc?.tension ?? 0) * 10 -
          (arc?.release ?? 0) * 8 + phrase.tension * 4),
        voice: assignment?.role ?? note.voice,
        motif: motif ? {
          id: motif.id,
          fingerprint: motif.fingerprint,
          parentMotifId: motif.parentMotifId,
          transformation: phrase.transformation,
          phraseId: phrase.id,
          intention: phrase.intention,
          evidenceSha256: motif.evidenceSha256,
          windowEndSeconds: phrase.intention === "response" ? phrase.endSeconds : undefined,
        } : note.motif,
      }];
    });
    const transformed: TrackModel = {
      ...track,
      notes,
      source: "COMPOSITION_INTELLIGENCE",
      version: track.version + 1,
      provenance: provenance("COMPOSITION_INTELLIGENCE", "2.0.0", {
        seed: reasoning.seed,
        compositionVersion: reasoning.version,
        compositionEvidenceSha256: reasoning.evidenceSha256,
      }, [track.provenance.model]),
    };
    const capability = getInstrumentPerformanceCapability(track.instrumentDefinition);
    const violations = transformed.notes.flatMap((note) => {
      const invalid = note.pitch < track.instrumentDefinition.playableRange.min ||
        note.pitch > track.instrumentDefinition.playableRange.max ||
        note.duration < track.instrumentDefinition.constraints.minNoteDuration;
      return invalid ? [note.id] : [];
    });
    transformed.performanceEvidence = {
      version: "1.0",
      seed: reasoning.seed,
      compositionSeed: reasoning.seed,
      performanceSeed: reasoning.seed,
      instrumentFamily: track.instrumentDefinition.family,
      articulationProfile: capability.articulationProfile,
      timingProfile: capability.timingProfile,
      dynamicsProfile: capability.dynamicsProfile,
      canonicalTimelineSha256: canonicalPerformanceTimelineSha256(songModel),
      phraseIds: canonicalPerformancePhraseIds(songModel),
      sectionRanges: (track.appliedDirectives ?? []).map((item) => ({
        section: item.section,
        startBar: item.startBar,
        endBar: item.endBar,
        start: item.start,
        end: item.end,
      })),
      playability: {
        valid: violations.length === 0,
        checkedNotes: transformed.notes.length,
        violations,
      },
      performedMaterialSha256: performedMaterialSha256(transformed),
    };
    return transformed;
  });
  return synchronizeMotifLineage(
    materializeExplicitDoublings(transformedTracks, plan, songModel, fallbackBarSeconds),
    reasoning,
  );
}

export class VoiceLeadingEngine {
  apply(trackModels: TrackModel[]): TrackModel[] {
    return trackModels.map((track) => {
      if (track.harmonyEvidence?.mode === "advanced_voicing") return track;
      if (track.harmonyEvidence?.mode === "phrase_countermelody") return track;
      if (track.notes.some((note) => note.id.includes(":observed-bass:"))) return track;
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
    context?: {
      canonicalTimelineSha256: string;
      phraseIds: string[];
      compositionVersion: CompositionIntelligenceVersion;
      compositionEvidenceSha256: string;
      compositionSeed: number;
    },
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
      const appliedRange = track.appliedDirectives?.find(
        (item) => item.start <= note.start && item.end > note.start,
      );
      const appliedDirective = appliedRange?.directive ?? track.directive;
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
        start: Math.max(
          appliedRange?.start ?? 0,
          note.motif?.intention === "response" ? note.start : 0,
          round(note.start + offset),
        ),
        duration: round(note.duration + (articulation === "legato" ? profile.legatoOverlap : 0)),
        velocity,
      };
      if (appliedRange) {
        performed.duration = round(Math.max(
          track.instrumentDefinition.constraints.minNoteDuration,
          Math.min(performed.duration, appliedRange.end - performed.start),
        ));
      }
      if (note.motif?.windowEndSeconds !== undefined) {
        performed.duration = round(Math.min(
          performed.duration,
          note.motif.windowEndSeconds - performed.start,
        ));
        if (performed.duration < track.instrumentDefinition.constraints.minNoteDuration) return;
      }
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
    const performedTrack: TrackModel = {
      ...track,
      notes,
      cc,
      articulations,
      automation,
      source: "PERFORMANCE_ENGINE",
      version: track.version + 1,
      provenance: provenance("PERFORMANCE_ENGINE", context?.compositionVersion === "2.0" ? "2.0.0" : "1.0.0", {
        seed,
        compositionSeed: context?.compositionSeed ?? seed,
        performanceSeed: seed,
        timing: profile.timing,
        humanized: true,
        compositionVersion: context?.compositionVersion ?? "1.0",
        compositionEvidenceSha256: context?.compositionEvidenceSha256 ?? "legacy",
      }, [track.provenance.model]),
    };
    const capability = getInstrumentPerformanceCapability(track.instrumentDefinition);
    const violations = performedTrack.notes.flatMap((note) => {
      const errors: string[] = [];
      if (note.pitch < track.instrumentDefinition.playableRange.min ||
        note.pitch > track.instrumentDefinition.playableRange.max) {
        errors.push(`${note.id}:pitch`);
      }
      if (note.duration < track.instrumentDefinition.constraints.minNoteDuration) {
        errors.push(`${note.id}:duration`);
      }
      return errors;
    });
    return {
      ...performedTrack,
      performanceEvidence: {
        version: "1.0",
        seed,
        compositionSeed: context?.compositionSeed ?? seed,
        performanceSeed: seed,
        instrumentFamily: track.instrumentDefinition.family,
        articulationProfile: capability.articulationProfile,
        timingProfile: capability.timingProfile,
        dynamicsProfile: capability.dynamicsProfile,
        canonicalTimelineSha256: context?.canonicalTimelineSha256 ??
          createHash("sha256").update("legacy-timeline").digest("hex"),
        phraseIds: context?.phraseIds ?? [],
        sectionRanges: (track.appliedDirectives ?? []).map((item) => ({
          section: item.section,
          startBar: item.startBar,
          endBar: item.endBar,
          start: item.start,
          end: item.end,
        })),
        playability: {
          valid: violations.length === 0,
          checkedNotes: performedTrack.notes.length,
          violations,
        },
        performedMaterialSha256: performedMaterialSha256(performedTrack),
      },
    };
  }
}

export class SoundLibraryRegistry {
  resolve(instrument: InstrumentDefinition): { library: string; vendor: string; patch: string; renderProvider: "LOCAL_EXPRESSIVE_SYNTH"; articulation: string[] } {
    return {
      library: "Local Expressive Preview (non-production)",
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
    contractVersion?: string;
    healthy?: boolean;
    provider?: string;
    modelVersion?: string;
    runtimeIdentity?: string;
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
    health.contractVersion !== "1.0" ||
    health.runtimeReady !== true ||
    health.smokeTested !== true ||
    health.provider !== input.provider ||
    !health.modelVersion ||
    !health.runtimeIdentity ||
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
      contractVersion: "1.0",
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
    contractVersion?: string;
    provider?: string;
    trackModelId?: string;
    trackModelSha256?: string;
    outputSha256?: string;
    performedMaterialSha256?: string;
    sampleRate?: number;
    frameCount?: number;
    durationSeconds?: number;
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
    payload.contractVersion !== "1.0" ||
    payload.trackModelId !== input.track.id ||
    payload.trackModelSha256 !== trackModelSha256 ||
    payload.performedMaterialSha256 !== performedMaterialSha256(input.track) ||
    payload.sampleRate !== input.sampleRate ||
    payload.frameCount !== Math.ceil(input.sampleRate * input.durationSeconds) ||
    payload.durationSeconds !== input.durationSeconds ||
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
  const samples = decodePcm16Wav(audio, input.sampleRate);
  if (samples.length / 2 !== payload.frameCount) {
    throw new Error(`${input.provider} renderer frame count did not match returned audio`);
  }
  return {
    samples,
    attestation: {
      contractVersion: "1.0",
      provider: input.provider,
      modelVersion: health.modelVersion,
      runtimeIdentity: health.runtimeIdentity,
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
      performedMaterialSha256: payload.performedMaterialSha256,
      sampleRate: input.sampleRate,
      frameCount: payload.frameCount,
      durationSeconds: input.durationSeconds,
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

function preserveMotifsAfterAdvancedHarmony(
  harmonized: TrackModel[],
  composed: TrackModel[],
  plan: ArrangementPlan,
  songModel: SongModelData,
  fallbackBarSeconds: number,
): TrackModel[] {
  const reasoning = plan.compositionIntelligence;
  if (reasoning?.version !== "2.0") return harmonized;
  return harmonized.map((track) => {
    const role = reasoning.instrumentRoles.find((candidate) => candidate.trackId === track.id);
    const notes = track.notes.flatMap((note, index) => {
      if (note.motif) return [note];
      const sectionIndex = plan.sections.findIndex((section) => {
        const bounds = arrangementSectionSeconds(songModel, section, fallbackBarSeconds);
        return note.start >= bounds.start && note.start < bounds.end;
      });
      const phrase = compositionPhraseAtTime(
        plan, songModel, sectionIndex, note.start, fallbackBarSeconds,
      );
      const motif = phrase
        ? reasoning.motifs?.find((candidate) => candidate.id === phrase.motifRef)
        : undefined;
      if (!phrase || !motif) return [note];
      const foreground = role?.function === "lead" || role?.function === "counterline";
      if (phrase.intention === "silence" && foreground) return [];
      if (phrase.intention === "response" && phrase.ownerTrackId !== track.id) return [];
      let pitch = note.pitch;
      if (track.instrumentDefinition.family !== "drums") {
        if (phrase.transformation === "register_displacement") pitch += 12;
        if (phrase.transformation === "answering_gesture" && index % 2 === 1) pitch -= 3;
        while (pitch > track.instrumentDefinition.playableRange.max) pitch -= 12;
        while (pitch < track.instrumentDefinition.playableRange.min) pitch += 12;
      }
      return [{
        ...note,
        pitch: midi(pitch),
        motif: {
          id: motif.id,
          fingerprint: motif.fingerprint,
          parentMotifId: motif.parentMotifId,
          transformation: phrase.transformation,
          phraseId: phrase.id,
          intention: phrase.intention,
          evidenceSha256: motif.evidenceSha256,
          windowEndSeconds: phrase.intention === "response" ? phrase.endSeconds : undefined,
        },
      }];
    });
    const composedResponses = composed.find((candidate) => candidate.id === track.id)?.notes
      .filter((note) => note.motif?.intention === "response") ?? [];
    for (const response of composedResponses) {
      if (!notes.some((note) => note.motif?.phraseId === response.motif?.phraseId)) {
        notes.push(response);
      }
    }
    return { ...track, notes };
  });
}

export function buildTrackModels(input: {
  songModel: SongModelData;
  plan: ArrangementPlan;
  tracks: Array<{ id: string; name: string; role: string; instrument?: string }>;
  style: StyleSpec;
  seed?: number;
}): TrackModel[] {
  if (input.plan.compositionIntelligence?.version === "2.0" &&
    (input.seed ?? 0) !== input.plan.compositionIntelligence.seed) {
    throw new Error("Composition Intelligence v2 seed does not match the canonical plan");
  }
  if (input.plan.compositionIntelligence?.version === "2.0" &&
    input.plan.compositionIntelligence.evidenceSha256 !==
      compositionEvidenceSha256(input.songModel, input.plan.songModelVersion)) {
    throw new Error("Composition Intelligence v2 evidence does not match the canonical plan");
  }
  const groove = input.plan.compositionIntelligence?.groove;
  if (groove && (groove.seed !== input.plan.compositionIntelligence!.seed ||
    groove.evidenceSha256 !== input.plan.compositionIntelligence!.evidenceSha256)) {
    throw new Error("Shared groove identity does not match Composition Intelligence v2");
  }
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
  const harmonized = applyAdvancedHarmony({
    tracks: composed,
    songModel: input.songModel,
    plan: input.plan,
    harmony,
    spaceMap,
  });
  const motifPreserved = preserveMotifsAfterAdvancedHarmony(
    harmonized,
    composed,
    input.plan,
    input.songModel,
    secondsPerBar(bpm, input.songModel.meterMap[0]?.meter),
  );
  const modulated = applyPlanModulations(
    motifPreserved,
    input.plan,
    bpm,
    input.songModel.meterMap[0]?.meter,
  );
  const voiced = new VoiceLeadingEngine().apply(modulated);
  // Version is part of the identity: regenerating a saved Song Model produces
  // byte-stable expressive events, while a corrected model intentionally does not.
  const legacySeedIdentity = `${input.plan.id}:song-model:${input.plan.songModelVersion}:${input.seed ?? 0}`;
  const hasGenerationVocabulary = Boolean(input.style.grammar || input.plan.generationPreference);
  const grammarIdentity = `${input.style.grammar?.version}:${input.style.grammar?.evidenceSha256}`;
  const preferenceIdentity = `${input.plan.generationPreference?.calibrationVersion}:${input.plan.generationPreference?.evidenceSha256}`;
  const deterministicSeed = hashSeed(input.plan.compositionIntelligence?.version === "2.0"
    ? `${legacySeedIdentity}:composition:2.0:${input.plan.compositionIntelligence.evidenceSha256}${
        hasGenerationVocabulary
          ? `:grammar:${grammarIdentity}:preference:${preferenceIdentity}`
          : ""
      }`
    : legacySeedIdentity);
  const canonicalTimelineSha256 = canonicalPerformanceTimelineSha256(input.songModel);
  const phraseIds = canonicalPerformancePhraseIds(input.songModel);
  const performed = voiced.map((track) =>
    new PerformanceEngine().perform(
      track,
      input.style,
      deterministicSeed,
      hierarchySpaceMapForTrack(input.songModel, input.plan, track.id, spaceMap, secondsPerBar(
        bpm,
        input.songModel.meterMap[0]?.meter,
      )),
      {
        canonicalTimelineSha256,
        phraseIds,
        compositionVersion: input.plan.compositionIntelligence?.version ?? "1.0",
        compositionEvidenceSha256: input.plan.compositionIntelligence?.version === "2.0"
          ? input.plan.compositionIntelligence.evidenceSha256
          : "legacy",
        compositionSeed: input.plan.compositionIntelligence?.seed ?? (input.seed ?? 0),
      },
    ));
  const orchestrated = materializeExplicitDoublings(
    performed,
    input.plan,
    input.songModel,
    secondsPerBar(bpm, input.songModel.meterMap[0]?.meter),
  );
  const finalized = orchestrated.map((track) => {
    const refreshed = refreshFinalHarmonyEvidence(track, input.songModel, input.plan);
    return {
      ...refreshed,
      notes: [...refreshed.notes].sort((left, right) =>
        left.start - right.start || left.pitch - right.pitch || left.id.localeCompare(right.id)),
    };
  });
  return synchronizeMotifLineage(finalized, input.plan.compositionIntelligence).map((track) =>
    track.performanceEvidence
      ? {
          ...track,
          performanceEvidence: {
            ...track.performanceEvidence,
            performedMaterialSha256: performedMaterialSha256(track),
          },
        }
      : track);
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
    const editedTrack: TrackModel = {
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
    return {
      ...editedTrack,
      performanceEvidence: trackModel.performanceEvidence
        ? {
            ...trackModel.performanceEvidence,
            playability: {
              valid: true,
              checkedNotes: editedTrack.notes.length,
              violations: [],
            },
            performedMaterialSha256: performedMaterialSha256(editedTrack),
          }
        : undefined,
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
      rendererStatus: "preview-only" as const,
      fallbackReason: "Local expressive synthesis is preview-only and cannot support a production-ready claim.",
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

export type VoicingMetrics = {
  transitions: number;
  totalSemitoneMotion: number;
  averageSemitoneMotion: number;
  maximumVoiceLeap: number;
};

function orchestrationCandidates(
  track: { id?: string; name: string; role: string },
  sectionFunction: ArrangementBrainSection["function"],
  energy: number,
): OrchestrationRole[] {
  const identity = `${track.name} ${track.role}`.toLowerCase();
  if (/bass/.test(identity)) return ["foundation", "groove", "pulse"];
  if (/drum|rhythm|percussion/.test(identity)) return ["pulse", "groove", "transition", "accent"];
  if (/pad|ambient|texture/.test(identity)) return ["pad", "texture", "lift", "harmonic_support"];
  if (/vocal|voice|lead|melody/.test(identity)) return ["hook", "response", "countermelody"];
  if (/brass|horn/.test(identity)) return energy > .65
    ? ["accent", "lift", "response", "countermelody"]
    : ["texture", "harmonic_support", "response"];
  if (/string|violin|cello/.test(identity)) return sectionFunction === "chorus"
    ? ["lift", "countermelody", "pad", "harmonic_support"]
    : ["harmonic_support", "texture", "countermelody", "pad"];
  if (/guitar/.test(identity)) return ["groove", "harmonic_support", "response", "hook"];
  return ["harmonic_support", "groove", "hook", "response", "texture"];
}

function phraseTimeBounds(
  phrase: CompositionIntelligencePlan["phrases"][number],
  songModel: SongModelData,
  fallbackBarSeconds: number,
): { start: number; end: number } {
  const bars = songModel.bars.filter((bar) =>
    bar.bar >= phrase.startBar && bar.bar <= phrase.endBar);
  return {
    start: bars[0]?.coordinates?.start.seconds ?? bars[0]?.start ??
      (phrase.startBar - 1) * fallbackBarSeconds,
    end: bars.at(-1)?.coordinates?.end.seconds ?? bars.at(-1)?.end ??
      phrase.endBar * fallbackBarSeconds,
  };
}

function materializeExplicitDoublings(
  tracks: TrackModel[],
  plan: ArrangementPlan,
  songModel: SongModelData,
  fallbackBarSeconds: number,
): TrackModel[] {
  const assignments = plan.compositionIntelligence?.orchestrationAssignments ?? [];
  if (!assignments.some((assignment) => assignment.role === "doubling")) return tracks;
  return tracks.map((track) => {
    const doublingAssignments = assignments.filter((assignment) =>
      assignment.trackId === track.id && assignment.role === "doubling" &&
      assignment.doublingTrackId);
    if (!doublingAssignments.length) return track;
    let notes = [...track.notes];
    for (const assignment of doublingAssignments) {
      const source = tracks.find((candidate) => candidate.id === assignment.doublingTrackId);
      const phrase = plan.compositionIntelligence?.phrases.find((candidate) =>
        candidate.id === assignment.phraseId);
      if (!source || !phrase) continue;
      const bounds = phraseTimeBounds(phrase, songModel, fallbackBarSeconds);
      notes = notes.filter((note) => note.start < bounds.start || note.start >= bounds.end);
      notes.push(...source.notes.filter((note) =>
        note.start >= bounds.start && note.start < bounds.end).map((note, index) => {
        let pitch = note.pitch;
        while (pitch < track.instrumentDefinition.playableRange.min) pitch += 12;
        while (pitch > track.instrumentDefinition.playableRange.max) pitch -= 12;
        return {
          ...note,
          id: `${track.id}-doubling-${assignment.phraseId}-${index}`,
          pitch: midi(pitch),
          voice: "doubling",
        };
      }));
    }
    const doubled = {
      ...track,
      notes,
    };
    return track.performanceEvidence
      ? {
          ...doubled,
          performanceEvidence: {
            ...track.performanceEvidence,
            performedMaterialSha256: performedMaterialSha256(doubled),
          },
        }
      : doubled;
  });
}

function planSectionOrchestration(input: {
  tracks: Array<{ id?: string; name: string; role: string }>;
  sectionFunction: ArrangementBrainSection["function"];
  energy: number;
  density: number;
  orchestraSize: number;
  sectionIndex: number;
}): OrchestrationAssignment[] {
  const desired = Math.max(1, Math.min(input.tracks.length, Math.ceil(
    input.tracks.length * clamp(.22 + input.orchestraSize * .42 + input.density * .24 + input.energy * .12),
  )));
  const ranked = input.tracks.map((track, ordinal) => {
    const definition = getInstrumentDefinition(track.name, track.role);
    const candidates = orchestrationCandidates(track, input.sectionFunction, input.energy);
    const identity = `${track.name} ${track.role}`.toLowerCase();
    const priority = /\bdoubl(e|ing)\b/.test(track.role.toLowerCase()) ? 99
      : /bass/.test(identity) ? 0 : /drum|rhythm|percussion/.test(identity) ? 1
      : candidates.includes("hook") ? 2 : definition.family === "strings" ? 3 : 4;
    return { track, definition, candidates, ordinal, priority };
  }).sort((left, right) => left.priority - right.priority ||
    ((left.ordinal + input.sectionIndex) % Math.max(1, input.tracks.length)) -
      ((right.ordinal + input.sectionIndex) % Math.max(1, input.tracks.length)));
  const assignments: OrchestrationAssignment[] = [];
  const occupied = new Set<string>();
  for (const item of ranked) {
    if (assignments.length >= desired) break;
    const explicitDoubling = /\bdoubl(e|ing)\b/.test(item.track.role.toLowerCase());
    const role = explicitDoubling ? "doubling" : item.candidates.find((candidate) => {
      const register = candidate === "foundation" ? "low" : candidate === "hook" || candidate === "countermelody" ||
        candidate === "response" || candidate === "lift" || candidate === "accent" ? "high" : "middle";
      const pitchedSupport = !["foundation", "pulse", "groove", "transition", "accent"].includes(candidate);
      return !occupied.has(`${candidate}:${register}`) &&
        (!pitchedSupport || !occupied.has(`timbre:${item.definition.family}:${register}`));
    });
    if (!role) continue;
    const register: OrchestrationAssignment["register"] = role === "foundation" ? "low"
      : role === "hook" || role === "countermelody" || role === "response" ||
        role === "lift" || role === "accent" ? "high" : "middle";
    const doubled = explicitDoubling
      ? assignments.find((assignment) => assignment.register === register) ?? assignments.at(-1)
      : undefined;
    if (role === "doubling" && !doubled) continue;
    if (role !== "doubling") {
      occupied.add(`${role}:${register}`);
      if (!["foundation", "pulse", "groove", "transition", "accent"].includes(role)) {
        occupied.add(`timbre:${item.definition.family}:${register}`);
      }
    }
    assignments.push({
      trackId: item.track.id ?? item.track.name,
      role,
      register: role === "doubling" ? doubled!.register : register,
      doublingTrackId: doubled?.trackId ?? null,
    });
  }
  return assignments;
}

function scoreVoicing(
  candidate: number[],
  previous: number[],
  melody: SongModelData["melody"],
  chord: HarmonySpan,
  wide: boolean,
): number {
  const motion = previous.length === candidate.length
    ? candidate.reduce((sum, pitch, voice) =>
        sum + Math.abs(previous[voice] - pitch), 0)
    : 0;
  const spacing = candidate.slice(1).reduce(
    (sum, pitch, index) => sum + Math.abs(pitch - candidate[index] - (wide ? 7 : 4)),
    0,
  );
  const melodyCollisions = melody.filter((note) =>
    note.confidence >= .6 && note.start < chord.end && note.end > chord.start &&
    candidate.some((pitch) => Math.abs(pitch - note.pitch) <= 1)).length;
  return motion * 100 + spacing * .3 + melodyCollisions * 12;
}

function naiveRootVoicing(
  chord: HarmonySpan,
  range: { min: number; max: number },
  voiceCount: number,
): number[] {
  const pitchClasses = chord.tones.map((tone) => ((tone % 12) + 12) % 12);
  const rootPc = ((chord.root % 12) + 12) % 12;
  let root = range.min;
  while (root % 12 !== rootPc && root <= range.max) root += 1;
  const ordered = [rootPc, ...pitchClasses.filter((pc) => pc !== rootPc)];
  return ordered.slice(0, voiceCount).map((pc, index) => {
    let pitch = root + (pc - rootPc + 12) % 12;
    if (index && pitch <= root) pitch += 12;
    while (pitch > range.max) pitch -= 12;
    return pitch;
  }).sort((left, right) => left - right);
}

function refreshFinalHarmonyEvidence(
  track: TrackModel,
  songModel: SongModelData,
  plan: ArrangementPlan,
): TrackModel {
  if (!track.harmonyEvidence) return track;
  const conflictsObservedPart = (note: MusicalNote) =>
    songModel.melody.some((melody) =>
      melody.confidence >= .6 &&
      melody.start < note.start + note.duration &&
      melody.end > note.start &&
      Math.abs(melody.pitch - note.pitch) <= 1) ||
    readBassEvidence(songModel).some((bass) =>
      bass.start < note.start + note.duration &&
      bass.end > note.start &&
      note.pitch <= bass.pitch + 4);
  const finalize = (value: TrackModel): TrackModel => {
    const noteAt = (time: number) => value.notes.some((note) =>
      Math.abs(note.start - time) <= .03);
    const synchronized: TrackModel = {
      ...value,
      articulations: value.articulations.filter((event) => noteAt(event.time)),
      automation: value.automation.filter((event) =>
        !["pitch_bend", "aftertouch"].includes(event.parameter) || noteAt(event.time)),
    };
    return synchronized.performanceEvidence
      ? {
          ...synchronized,
          performanceEvidence: {
            ...synchronized.performanceEvidence,
            playability: {
              valid: synchronized.notes.every((note) =>
                note.pitch >= synchronized.instrumentDefinition.playableRange.min &&
                note.pitch <= synchronized.instrumentDefinition.playableRange.max &&
                note.duration >= synchronized.instrumentDefinition.constraints.minNoteDuration),
              checkedNotes: synchronized.notes.length,
              violations: synchronized.notes.flatMap((note) => {
                const violations: string[] = [];
                if (note.pitch < synchronized.instrumentDefinition.playableRange.min ||
                  note.pitch > synchronized.instrumentDefinition.playableRange.max) {
                  violations.push(`${note.id}:pitch`);
                }
                if (note.duration < synchronized.instrumentDefinition.constraints.minNoteDuration) {
                  violations.push(`${note.id}:duration`);
                }
                return violations;
              }),
            },
            performedMaterialSha256: performedMaterialSha256(synchronized),
          },
        }
      : synchronized;
  };
  if (track.harmonyEvidence.mode === "advanced_voicing") {
    const constrainedNotes = track.notes.filter((note) => !conflictsObservedPart(note));
    const groups = new Map<string, number[]>();
    for (const note of constrainedNotes.filter((candidate) => candidate.id.includes(":voicing:"))) {
      const key = note.id.replace(/:\d+$/, "");
      groups.set(key, [...(groups.get(key) ?? []), note.pitch]);
    }
    const allVoicings = [...groups.values()].map((pitches) =>
      pitches.sort((left, right) => left - right));
    const expectedVoices = Math.max(0, ...allVoicings.map((voicing) => voicing.length));
    const complete = expectedVoices > 0 &&
      allVoicings.every((voicing) => voicing.length === expectedVoices);
    const comparable = complete && !plan.sections.some((section) =>
      section.operations.some((operation) => operation.startsWith("modulate:")));
    const voicings = comparable ? allVoicings : [];
    const metrics = measureVoicingMotion(voicings);
    const melodyEvidencePreserved = constrainedNotes.every((note) =>
      !songModel.melody.some((melody) =>
        melody.confidence >= .6 &&
        melody.start < note.start + note.duration &&
        melody.end > note.start &&
        Math.abs(melody.pitch - note.pitch) <= 1));
    const bassEvidencePreserved = constrainedNotes.every((note) =>
      !readBassEvidence(songModel).some((bass) =>
        bass.start < note.start + note.duration &&
        bass.end > note.start &&
        note.pitch <= bass.pitch + 4));
    return finalize({
      ...track,
      notes: constrainedNotes,
      harmonyEvidence: {
        ...track.harmonyEvidence,
        ...(comparable ? {
          selectedMotion: metrics.averageSemitoneMotion,
          maximumLeap: metrics.maximumVoiceLeap,
        } : {
          selectedMotion: undefined,
          baselineMotion: undefined,
          maximumLeap: undefined,
        }),
        melodyEvidencePreserved,
        bassEvidencePreserved,
      },
    });
  }
  let ordered = [...track.notes].sort((left, right) => left.start - right.start);
  ordered = ordered.filter((note) => !conflictsObservedPart(note));
  ordered = ordered.map((note, index) => {
    if (!note.id.endsWith(":resolve-next")) return note;
    const next = ordered[index + 1];
    if (next?.id.includes(":resolution-of-") && Math.abs(next.pitch - note.pitch) <= 2) return note;
    return {
      ...note,
      id: note.id.replace(/:(?:suspension|passing|approach|anticipation):resolve-next$/, ":chord:stable"),
    };
  });
  const obligations = ordered.filter((note) => note.id.endsWith(":resolve-next"));
  const realized = obligations.filter((note) => {
    const index = ordered.indexOf(note);
    return ordered[index + 1]?.id.includes(":resolution-of-");
  });
  const melodyEvidencePreserved = ordered.every((note) =>
    !songModel.melody.some((melody) =>
      melody.confidence >= .6 &&
      melody.start < note.start + note.duration &&
      melody.end > note.start &&
      Math.abs(melody.pitch - note.pitch) <= 1));
  const bassEvidencePreserved = ordered.every((note) =>
    !readBassEvidence(songModel).some((bass) =>
      bass.start < note.start + note.duration &&
      bass.end > note.start &&
      note.pitch <= bass.pitch + 4));
  return finalize({
    ...track,
    notes: ordered,
    harmonyEvidence: {
      ...track.harmonyEvidence,
      resolutionObligations: realized.length,
      melodyEvidencePreserved,
      bassEvidencePreserved,
    },
  });
}

function advancedVoicingCandidates(
  chord: HarmonySpan,
  voiceCount: number,
  range: { min: number; max: number },
): number[][] {
  const pitchClasses = [...new Set(chord.tones.map((tone) => ((tone % 12) + 12) % 12))];
  const available = pitchesInRange(pitchClasses, range.min, range.max);
  if (!available.length) return [];
  const candidates: number[][] = [];
  const choose = (start: number, selected: number[]) => {
    if (candidates.length >= 512) return;
    if (selected.length === voiceCount) {
      const distinct = new Set(selected.map((pitch) => pitch % 12));
      if (distinct.size >= Math.min(voiceCount, 3, pitchClasses.length)) candidates.push(selected);
      return;
    }
    for (let index = start; index < available.length; index += 1) {
      if (selected.length && available[index] - selected.at(-1)! < 3) continue;
      choose(index + 1, [...selected, available[index]]);
      if (candidates.length >= 512) return;
    }
  };
  choose(0, []);
  return candidates;
}

export function measureVoicingMotion(voicings: number[][]): VoicingMetrics {
  let transitions = 0;
  let totalSemitoneMotion = 0;
  let maximumVoiceLeap = 0;
  for (let index = 1; index < voicings.length; index += 1) {
    const previous = voicings[index - 1];
    const current = voicings[index];
    if (!previous.length || !current.length) continue;
    if (previous.length !== current.length) continue;
    transitions += 1;
    for (let voice = 0; voice < current.length; voice += 1) {
      const motion = Math.abs(current[voice] - previous[voice]);
      totalSemitoneMotion += motion;
      maximumVoiceLeap = Math.max(maximumVoiceLeap, motion);
    }
  }
  return {
    transitions,
    totalSemitoneMotion,
    averageSemitoneMotion: transitions
      ? round(totalSemitoneMotion / transitions, 3)
      : 0,
    maximumVoiceLeap,
  };
}

function voicingRespectsObservedParts(
  candidate: number[],
  songModel: SongModelData,
  chord: HarmonySpan,
): boolean {
  const melodyConflict = songModel.melody.some((note) =>
    note.confidence >= .6 &&
    note.start < chord.end &&
    note.end > chord.start &&
    candidate.some((pitch) => Math.abs(pitch - note.pitch) <= 1));
  const bass = readBassEvidence(songModel).filter((note) =>
    note.start < chord.end && note.end > chord.start);
  const bassConflict = bass.some((note) =>
    candidate.some((pitch) => pitch <= note.pitch + 4));
  return !melodyConflict && !bassConflict;
}

function counterlineNotes(input: {
  track: TrackModel;
  songModel: SongModelData;
  plan: ArrangementPlan;
  harmony: HarmonySpan[];
  spaceMap?: ArrangementSpaceMap;
}): MusicalNote[] {
  const notes: MusicalNote[] = [];
  const role = input.plan.compositionIntelligence?.instrumentRoles
    .find((candidate) => candidate.trackId === input.track.id);
  if (role?.function !== "counterline" &&
    !/counter|melody|string|brass/i.test(`${input.track.role} ${input.track.instrument}`)) {
    return input.track.notes;
  }
  const range = input.track.instrumentDefinition.registers.find((item) => item.name === "high") ??
    input.track.instrumentDefinition.comfortableRange;
  const phrases = input.plan.compositionIntelligence?.phrases.length
    ? input.plan.compositionIntelligence.phrases
    : input.plan.sections.map((section, index) => ({
        id: `phrase:section:${index + 1}:whole`,
        sectionId: input.plan.hierarchy?.sections[index]?.id ?? `section:${section.section}:${index + 1}`,
        startBar: section.startBar,
        endBar: section.endBar,
        intent: "develop" as const,
        tension: .6,
        motifRef: `motif:${hashSeed(`${section.section}:${index}`)}`,
        sourceMotifRef: null,
      }));
  for (const phrase of phrases) {
    const section = input.plan.hierarchy?.sections.find((item) => item.id === phrase.sectionId);
    const sectionIndex = section
      ? input.plan.hierarchy?.sections.findIndex((item) => item.id === section.id) ?? -1
      : -1;
    const planSection = sectionIndex >= 0
      ? input.plan.sections[sectionIndex]
      : input.plan.sections.find((item) =>
          item.startBar <= phrase.startBar && item.endBar >= phrase.endBar);
    if (!planSection) continue;
    const explicitlyRouted = (planSection.activeTracks?.includes(input.track.id) ?? true) &&
      planSection.trackDirectives?.[input.track.id]?.role === "countermelody";
    if (!explicitlyRouted) continue;
    const action = planSection.tracks[input.track.id] ??
      planSection.tracks[input.track.instrument] ?? "";
    if (action !== "countermelody" && role?.function !== "counterline" &&
      !/countermelody/i.test(input.track.role)) continue;
    const barSeconds = secondsPerBar(
      input.songModel.tempoMap[0]?.bpm ?? 92,
      input.songModel.meterMap[0]?.meter,
    );
    const bounds = arrangementBarRangeSeconds(
      input.songModel, phrase.startBar, phrase.endBar, barSeconds,
    );
    const motif = [0, 2, 4, 2].map((step, index) =>
      phrase.intent === "answer" ? -step + (index === 3 ? 2 : 0) : step);
    const slots = 4;
    const slot = (bounds.end - bounds.start) / slots;
    let previousPitch: number | undefined;
    motif.forEach((offset, index) => {
      const start = bounds.start + slot * index;
      const duration = Math.max(input.track.instrumentDefinition.constraints.minNoteDuration, slot * .58);
      if (intersectsObservedVoice(start, start + duration, input.spaceMap)) return;
      const chord = input.harmony.find((candidate) => candidate.start <= start && candidate.end > start);
      if (!chord) return;
      const chordPcs = chord.tones.map((tone) => ((tone % 12) + 12) % 12);
      const targetPc = chordPcs[(hashSeed(phrase.motifRef) + index) % chordPcs.length];
      const available = pitchesInRange(chordPcs, range.min, range.max);
      let pitch = available.sort((left, right) =>
        Math.abs(left - ((previousPitch ?? (range.min + range.max) / 2) + offset)) -
        Math.abs(right - ((previousPitch ?? (range.min + range.max) / 2) + offset)) ||
        left - right)[0];
      if (pitch === undefined) return;
      const grammar = phrase.intent === "answer" && index === 0 && phrase.tension >= .5
        ? "suspension"
        : phrase.intent === "release" && index === 0
          ? "pedal"
          : phrase.intent === "build" && index === slots - 2
            ? "anticipation"
          : index === slots - 2 && phrase.tension >= .45
              ? "approach"
            : index === 1 && phrase.tension >= .3
              ? "passing"
              : "chord";
      const resolutionRequired = ["suspension", "passing", "approach", "anticipation"].includes(grammar);
      if (grammar === "approach" || grammar === "suspension") {
        const resolution = available.find((candidate) => candidate % 12 === targetPc) ?? pitch;
        pitch = Math.max(range.min, Math.min(range.max, resolution - 1));
      } else if (grammar === "passing" && previousPitch !== undefined) {
        pitch = Math.max(range.min, Math.min(range.max, previousPitch + (offset >= 0 ? 2 : -2)));
      }
      const conflictsObservedPart = input.songModel.melody.some((melody) =>
        melody.confidence >= .6 &&
        melody.start < start + duration &&
        melody.end > start &&
        Math.abs(melody.pitch - pitch) <= 1) ||
        readBassEvidence(input.songModel).some((bass) =>
          bass.start < start + duration &&
          bass.end > start &&
          pitch <= bass.pitch + 4);
      if (conflictsObservedPart) return;
      notes.push({
        id: `${input.track.id}:counter:${phrase.motifRef}:${index}:${grammar}:${resolutionRequired ? "resolve-next" : "stable"}`,
        start: round(start),
        duration: round(Math.min(duration, bounds.end - start)),
        pitch: midi(pitch),
        velocity: midi(58 + phrase.tension * 32 + (index === 2 ? 8 : 0)),
        voice: "countermelody",
      });
      previousPitch = pitch;
    });
    for (let index = 0; index < notes.length; index += 1) {
      if (!notes[index].id.endsWith(":resolve-next")) continue;
      const next = notes[index + 1];
      const chord = next
        ? input.harmony.find((candidate) =>
            candidate.start <= next.start && candidate.end > next.start)
        : undefined;
      const step = next ? Math.abs(next.pitch - notes[index].pitch) : Infinity;
      if (!next || !chord ||
        !chord.tones.some((tone) => tone % 12 === next.pitch % 12) ||
        step > 2) {
        const ownChord = input.harmony.find((candidate) =>
          candidate.start <= notes[index].start && candidate.end > notes[index].start);
        const available = ownChord
          ? pitchesInRange(
              ownChord.tones.map((tone) => ((tone % 12) + 12) % 12),
              range.min,
              range.max,
            )
          : [];
        const replacement = available.sort((left, right) =>
          Math.abs(left - notes[index].pitch) - Math.abs(right - notes[index].pitch))[0];
        if (replacement !== undefined) {
          notes[index] = {
            ...notes[index],
            pitch: replacement,
            id: notes[index].id.replace(/:(?:suspension|passing|approach|anticipation):resolve-next$/, ":chord:stable"),
          };
        }
      } else {
        next.id = `${next.id}:resolution-of-${index}`;
      }
    }
  }
  return notes;
}

function pitchesInRange(pitchClasses: number[], min: number, max: number): number[] {
  const result: number[] = [];
  for (let pitch = min; pitch <= max; pitch += 1) {
    if (pitchClasses.includes(pitch % 12)) result.push(pitch);
  }
  return result;
}

function applyAdvancedHarmony(input: {
  tracks: TrackModel[];
  songModel: SongModelData;
  plan: ArrangementPlan;
  harmony: HarmonySpan[];
  spaceMap?: ArrangementSpaceMap;
}): TrackModel[] {
  if (input.plan.compositionIntelligence?.version !== "2.0") return input.tracks;
  return input.tracks.map((track) => {
    const role = input.plan.compositionIntelligence!.instrumentRoles
      .find((candidate) => candidate.trackId === track.id)?.function;
    const hasExplicitCounterline = input.plan.sections.some((section) =>
      (section.activeTracks?.includes(track.id) ?? true) &&
      section.trackDirectives?.[track.id]?.role === "countermelody");
    if ((role === "counterline" || /countermelody/i.test(track.role)) && hasExplicitCounterline) {
      const generated = counterlineNotes({ ...input, track });
      const barSeconds = secondsPerBar(
        input.songModel.tempoMap[0]?.bpm ?? 92,
        input.songModel.meterMap[0]?.meter,
      );
      const routedRanges = input.plan.sections.flatMap((section) =>
        (section.activeTracks?.includes(track.id) ?? true) &&
        section.trackDirectives?.[track.id]?.role === "countermelody"
          ? [arrangementBarRangeSeconds(
              input.songModel, section.startBar, section.endBar, barSeconds,
            )]
          : []);
      const preserved = track.notes.filter((note) => !routedRanges.some((range) =>
        note.start >= range.start && note.start < range.end));
      return {
        ...track,
        notes: [...preserved, ...generated].sort((left, right) => left.start - right.start),
        harmonyEvidence: {
          version: "2.0",
          mode: "phrase_countermelody",
          motifRefs: [...new Set(generated.map((note) =>
            note.id.split(":counter:")[1]?.split(":").slice(0, 2).join(":") ?? "")
            .filter(Boolean))],
          resolutionObligations: generated.filter((note) =>
            note.id.endsWith(":resolve-next")).length,
          melodyEvidencePreserved: true,
          bassEvidencePreserved: true,
        },
        provenance: provenance("ADVANCED_HARMONY_ENGINE", "2.0.0", {
          mode: "phrase_countermelody",
          motifLineage: true,
          resolutionObligations: true,
        }, [track.provenance.model]),
      };
    }
    if (role !== "harmony" || !track.instrumentDefinition.polyphonic) return track;
    const voiceCount = Math.min(3, track.instrumentDefinition.maxVoices);
    const range = track.instrumentDefinition.comfortableRange;
    let previous: number[] = [];
    const selectedVoicings: number[][] = [];
    const baselineVoicings: number[][] = [];
    const notes: MusicalNote[] = [];
    const bpm = input.songModel.tempoMap[0]?.bpm ?? 92;
    const barSeconds = secondsPerBar(bpm, input.songModel.meterMap[0]?.meter);
    const spans = input.harmony.flatMap((chord) => input.plan.sections.flatMap((section, sectionIndex) => {
      const active = section.activeTracks
        ? section.activeTracks.includes(track.id)
        : (section.tracks[track.id] ?? "") !== "none";
      if (!active) return [];
      const bounds = arrangementSectionSeconds(input.songModel, section, barSeconds);
      const sectionId = input.plan.hierarchy?.sections[sectionIndex]?.id;
      const phrases = input.plan.compositionIntelligence!.phrases.filter((phrase) =>
        phrase.sectionId === sectionId);
      const ranges = phrases.length
        ? phrases.map((phrase) => ({
            start: arrangementBarRangeSeconds(
              input.songModel, phrase.startBar, phrase.endBar, barSeconds,
            ).start,
            end: arrangementBarRangeSeconds(
              input.songModel, phrase.startBar, phrase.endBar, barSeconds,
            ).end,
            phrase,
          }))
        : [{ start: bounds.start, end: bounds.end, phrase: undefined }];
      return ranges.flatMap((range) => {
        const start = Math.max(chord.start, range.start);
        const end = Math.min(chord.end, range.end);
        return end > start ? [{
          ...chord,
          start,
          end,
          section,
          sectionIndex,
          phrase: range.phrase,
        }] : [];
      });
    })).sort((left, right) => left.start - right.start || left.end - right.end);
    for (const chord of spans) {
      const candidates = advancedVoicingCandidates(chord, voiceCount, range)
        .filter((candidate) => voicingRespectsObservedParts(candidate, input.songModel, chord));
      const selected = [...candidates].sort((left, right) =>
        scoreVoicing(left, previous, input.songModel.melody, chord, input.plan.style.harmony.voicing === "wide") -
        scoreVoicing(right, previous, input.songModel.melody, chord, input.plan.style.harmony.voicing === "wide") ||
        left.join(",").localeCompare(right.join(",")))[0];
      if (!selected) continue;
      const duration = Math.max(track.instrumentDefinition.constraints.minNoteDuration, chord.end - chord.start);
      selected.forEach((pitch, voice) => notes.push({
        id: `${track.id}:voicing:${chord.start}:${voice}`,
        start: round(chord.start + Math.min(.08, duration * .02)),
        duration: round(Math.max(
          track.instrumentDefinition.constraints.minNoteDuration,
          duration - Math.min(.08, duration * .02),
        )),
        pitch,
        velocity: midi(62 + input.plan.style.harmony.tension * 24 +
          (input.plan.hierarchy?.sections[chord.sectionIndex]
            ? input.plan.compositionIntelligence!.tensionRelease.find((arc) =>
                arc.sectionId === input.plan.hierarchy!.sections[chord.sectionIndex].id)?.tension ?? 0
            : 0) * 12 + (chord.phrase?.tension ?? 0) * 8),
        voice: `harmony-${voice}`,
      }));
      selectedVoicings.push(selected);
      baselineVoicings.push(naiveRootVoicing(chord, range, voiceCount));
      previous = selected;
    }
    const selectedMetrics = measureVoicingMotion(selectedVoicings);
    const baselineMetrics = measureVoicingMotion(baselineVoicings);
    return {
      ...track,
      notes,
      harmonyEvidence: {
        version: "2.0",
        mode: "advanced_voicing",
        selectedMotion: selectedMetrics.averageSemitoneMotion,
        baselineMotion: baselineMetrics.averageSemitoneMotion,
        maximumLeap: selectedMetrics.maximumVoiceLeap,
        melodyEvidencePreserved: true,
        bassEvidencePreserved: true,
      },
      provenance: provenance("ADVANCED_HARMONY_ENGINE", "2.0.0", {
        mode: "inversion_spacing_voice_leading",
        selectedAverageMotion: selectedMetrics.averageSemitoneMotion,
        baselineAverageMotion: baselineMetrics.averageSemitoneMotion,
        selectedMaximumLeap: selectedMetrics.maximumVoiceLeap,
        baselineMaximumLeap: baselineMetrics.maximumVoiceLeap,
        melodyEvidencePreserved: true,
        bassEvidencePreserved: true,
      }, [track.provenance.model]),
    };
  });
}

export function synchronizeMotifLineage(
  tracks: TrackModel[],
  reasoning: ArrangementPlan["compositionIntelligence"],
): TrackModel[] {
  if (!reasoning?.motifs?.length) return tracks;
  const fingerprints = new Map<string, string>();
  for (const motif of reasoning.motifs) {
    const material = tracks
      .filter((track) => !motif.ownerTrackId || track.id === motif.ownerTrackId)
      .flatMap((track) => track.notes.filter((note) =>
        note.motif?.id === motif.id && note.motif.phraseId === motif.sourcePhraseId));
    const fingerprint = canonicalMotifFingerprint(material);
    motif.fingerprint = fingerprint;
    fingerprints.set(motif.id, fingerprint);
  }
  return tracks.map((track) => {
    const updated = {
      ...track,
      notes: track.notes.map((note) => note.motif && fingerprints.has(note.motif.id)
        ? { ...note, motif: { ...note.motif, fingerprint: fingerprints.get(note.motif.id)! } }
        : note),
    };
    if (updated.performanceEvidence) {
      updated.performanceEvidence = {
        ...updated.performanceEvidence,
        performedMaterialSha256: performedMaterialSha256(updated),
      };
    }
    return updated;
  });
}
