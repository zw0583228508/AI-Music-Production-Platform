import type {
  AnalysisSection,
  ModelCapability,
  SongModelData,
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
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("BS_ROFORMER") ? "configured" : "unavailable",
    license: "Model-specific",
    priority: 100,
    notes: "Requires BS_ROFORMER_API_URL; outputs private, aligned stem object paths.",
  },
  {
    id: "SHEET_SAGE",
    name: "SheetSage",
    provider: "Research model",
    version: "configured-endpoint",
    capabilities: ["harmony"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "SOLO_INSTRUMENT", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("SHEET_SAGE") ? "configured" : "unavailable",
    license: "Model-specific",
    priority: 95,
    notes: "Requires SHEET_SAGE_API_URL; returns timed chord evidence and confidence.",
  },
];

export function selectArrangementProvider(
  requested: string | undefined,
  sourceType: string,
): MusicProviderDescriptor {
  if (requested && requested !== "CUSTOM") {
    const exact = MUSIC_PROVIDERS.find((provider) => provider.id === requested);
    if (!exact || exact.status === "unavailable") {
      throw new ProviderUnavailableError(requested);
    }
    return exact;
  }

  return MUSIC_PROVIDERS
    .filter((provider) =>
      provider.capabilities.includes("arrangement") &&
      provider.inputTypes.includes(sourceType) &&
      provider.status !== "unavailable")
    .sort((left, right) => left.priority - right.priority)[0]
    ?? MUSIC_PROVIDERS.find((provider) => provider.id === "LOCAL_SYMBOLIC_DIRECTOR_V1")!;
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
  return { provider, sections, candidates, contractErrors: [] };
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
  return {
    provider,
    sections,
    candidates,
    contractErrors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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