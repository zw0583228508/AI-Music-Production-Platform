import type {
  AnalysisSection,
  ArrangementSection,
  CandidatePlan,
  GenerationParameters,
  MusicGenerationTask,
  ModelCapability,
  SongModelData,
  TrackModel,
} from "@workspace/db";
import { db, modelRegistryTable } from "@workspace/db";
export type ProviderStatus = "ready" | "configured" | "unavailable";

export type MusicProviderDescriptor = {
  id: string;
  name: string;
  provider: string;
  version: string;
  capabilities: ModelCapability[];
  inputTypes: string[];
  execution: "local" | "remote";
  status: ProviderStatus;
  license: string | null;
  priority: number;
  notes: string;
};

export type ArrangementProviderInput = {
  projectId: string;
  arrangementId: string;
  style: string;
  mode: string;
  sourceType: string;
  harmonyComplexity: number;
  energy: number;
  density: number;
  candidateCount: number;
  seed?: number;
  songModel: SongModelData;
  tracks: Array<{ id: string; name: string; role: string; instrument: string }>;
};

export type ArrangementCandidateOutput = {
  id: string;
  label: string;
  score: number;
  summary: string;
  provider: string;
};

export type ArrangementProviderOutput = {
  provider: MusicProviderDescriptor;
  sections: Array<{
    name: string;
    energy: number;
    density: number;
    tracks: string[];
  }>;
  candidates: ArrangementCandidateOutput[];
  trackModels?: TrackModel[];
  contractErrors: string[];
};

export class ProviderUnavailableError extends Error {
  constructor(public readonly providerId: string) {
    super(`Provider ${providerId} is not configured or available`);
  }
}

const remoteConfigured = (name: string): boolean =>
  Boolean(process.env[`${name}_API_URL`]);

export const MUSIC_PROVIDERS: MusicProviderDescriptor[] = [
  {
    id: "LOCAL_SIGNAL_ANALYZER_V1",
    name: "Local Signal Analyzer",
    provider: "Replit Workspace",
    version: "1.0.0",
    capabilities: ["structure"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "SOLO_INSTRUMENT", "INSTRUMENTAL", "VIDEO"],
    execution: "local",
    status: "ready",
    license: "Internal",
    priority: 10,
    notes: "FFmpeg-backed baseline with explicit fallback provenance.",
  },
  {
    id: "LOCAL_SYMBOLIC_DIRECTOR_V1",
    name: "Local Symbolic Arrangement Director",
    provider: "Replit Workspace",
    version: "1.0.0",
    capabilities: ["arrangement", "orchestration"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "SOLO_INSTRUMENT", "INSTRUMENTAL", "MIDI", "VIDEO"],
    execution: "local",
    status: "ready",
    license: "Internal",
    priority: 20,
    notes: "Deterministic source-aware provider used when no remote model is configured.",
  },
  {
    id: "ACE_STEP_BASE",
    name: "ACE-Step",
    provider: "ACE-Step",
    version: "configured-endpoint",
    capabilities: ["arrangement", "audio_generation"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "INSTRUMENTAL"],
    execution: "remote",
    status: remoteConfigured("ACE_STEP") ? "configured" : "unavailable",
    license: "Provider terms",
    priority: 30,
    notes: "Requires ACE_STEP_API_URL.",
  },
  {
    id: "ACE_STEP_COMPLETE",
    name: "ACE-Step Complete",
    provider: "ACE-Step",
    version: "configured-endpoint",
    capabilities: ["arrangement", "audio_generation"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "SOLO_INSTRUMENT", "INSTRUMENTAL"],
    execution: "remote",
    status: remoteConfigured("ACE_STEP_COMPLETE") ? "configured" : "unavailable",
    license: "Provider terms",
    priority: 31,
    notes: "Requires ACE_STEP_COMPLETE_API_URL.",
  },
  {
    id: "ACE_STEP_LEGO",
    name: "ACE-Step Lego",
    provider: "ACE-Step",
    version: "configured-endpoint",
    capabilities: ["audio_generation"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "SOLO_INSTRUMENT", "INSTRUMENTAL", "MIDI"],
    execution: "remote",
    status: remoteConfigured("ACE_STEP_LEGO") ? "configured" : "unavailable",
    license: "Provider terms",
    priority: 32,
    notes: "Requires ACE_STEP_LEGO_API_URL; adds a focused audio part.",
  },
  {
    id: "ANYACCOMP",
    name: "AnyAccomp",
    provider: "AnyAccomp",
    version: "configured-endpoint",
    capabilities: ["arrangement"],
    inputTypes: ["VOCAL_ONLY", "SOLO_INSTRUMENT", "MIDI"],
    execution: "remote",
    status: remoteConfigured("ANYACCOMP") ? "configured" : "unavailable",
    license: "Provider terms",
    priority: 40,
    notes: "Requires ANYACCOMP_API_URL.",
  },
  {
    id: "SYMPHONYGEN",
    name: "SymphonyGen",
    provider: "SymphonyGen",
    version: "configured-endpoint",
    capabilities: ["arrangement", "orchestration"],
    inputTypes: ["MIDI", "SOLO_INSTRUMENT", "FULL_SONG"],
    execution: "remote",
    status: remoteConfigured("SYMPHONYGEN") ? "configured" : "unavailable",
    license: "Provider terms",
    priority: 50,
    notes: "Requires SYMPHONYGEN_API_URL.",
  },
  {
    id: "METEOR",
    name: "METEOR",
    provider: "METEOR",
    version: "configured-endpoint",
    capabilities: ["arrangement", "orchestration"],
    inputTypes: ["MIDI"],
    execution: "remote",
    status: remoteConfigured("METEOR") ? "configured" : "unavailable",
    license: "Provider terms",
    priority: 60,
    notes: "Requires METEOR_API_URL.",
  },
  {
    id: "MIDI_SAG",
    name: "MIDI-SAG",
    provider: "MIDI-SAG",
    version: "configured-endpoint",
    capabilities: ["arrangement", "orchestration"],
    inputTypes: ["VOCAL_ONLY", "SOLO_INSTRUMENT", "MIDI"],
    execution: "remote",
    status: remoteConfigured("MIDI_SAG") ? "configured" : "unavailable",
    license: "Provider terms",
    priority: 65,
    notes: "Requires MIDI_SAG_API_URL.",
  },
  {
    id: "LOCAL_EXPRESSIVE_SYNTH",
    name: "Local Expressive Synth",
    provider: "Replit Workspace",
    version: "1.0.0",
    capabilities: ["audio_generation"],
    inputTypes: ["MIDI"],
    execution: "local",
    status: "ready",
    license: "Internal",
    priority: 65,
    notes: "Deterministic expressive preview renderer; not sfizz, VSCO, Pedalboard, or a VST.",
  },
  {
    id: "SFIZZ_VSCO2_CE",
    name: "sfizz + VSCO 2 CE",
    provider: "Versilian Studios / sfizz",
    version: "1.0.0",
    capabilities: ["audio_generation"],
    inputTypes: ["MIDI"],
    execution: "remote",
    status: remoteConfigured("SFIZZ_RENDER") && Boolean(process.env.VSCO2_LIBRARY_PATH)
      ? "configured"
      : "unavailable",
    license: "VSCO 2 CE / sfizz terms",
    priority: 66,
    notes: "Requires SFIZZ_RENDER_API_URL and VSCO2_LIBRARY_PATH.",
  },
  {
    id: "PEDALBOARD_VST3",
    name: "Spotify Pedalboard VST3 Renderer",
    provider: "Spotify Pedalboard",
    version: "configured-endpoint",
    capabilities: ["audio_generation"],
    inputTypes: ["MIDI"],
    execution: "remote",
    status: remoteConfigured("PEDALBOARD_VST3") ? "configured" : "unavailable",
    license: "Provider and plugin terms",
    priority: 67,
    notes: "Requires PEDALBOARD_VST3_API_URL and licensed VST3 instruments.",
  },
  {
    id: "BASIC_PITCH",
    name: "Basic Pitch",
    provider: "Spotify",
    version: "configured-endpoint",
    capabilities: ["transcription"],
    inputTypes: ["VOCAL_ONLY", "SOLO_INSTRUMENT"],
    execution: "remote",
    status: remoteConfigured("BASIC_PITCH") ? "configured" : "unavailable",
    license: "Apache-2.0",
    priority: 70,
    notes: "Requires BASIC_PITCH_API_URL; consumes signed private source URLs.",
  },
  {
    id: "MT3",
    name: "MT3",
    provider: "Google Research",
    version: "configured-endpoint",
    capabilities: ["transcription"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("MT3") ? "configured" : "unavailable",
    license: "Apache-2.0",
    priority: 80,
    notes: "Requires MT3_API_URL; consumes signed private source URLs.",
  },
  {
    id: "ALL_IN_ONE",
    name: "All-In-One Music Structure Analyzer",
    provider: "Research model",
    version: "configured-endpoint",
    capabilities: ["structure"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("ALL_IN_ONE") ? "configured" : "unavailable",
    license: "Model-specific",
    priority: 90,
    notes: "Requires ALL_IN_ONE_API_URL; consumes signed private source URLs.",
  },
  {
    id: "BS_ROFORMER",
    name: "BS-RoFormer",
    provider: "Research model",
    version: "configured-endpoint",
    capabilities: ["separation"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("BS_ROFORMER") || remoteConfigured("BS_ROFORMER_SW")
      ? "configured"
      : "unavailable",
    license: "Model-specific",
    priority: 100,
    notes: "Requires BS_ROFORMER_API_URL; returns stems that are copied into private analysis storage.",
  },
  {
    id: "SHEETSAGE",
    name: "SheetSage",
    provider: "Research model",
    version: "configured-endpoint",
    capabilities: ["harmony"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("SHEETSAGE") || remoteConfigured("SHEET_SAGE")
      ? "configured"
      : "unavailable",
    license: "Model-specific",
    priority: 110,
    notes: "Requires SHEETSAGE_API_URL (legacy SHEET_SAGE_API_URL is also accepted); supplies chord candidates for canonical fusion.",
  },
  {
    id: "CHROMA",
    name: "Chroma Harmony Evidence",
    provider: "Configured analysis service",
    version: "configured-endpoint",
    capabilities: ["harmony"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("CHROMA") ? "configured" : "unavailable",
    license: "Provider terms",
    priority: 120,
    notes: "Requires CHROMA_API_URL; supplies normalized chroma frames and optional chord candidates.",
  },
  {
    id: "BASS",
    name: "Bass Harmony Evidence",
    provider: "Configured analysis service",
    version: "configured-endpoint",
    capabilities: ["harmony"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("BASS") ? "configured" : "unavailable",
    license: "Provider terms",
    priority: 130,
    notes: "Requires BASS_API_URL; supplies bass-note evidence used to score chord roots.",
  },
];

export class ModelRouter {
  select(
    requested: string | undefined,
    sourceType: string,
    context?: { style?: string; mode?: string; hasExistingArrangement?: boolean },
  ): MusicProviderDescriptor {
    if (requested && requested !== "CUSTOM") {
      const exact = MUSIC_PROVIDERS.find((provider) => provider.id === requested);
      if (!exact || exact.status === "unavailable") {
        throw new ProviderUnavailableError(requested);
      }
      return exact;
    }

    const style = context?.style?.toLowerCase() ?? "";
    const preferredIds = context?.hasExistingArrangement
      ? ["METEOR", "SYMPHONYGEN"]
      : sourceType === "VOCAL_ONLY"
        ? ["ACE_STEP_COMPLETE", "ANYACCOMP", "MIDI_SAG"]
        : style.includes("cinematic") || style.includes("orchestra")
          ? ["SYMPHONYGEN", "METEOR"]
          : sourceType === "MIDI"
            ? ["MIDI_SAG", "SYMPHONYGEN", "METEOR"]
            : ["ACE_STEP_BASE", "SYMPHONYGEN", "ANYACCOMP"];
    for (const id of preferredIds) {
      const provider = MUSIC_PROVIDERS.find((candidate) =>
        candidate.id === id &&
        candidate.status !== "unavailable" &&
        candidate.capabilities.includes("arrangement") &&
        candidate.inputTypes.includes(sourceType));
      if (provider) return provider;
    }
    return MUSIC_PROVIDERS.find((provider) => provider.id === "LOCAL_SYMBOLIC_DIRECTOR_V1")!;
  }
}
export function selectArrangementProvider(
  requested: string | undefined,
  sourceType: string,
  context?: { style?: string; mode?: string; hasExistingArrangement?: boolean },
): MusicProviderDescriptor {
  return new ModelRouter().select(requested, sourceType, context);
}

function trackPalette(
  section: AnalysisSection,
  density: number,
  harmonyComplexity: number,
): string[] {
  const tracks = ["Piano", "Bass"];
  if (section.energy > 0.35 || density > 0.45) tracks.push("Strings");
  if (section.energy > 0.55 || density > 0.62) tracks.push("Drums");
  if (section.energy > 0.72 || harmonyComplexity >= 7) tracks.push("Brass");
  if (section.energy > 0.86 && density > 0.75) tracks.push("Percussion");
  return tracks;
}

export function validateArrangementProviderOutput(
  output: ArrangementProviderOutput,
  expectedCandidateCount: number,
  expectedTrackIds: string[] = [],
): string[] {
  const errors: string[] = [...output.contractErrors];
  if (!output.provider.capabilities.includes("arrangement")) {
    errors.push("Selected provider does not declare arrangement capability");
  }
  if (!output.sections.length) errors.push("Provider returned no arrangement sections");
  if (output.candidates.length !== expectedCandidateCount) {
    errors.push(`Provider returned ${output.candidates.length} candidates; expected ${expectedCandidateCount}`);
  }
  for (const section of output.sections) {
    if (!section.name.trim()) errors.push("A section is missing its name");
    if (section.energy < 0 || section.energy > 1) errors.push(`${section.name} has invalid energy`);
    if (section.density < 0 || section.density > 1) errors.push(`${section.name} has invalid density`);
    if (!section.tracks.length) errors.push(`${section.name} has no active tracks`);
  }
  if (output.provider.execution === "remote" && !output.trackModels?.length) {
    errors.push("Remote arrangement provider returned no canonical playable TrackModels");
  }
  if (output.provider.execution === "remote") {
    const returnedTrackIds = (output.trackModels ?? []).map((track) => track.id);
    if (new Set(returnedTrackIds).size !== returnedTrackIds.length) {
      errors.push("Remote arrangement provider returned duplicate TrackModel ids");
    }
    const expected = [...expectedTrackIds].sort();
    const returned = [...returnedTrackIds].sort();
    if (
      expected.length !== returned.length ||
      expected.some((id, index) => id !== returned[index])
    ) {
      errors.push("Remote TrackModels must map one-to-one to the requested project track ids");
    }
  }
  for (const track of output.trackModels ?? []) {
    if (!track.id || !track.instrument || !track.role) errors.push("A TrackModel is missing identity fields");
    if (!track.instrumentDefinition) errors.push(`${track.id || "TrackModel"} is missing an InstrumentDefinition`);
    for (const note of track.notes ?? []) {
      if (
        note.pitch < track.instrumentDefinition.playableRange.min ||
        note.pitch > track.instrumentDefinition.playableRange.max
      ) {
        errors.push(`${track.id} contains a note outside the instrument playable range`);
        break;
      }
    }
    const sortedNotes = [...track.notes].sort((left, right) => left.start - right.start);
    let maximumConcurrent = 0;
    for (const note of sortedNotes) {
      maximumConcurrent = Math.max(
        maximumConcurrent,
        sortedNotes.filter((other) =>
          other.start < note.start + note.duration &&
          other.start + other.duration > note.start).length,
      );
    }
    const allowedVoices = Math.min(
      track.instrumentDefinition.maxVoices,
      track.instrumentDefinition.constraints.maxSimultaneousNotes,
    );
    if (maximumConcurrent > allowedVoices || (!track.instrumentDefinition.polyphonic && maximumConcurrent > 1)) {
      errors.push(`${track.id} exceeds the instrument polyphony limit`);
    }
    if (sortedNotes.some((note) => note.duration < track.instrumentDefinition.constraints.minNoteDuration)) {
      errors.push(`${track.id} contains notes shorter than the instrument can perform`);
    }
    if (sortedNotes.some((note, index) => {
      const previous = sortedNotes[index - 1];
      return previous && Math.abs(note.pitch - previous.pitch) > track.instrumentDefinition.constraints.maxLeap;
    })) {
      errors.push(`${track.id} contains an unplayable melodic leap`);
    }
    if (
      track.instrumentDefinition.constraints.breathSeconds &&
      sortedNotes.some((note) => note.duration > track.instrumentDefinition.constraints.breathSeconds!)
    ) {
      errors.push(`${track.id} contains a phrase longer than the instrument breath limit`);
    }
  }
  for (const candidate of output.candidates) {
    if (!candidate.id.trim()) errors.push("A candidate is missing its id");
    if (!candidate.label.trim()) errors.push(`${candidate.id || "Candidate"} is missing its label`);
    if (!candidate.summary.trim()) errors.push(`${candidate.id || "Candidate"} is missing its summary`);
    if (candidate.provider !== output.provider.id) {
      errors.push(`${candidate.id || "Candidate"} has inconsistent provider provenance`);
    }
    if (candidate.score < 0 || candidate.score > 1) {
      errors.push(`${candidate.label} has an invalid score`);
    }
  }
  if (new Set(output.candidates.map((candidate) => candidate.id)).size !== output.candidates.length) {
    errors.push("Provider returned duplicate candidate ids");
  }
  return errors;
}

export function generateLocalArrangement(
  provider: MusicProviderDescriptor,
  input: ArrangementProviderInput,
): ArrangementProviderOutput {
  const sourceSections = input.songModel.sections.length
    ? input.songModel.sections
    : [{ name: "Full Song", startBar: 1, endBar: 16, energy: input.energy }];
  const sections = sourceSections.map((section) => {
    const sectionEnergy = Math.max(
      0.05,
      Math.min(1, section.energy * 0.65 + input.energy * 0.35),
    );
    const sectionDensity = Math.max(
      0.1,
      Math.min(1, input.density * 0.7 + sectionEnergy * 0.3),
    );
    return {
      name: section.name,
      energy: Number(sectionEnergy.toFixed(3)),
      density: Number(sectionDensity.toFixed(3)),
      tracks: trackPalette(section, sectionDensity, input.harmonyComplexity),
    };
  });
  const candidates = Array.from({ length: input.candidateCount }, (_, index) => ({
    id: `${input.arrangementId}-candidate-${index + 1}`,
    label: `Candidate ${String.fromCharCode(65 + index)}`,
    score: Number(Math.max(0.5, 0.93 - index * 0.045).toFixed(3)),
    summary: index === 0
      ? "Best source fidelity and section-aware dynamic arc"
      : index === 1
        ? "Wider orchestration while preserving the detected form"
        : "Lean rhythm-focused variation with reduced density",
    provider: provider.id,
  }));
  return { provider, sections, candidates, trackModels: undefined, contractErrors: [] };
}

function remoteEnvironmentPrefix(providerId: string): string {
  return providerId === "ACE_STEP_BASE" ? "ACE_STEP" : providerId;
}

export async function runArrangementProvider(
  provider: MusicProviderDescriptor,
  input: ArrangementProviderInput,
): Promise<ArrangementProviderOutput> {
  if (provider.execution === "local") {
    return generateLocalArrangement(provider, input);
  }

  const prefix = remoteEnvironmentPrefix(provider.id);
  const endpoint = process.env[`${prefix}_API_URL`];
  if (!endpoint) throw new ProviderUnavailableError(provider.id);
  const token = process.env[`${prefix}_API_TOKEN`];
  const response = await fetch(new URL("/arrange", endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    throw new Error(`${provider.id} returned HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  const contractErrors: string[] = [];
  const record = isRecord(payload) ? payload : {};
  if (!isRecord(payload)) contractErrors.push("Provider response must be a JSON object");
  const sections = Array.isArray(record["sections"])
    ? record["sections"].flatMap((value, index) => {
        if (!isRecord(value)) {
          contractErrors.push(`Section ${index + 1} must be an object`);
          return [];
        }
        const name = value["name"];
        const energy = value["energy"];
        const density = value["density"];
        const tracks = value["tracks"];
        if (
          typeof name !== "string" ||
          typeof energy !== "number" ||
          !Number.isFinite(energy) ||
          typeof density !== "number" ||
          !Number.isFinite(density) ||
          !Array.isArray(tracks) ||
          !tracks.every((track) => typeof track === "string" && track.trim())
        ) {
          contractErrors.push(`Section ${index + 1} does not match the canonical contract`);
          return [];
        }
        return [{ name, energy, density, tracks }];
      })
    : [];
  if (!Array.isArray(record["sections"])) contractErrors.push("Provider response is missing sections");
  const candidates = Array.isArray(record["candidates"])
    ? record["candidates"].flatMap((value, index) => {
        if (!isRecord(value)) {
          contractErrors.push(`Candidate ${index + 1} must be an object`);
          return [];
        }
        const id = value["id"];
        const label = value["label"];
        const score = value["score"];
        const summary = value["summary"];
        if (
          typeof id !== "string" ||
          typeof label !== "string" ||
          typeof score !== "number" ||
          !Number.isFinite(score) ||
          typeof summary !== "string"
        ) {
          contractErrors.push(`Candidate ${index + 1} does not match the canonical contract`);
          return [];
        }
        return [{ id, label, score, summary, provider: provider.id }];
      })
    : [];
  if (!Array.isArray(record["candidates"])) contractErrors.push("Provider response is missing candidates");
  const trackModels = Array.isArray(record["trackModels"])
    ? record["trackModels"].flatMap((value, index) => {
        if (!isCanonicalTrackModel(value)) {
          contractErrors.push(`TrackModel ${index + 1} does not match the canonical contract`);
          return [];
        }
        return [value];
      })
    : undefined;
  return {
    provider,
    sections,
    candidates,
    trackModels,
    contractErrors,
  };
}

function isCanonicalTrackModel(value: unknown): value is TrackModel {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["instrument"] !== "string" || typeof value["role"] !== "string") return false;
  if (!Array.isArray(value["notes"]) || !Array.isArray(value["cc"]) || !Array.isArray(value["articulations"]) || !Array.isArray(value["automation"])) return false;
  const definition = value["instrumentDefinition"];
  const source = value["source"];
  const version = value["version"];
  const trackProvenance = value["provenance"];
  if (!isCanonicalInstrumentDefinition(definition) || typeof source !== "string" || typeof version !== "number" || !Number.isInteger(version) || version < 1 || !isCanonicalProvenance(trackProvenance)) return false;
  const min = definition["playableRange"]["min"];
  const max = definition["playableRange"]["max"];
  return value["notes"].every((note) =>
    isRecord(note) &&
    typeof note["id"] === "string" &&
    finite(note["start"], 0) &&
    finite(note["duration"], Number.EPSILON) &&
    integer(note["pitch"], Math.max(0, min), Math.min(127, max)) &&
    integer(note["velocity"], 0, 127) &&
    (note["channel"] === undefined || integer(note["channel"], 0, 15))) &&
  value["cc"].every((event) =>
    isRecord(event) &&
    integer(event["controller"], 0, 127) &&
    finite(event["time"], 0) &&
    finite(event["value"], 0, 127) &&
    (event["channel"] === undefined || integer(event["channel"], 0, 15))) &&
  value["articulations"].every((event) =>
    isRecord(event) &&
    finite(event["time"], 0) &&
    typeof event["name"] === "string" &&
    definition.articulations.includes(event["name"]) &&
    (event["keyswitch"] === undefined || integer(event["keyswitch"], 0, 127)) &&
    (event["intensity"] === undefined || finite(event["intensity"], 0, 1))) &&
  value["automation"].every((event) =>
    isRecord(event) &&
    typeof event["parameter"] === "string" &&
    finite(event["time"], 0) &&
    finite(event["value"], -1, 1));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Provider candidate field "${field}" must be a finite number`);
  }
  return value;
}
export async function syncModelRegistry(): Promise<void> {
  for (const provider of MUSIC_PROVIDERS) {
    await db.insert(modelRegistryTable).values(provider).onConflictDoUpdate({
      target: modelRegistryTable.id,
      set: {
        name: provider.name,
        provider: provider.provider,
        version: provider.version,
        capabilities: provider.capabilities,
        inputTypes: provider.inputTypes,
        execution: provider.execution,
        status: provider.status,
        license: provider.license,
        priority: provider.priority,
        notes: provider.notes,
        updatedAt: new Date(),
      },
    });
  }
}

export const musicProviderIds = [
  "BS_ROFORMER",
  "ALL_IN_ONE",
  "MT3",
  "BASIC_PITCH",
  "ACE_STEP",
  "ANYACCOMP",
  "SYMPHONYGEN",
  "METEOR",
  "MIDI_SAG",
] as const;

class HttpMusicGenerationProvider implements MusicGenerationProvider {
  readonly available: boolean;

  constructor(
    readonly definition: ProviderDefinition,
    private readonly endpoint: string | undefined,
    private readonly token: string | undefined,
  ) {
    this.available = Boolean(endpoint);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private normalizeResult(
    payload: unknown,
    input: ProviderGenerationInput,
  ): ProviderGenerationResult {
    if (!isRecord(payload) || !Array.isArray(payload["candidates"])) {
      throw new Error(`${this.definition.displayName} worker response is invalid`);
    }
    const sharedTrackModels = payload["trackModels"];
    const candidates = payload["candidates"]
      .slice(0, input.candidates)
      .map((candidate, index) =>
        normalizeCandidate(candidate, index, input, sharedTrackModels));
    if (candidates.length === 0) {
      throw new Error(`${this.definition.displayName} worker returned no candidates`);
    }
    return {
      requestId: typeof payload["requestId"] === "string" ? payload["requestId"] : null,
      modelVersion:
        typeof payload["modelVersion"] === "string"
          ? payload["modelVersion"]
          : this.definition.modelVersion,
      candidates,
    };
  }

  async generate(
    input: ProviderGenerationInput,
    onProgress?: (progress: ProviderProgress) => Promise<void>,
  ): Promise<ProviderGenerationResult> {
    if (!this.endpoint) {
      throw new Error(`${this.definition.displayName} worker is not configured`);
    }
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Idempotency-Key": input.jobId,
      },
      body: JSON.stringify({
        provider: this.definition.id,
        modelVersion: this.definition.modelVersion,
        ...input,
      }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!response.ok && response.status !== 202) {
      throw new Error(
        `${this.definition.displayName} worker returned HTTP ${response.status}`,
      );
    }
    const payload = await response.json() as unknown;
    if (response.status !== 202) {
      return this.normalizeResult(payload, input);
    }
    if (!isRecord(payload) || typeof payload["statusUrl"] !== "string") {
      throw new Error(
        `${this.definition.displayName} worker did not return a status URL`,
      );
    }
    const endpointUrl = new URL(this.endpoint);
    const statusUrl = new URL(payload["statusUrl"], endpointUrl);
    if (statusUrl.origin !== endpointUrl.origin) {
      throw new Error("Provider status URL must use the configured worker origin");
    }
    const requestId =
      typeof payload["requestId"] === "string" ? payload["requestId"] : undefined;
    await onProgress?.({ progress: 35, stage: "provider_queued", requestId });
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const statusResponse = await fetch(statusUrl, {
        headers: this.headers(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!statusResponse.ok) {
        throw new Error(
          `${this.definition.displayName} status returned HTTP ${statusResponse.status}`,
        );
      }
      const statusPayload = await statusResponse.json() as unknown;
      if (!isRecord(statusPayload)) {
        throw new Error(`${this.definition.displayName} status response is invalid`);
      }
      const progress = typeof statusPayload["progress"] === "number"
        ? Math.max(35, Math.min(90, Math.round(statusPayload["progress"])))
        : 50;
      const stage = typeof statusPayload["stage"] === "string"
        ? statusPayload["stage"]
        : "running_model";
      await onProgress?.({ progress, stage, requestId });
      if (statusPayload["status"] === "failed") {
        throw new Error(
          typeof statusPayload["error"] === "string"
            ? statusPayload["error"]
            : `${this.definition.displayName} worker failed`,
        );
      }
      if (statusPayload["status"] === "succeeded") {
        return this.normalizeResult(statusPayload, input);
      }
    }
    throw new Error(`${this.definition.displayName} worker timed out`);
  }
}

export type ProviderProgress = {
  progress: number;
  stage: string;
  requestId?: string;
};

export interface MusicGenerationProvider {
  readonly definition: ProviderDefinition;
  readonly available: boolean;
  generate(
    input: ProviderGenerationInput,
    onProgress?: (progress: ProviderProgress) => Promise<void>,
  ): Promise<ProviderGenerationResult>;
}

function routeScore(provider: MusicGenerationProvider, request: RoutingRequest): number {
  const definition = provider.definition;
  let score = 0;
  if (definition.tasks.includes(request.task)) score += 100;
  if (
    request.hardware === "AUTO" ||
    definition.hardware.includes(request.hardware)
  ) {
    score += 20;
  }
  if (definition.speeds.includes(request.speed)) score += 12;
  const style = request.style.toLowerCase();
  if (definition.styles.some((candidate) => style.includes(candidate))) score += 24;
  if (request.speed === "FAST" && definition.hardware.includes("CPU")) score += 4;
  if (request.speed === "QUALITY" && definition.hardware.includes("GPU")) score += 4;
  return score;
}

export function selectMusicProvider(
  registry: MusicGenerationProvider[],
  request: RoutingRequest,
): MusicGenerationProvider {
  const compatible = registry.filter((provider) => {
    const definition = provider.definition;
    return (
      provider.available &&
      definition.tasks.includes(request.task) &&
      definition.speeds.includes(request.speed) &&
      (request.hardware === "AUTO" ||
        definition.hardware.includes(request.hardware))
    );
  });
  if (request.requestedProvider) {
    const requested = compatible.find(
      (provider) => provider.definition.id === request.requestedProvider,
    );
    if (requested) return requested;
    throw new Error(
      `${request.requestedProvider} is unavailable or incompatible with ${request.task}`,
    );
  }
  const selected = compatible.sort(
    (left, right) => routeScore(right, request) - routeScore(left, request),
  )[0];
  if (!selected) {
    throw new Error(
      `No configured provider is available for ${request.task} (${request.hardware}, ${request.speed})`,
    );
  }
  return selected;
}

export const providerDefinitions: ProviderDefinition[] = [
  {
    id: "BS_ROFORMER",
    displayName: "BS-RoFormer",
    modelVersion: "bs-roformer-sw",
    tasks: ["SEPARATION"],
    hardware: ["GPU"],
    speeds: ["BALANCED", "QUALITY"],
    styles: [],
  },
  {
    id: "ALL_IN_ONE",
    displayName: "All-In-One",
    modelVersion: "all-in-one-infer",
    tasks: ["SEPARATION", "TRANSCRIPTION"],
    hardware: ["CPU", "GPU"],
    speeds: ["FAST", "BALANCED"],
    styles: [],
  },
  {
    id: "MT3",
    displayName: "MT3",
    modelVersion: "mt3-infer",
    tasks: ["TRANSCRIPTION"],
    hardware: ["GPU"],
    speeds: ["BALANCED", "QUALITY"],
    styles: [],
  },
  {
    id: "BASIC_PITCH",
    displayName: "Basic Pitch",
    modelVersion: "basic-pitch",
    tasks: ["TRANSCRIPTION"],
    hardware: ["CPU", "GPU"],
    speeds: ["FAST", "BALANCED"],
    styles: [],
  },
  {
    id: "ACE_STEP",
    displayName: "ACE-Step",
    modelVersion: "ace-step-1.5-base",
    tasks: ["ACCOMPANIMENT", "ARRANGEMENT"],
    hardware: ["GPU"],
    speeds: ["FAST", "BALANCED"],
    styles: ["pop", "electronic", "ambient", "cinematic"],
  },
  {
    id: "ANYACCOMP",
    displayName: "AnyAccomp",
    modelVersion: "anyaccomp",
    tasks: ["ACCOMPANIMENT", "ARRANGEMENT"],
    hardware: ["GPU"],
    speeds: ["BALANCED", "QUALITY"],
    styles: ["vocal", "solo", "acoustic"],
  },
  {
    id: "SYMPHONYGEN",
    displayName: "SymphonyGen",
    modelVersion: "symphonygen-2026",
    tasks: ["ORCHESTRATION", "ARRANGEMENT"],
    hardware: ["GPU"],
    speeds: ["BALANCED", "QUALITY"],
    styles: ["cinematic", "classical", "orchestral", "ensemble"],
  },
  {
    id: "METEOR",
    displayName: "METEOR",
    modelVersion: "meteor",
    tasks: ["ORCHESTRATION", "ARRANGEMENT"],
    hardware: ["CPU", "GPU"],
    speeds: ["FAST", "BALANCED", "QUALITY"],
    styles: ["orchestral", "re-orchestration", "score"],
  },
  {
    id: "MIDI_SAG",
    displayName: "MIDI-SAG",
    modelVersion: "configured-endpoint",
    tasks: ["ACCOMPANIMENT", "ORCHESTRATION", "ARRANGEMENT"],
    hardware: ["CPU", "GPU"],
    speeds: ["FAST", "BALANCED", "QUALITY"],
    styles: ["pop", "jazz", "classical", "cinematic", "orchestral"],
  },
];

export function createProviderRegistry(): MusicGenerationProvider[] {
  return providerDefinitions.map((definition) => {
    const key = providerEnvKey(definition.id);
    const endpoint =
      process.env[`MUSIC_PROVIDER_${key}_URL`] ??
      process.env["MUSIC_PROVIDER_GATEWAY_URL"];
    const token =
      process.env[`MUSIC_PROVIDER_${key}_TOKEN`] ??
      process.env["MUSIC_PROVIDER_GATEWAY_TOKEN"];
    return new HttpMusicGenerationProvider(definition, endpoint, token);
  });
}

export type GenerationSpeed = "FAST" | "BALANCED" | "QUALITY";

type ProviderDefinition = {
  id: MusicProviderId;
  displayName: string;
  modelVersion: string;
  tasks: MusicGenerationTask[];
  hardware: Exclude<GenerationHardware, "AUTO">[];
  speeds: GenerationSpeed[];
  styles: string[];
};

export type ProviderGenerationInput = {
  jobId: string;
  projectId: string;
  arrangementId: string;
  task: MusicGenerationTask;
  style: string;
  mode: string;
  hardware: GenerationHardware;
  speed: GenerationSpeed;
  candidates: number;
  seed: number;
  parameters: GenerationParameters;
  parentArtifactIds: string[];
  songModel: unknown;
  tracks: Array<{ id: string; name: string; role: string; instrument: string }>;
  arrangement: {
    version: number;
    harmonyComplexity: number;
    energy: number;
    density: number;
    orchestraSize: number;
    rhythmIntensity: number;
  };
};

export type GenerationHardware = "AUTO" | "CPU" | "GPU";

export type ProviderGenerationResult = {
  requestId: string | null;
  modelVersion: string;
  candidates: ProviderCandidate[];
};

export function providerCatalog(registry: MusicGenerationProvider[]) {
  return registry.map((provider) => ({
    id: provider.definition.id,
    name: provider.definition.displayName,
    modelVersion: provider.definition.modelVersion,
    tasks: provider.definition.tasks,
    hardware: provider.definition.hardware,
    speeds: provider.definition.speeds,
    available: provider.available,
  }));
}

function normalizeSections(value: unknown): ArrangementSection[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Provider candidate plan must contain at least one section");
  }
  return value.map((section, index) => {
    if (!isRecord(section)) {
      throw new Error(`Provider section ${index + 1} is invalid`);
    }
    const tracks = section["tracks"];
    if (!Array.isArray(tracks) || tracks.some((track) => typeof track !== "string")) {
      throw new Error(`Provider section ${index + 1} must contain track names`);
    }
    return {
      name: stringValue(section["name"], `sections[${index}].name`),
      energy: finiteNumber(section["energy"], `sections[${index}].energy`),
      density: finiteNumber(section["density"], `sections[${index}].density`),
      tracks,
    };
  });
}

export type MusicProviderId = (typeof musicProviderIds)[number];

type RoutingRequest = {
  requestedProvider?: MusicProviderId;
  task: MusicGenerationTask;
  style: string;
  hardware: GenerationHardware;
  speed: GenerationSpeed;
};

function normalizeCandidate(
  value: unknown,
  index: number,
  input: ProviderGenerationInput,
  sharedTrackModels?: unknown,
): ProviderCandidate {
  if (!isRecord(value)) throw new Error(`Provider candidate ${index + 1} is invalid`);
  const plan = value["plan"];
  if (!isRecord(plan)) throw new Error(`Provider candidate ${index + 1} has no plan`);
  const parameters = isRecord(value["parameters"])
    ? value["parameters"] as GenerationParameters
    : input.parameters;
  const parents = Array.isArray(value["parentArtifactIds"])
    ? value["parentArtifactIds"].filter((item): item is string => typeof item === "string")
    : input.parentArtifactIds;
  const rawTrackModels = value["trackModels"] ?? sharedTrackModels;
  let trackModels: TrackModel[] | undefined;
  if (rawTrackModels !== undefined && rawTrackModels !== null) {
    if (!Array.isArray(rawTrackModels)) {
      throw new Error(`Provider candidate ${index + 1} trackModels must be an array`);
    }
    const errors = validateCanonicalTrackModels(
      rawTrackModels,
      input.tracks.map((track) => track.id),
    );
    if (errors.length) {
      throw new Error(
        `Provider candidate ${index + 1} returned invalid TrackModels: ${errors.join("; ")}`,
      );
    }
    trackModels = rawTrackModels as TrackModel[];
  }
  return {
    providerRequestId:
      typeof value["providerRequestId"] === "string" ? value["providerRequestId"] : null,
    label: stringValue(value["label"], `candidates[${index}].label`),
    score: finiteNumber(value["score"], `candidates[${index}].score`),
    confidence: finiteNumber(
      value["confidence"],
      `candidates[${index}].confidence`,
    ),
    summary: stringValue(value["summary"], `candidates[${index}].summary`),
    plan: {
      sections: normalizeSections(plan["sections"]),
      tracks: Array.isArray(plan["tracks"])
        ? plan["tracks"].filter(isRecord).map((track) => ({
            id: stringValue(track["id"], "track.id"),
            name: stringValue(track["name"], "track.name"),
            role: stringValue(track["role"], "track.role"),
            kind: stringValue(track["kind"], "track.kind"),
          }))
        : undefined,
    },
    parameters,
    parentArtifactIds: parents,
    trackModels,
  };
}

export type ProviderCandidate = {
  providerRequestId: string | null;
  label: string;
  score: number;
  confidence: number;
  summary: string;
  plan: CandidatePlan;
  parameters: GenerationParameters;
  parentArtifactIds: string[];
  trackModels?: TrackModel[];
};

function providerEnvKey(id: MusicProviderId): string {
  return id.replace(/[^A-Z0-9]/g, "_");
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Provider candidate field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function isCanonicalProvenance(value: unknown): boolean {
  return isRecord(value) &&
    typeof value["model"] === "string" &&
    typeof value["version"] === "string" &&
    typeof value["createdBy"] === "string" &&
    isRecord(value["parameters"]) &&
    Array.isArray(value["parentIds"]) &&
    value["parentIds"].every((item) => typeof item === "string");
}

export function validateCanonicalTrackModels(
  values: unknown[],
  expectedTrackIds: string[],
): string[] {
  const errors: string[] = [];
  const tracks: TrackModel[] = [];
  values.forEach((value, index) => {
    if (!isCanonicalTrackModel(value)) {
      errors.push(`TrackModel ${index + 1} does not match the canonical contract`);
    } else {
      tracks.push(value);
    }
  });
  if (errors.length) return errors;
  const returnedIds = tracks.map((track) => track.id);
  if (new Set(returnedIds).size !== returnedIds.length) {
    errors.push("Provider returned duplicate TrackModel ids");
  }
  const expected = [...expectedTrackIds].sort();
  const returned = [...returnedIds].sort();
  if (
    expected.length !== returned.length ||
    expected.some((id, index) => id !== returned[index])
  ) {
    errors.push("TrackModels must map one-to-one to the requested project track ids");
  }
  for (const track of tracks) {
    const sortedNotes = [...track.notes].sort((left, right) => left.start - right.start);
    const allowedVoices = Math.min(
      track.instrumentDefinition.maxVoices,
      track.instrumentDefinition.constraints.maxSimultaneousNotes,
    );
    for (const note of sortedNotes) {
      const concurrent = sortedNotes.filter((other) =>
        other.start < note.start + note.duration &&
        other.start + other.duration > note.start).length;
      if (
        concurrent > allowedVoices ||
        (!track.instrumentDefinition.polyphonic && concurrent > 1)
      ) {
        errors.push(`${track.id} exceeds the instrument polyphony limit`);
        break;
      }
    }
    if (sortedNotes.some((note) =>
      note.duration < track.instrumentDefinition.constraints.minNoteDuration)) {
      errors.push(`${track.id} contains notes shorter than the instrument can perform`);
    }
    if (sortedNotes.some((note, noteIndex) => {
      const previous = sortedNotes[noteIndex - 1];
      return previous &&
        Math.abs(note.pitch - previous.pitch) >
          track.instrumentDefinition.constraints.maxLeap;
    })) {
      errors.push(`${track.id} contains an unplayable melodic leap`);
    }
    const breathSeconds = track.instrumentDefinition.constraints.breathSeconds;
    if (breathSeconds &&
      sortedNotes.some((note) => note.duration > breathSeconds)) {
      errors.push(`${track.id} contains a phrase longer than the instrument breath limit`);
    }
  }
  return errors;
}

function isCanonicalInstrumentDefinition(value: unknown): value is TrackModel["instrumentDefinition"] {
  if (!isRecord(value)) return false;
  const family = value["family"];
  const playable = value["playableRange"];
  const comfortable = value["comfortableRange"];
  const constraints = value["constraints"];
  const controls = value["controls"];
  if (
    typeof value["id"] !== "string" ||
    !["keys", "strings", "brass", "drums", "guitar", "voice", "synth"].includes(String(family)) ||
    !isRecord(playable) ||
    !isRecord(comfortable) ||
    !integer(playable["min"], 0, 127) ||
    !integer(playable["max"], playable["min"] as number, 127) ||
    !integer(comfortable["min"], playable["min"] as number, playable["max"] as number) ||
    !integer(comfortable["max"], comfortable["min"] as number, playable["max"] as number) ||
    typeof value["polyphonic"] !== "boolean" ||
    !integer(value["maxVoices"], 1, 128) ||
    !Array.isArray(value["registers"]) ||
    !value["registers"].every((register) =>
      isRecord(register) &&
      typeof register["name"] === "string" &&
      typeof register["character"] === "string" &&
      integer(register["min"], playable["min"] as number, playable["max"] as number) &&
      integer(register["max"], register["min"] as number, playable["max"] as number)) ||
    !Array.isArray(value["articulations"]) ||
    !value["articulations"].every((item) => typeof item === "string") ||
    !isRecord(constraints) ||
    !integer(constraints["maxLeap"], 1, 127) ||
    !finite(constraints["minNoteDuration"], Number.EPSILON) ||
    !integer(constraints["maxSimultaneousNotes"], 1, 128) ||
    !isRecord(controls) ||
    !Array.isArray(controls["dynamics"]) ||
    !controls["dynamics"].every((item) => integer(item, 0, 127)) ||
    !Array.isArray(controls["expression"]) ||
    !controls["expression"].every((item) => integer(item, 0, 127)) ||
    typeof controls["pitchBend"] !== "boolean" ||
    typeof controls["aftertouch"] !== "boolean"
  ) return false;
  for (const optional of ["breathSeconds", "strings", "frets", "hands", "feet"]) {
    if (constraints[optional] !== undefined && !finite(constraints[optional], Number.EPSILON)) return false;
  }
  if (controls["sustain"] !== undefined && !integer(controls["sustain"], 0, 127)) return false;
  return true;
}

function finite(value: unknown, min: number, max = Number.POSITIVE_INFINITY): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}
