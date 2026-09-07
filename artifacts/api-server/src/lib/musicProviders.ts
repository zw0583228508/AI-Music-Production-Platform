import type {
  AnalysisSection,
  ArrangementSection,
  CandidatePlan,
  GenerationParameters,
  MusicGenerationTask,
  ModelCapability,
  ProviderRuntimeSnapshot,
  SongModelData,
  TrackModel,
  AceStepOperation,
  AceStepRegion,
} from "@workspace/db";
import { db, modelRegistryTable } from "@workspace/db";
import { attestAnalysisProviderHealth } from "./analysisProviderManifest";
import {
  anyAccompCommercialUseAuthorized,
  expectedGpuContainerDigest,
  expectedGpuCheckpointSha256,
  expectedGpuModalImageId,
  expectedGpuModelVersion,
  expectedGpuSourceImageDigest,
  expectedGpuPromotionRecord,
  gpuPromotionAttestationFailure,
  canonicalGpuPromotionJson,
  isGpuAttestedProvider,
  requiresGpuPromotionRecord,
} from "./gpuProviderAttestation";
export {
  anyAccompCommercialUseAuthorized,
  expectedGpuContainerDigest,
  expectedGpuCheckpointSha256,
  expectedGpuModalImageId,
  expectedGpuModelVersion,
  expectedGpuSourceImageDigest,
  expectedGpuPromotionRecord,
  gpuPromotionAttestationFailure,
  canonicalGpuPromotionJson,
  isGpuAttestedProvider,
  requiresGpuPromotionRecord,
} from "./gpuProviderAttestation";
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

export type ProviderReadiness = ProviderRuntimeSnapshot & {
  configured: boolean;
  checkpoint: {
    required: boolean;
    configured: boolean;
    ready: boolean;
  };
  runtime: {
    ready: boolean;
    execution: "local" | "remote";
  };
  health: {
    status: ProviderRuntimeSnapshot["healthStatus"];
    checkedAt: string | null;
    latencyMs: number | null;
    message: string | null;
  };
};

type ProviderDescriptorCatalogEntry = MusicProviderDescriptor & {
  configured: boolean;
  checkpointReady: boolean;
  runtimeReady: boolean;
  packageReady: boolean;
  smokeTested: boolean;
  reportedVersion: string | null;
  lastHealth: {
    status: ProviderRuntimeSnapshot["healthStatus"];
    checkedAt: string | null;
    latencyMs: number | null;
    message: string | null;
  };
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
    super(`Provider ${providerId} is unavailable (not configured or available)`);
  }
}

const LICENSE_BLOCKED_PROVIDER_IDS = new Set<string>(["BS_ROFORMER"]);
const RESEARCH_ONLY_PROVIDER_IDS = new Set<string>(["LADA_BAND", "DIFFRHYTHM_2"]);

const UPSTREAM_BLOCKED_PROVIDER_IDS = new Set<string>(["MIDI_SAG"]);
function providerRoutingAuthorized(providerId: string): boolean {
  return !LICENSE_BLOCKED_PROVIDER_IDS.has(providerId) &&
    !UPSTREAM_BLOCKED_PROVIDER_IDS.has(providerId) &&
    !MISSING_LICENSED_ASSET_PROVIDER_IDS.has(providerId) &&
    !RESEARCH_ONLY_PROVIDER_IDS.has(providerId) &&
    (providerId !== "ANYACCOMP" || anyAccompCommercialUseAuthorized());
}

function assertProviderCommercialUseAuthorized(providerId: string): void {
  if (LICENSE_BLOCKED_PROVIDER_IDS.has(providerId)) {
    throw new ProviderUnavailableError(
      `${providerId} (BLOCKED_LICENSE until checkpoint-owner rights are verified)`,
    );
  }
  if (UPSTREAM_BLOCKED_PROVIDER_IDS.has(providerId)) {
    throw new ProviderUnavailableError(
      "MIDI_SAG (BLOCKED_UPSTREAM: pinned source lacks the required production adapter)",
    );
  }
  if (MISSING_LICENSED_ASSET_PROVIDER_IDS.has(providerId)) {
    throw new ProviderUnavailableError(
      "MUSE_CONTROL_LITE (BLOCKED_MISSING_LICENSED_ASSET: required licensed asset is unavailable)",
    );
  }
  if (RESEARCH_ONLY_PROVIDER_IDS.has(providerId)) {
    throw new ProviderUnavailableError(
      `${providerId} (non-commercial research-only provider is excluded from production routing)`,
    );
  }
  if (providerId === "ANYACCOMP" && !anyAccompCommercialUseAuthorized()) {
    throw new ProviderUnavailableError(
      "ANYACCOMP (commercial-use authorization is required)",
    );
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
    id: "MUSICGEN",
    name: "MusicGen",
    provider: "Meta AudioCraft",
    version: "configured-endpoint",
    capabilities: ["arrangement", "audio_generation"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "INSTRUMENTAL", "MIDI"],
    execution: "remote",
    status: remoteConfigured("MUSICGEN") ? "configured" : "unavailable",
    license: "Model-specific",
    priority: 35,
    notes: "Requires MUSICGEN_API_URL and a verified GPU worker checkpoint.",
  },
  {
    id: "STABLE_AUDIO_3_SMALL_MUSIC",
    name: "Stable Audio 3 Small Music",
    provider: "Stability AI",
    version: "0fef1392cd842149a2b6d445e181c97608faac06",
    capabilities: ["audio_generation"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL"],
    execution: "remote",
    // A configured endpoint is deliberately not treated as READY. The worker
    // independently verifies license acceptance, pinned source/snapshot files,
    // runtime, and a non-silent artifact smoke proof.
    status: remoteConfigured("STABLE_AUDIO_3_SMALL_MUSIC") &&
      process.env.STABILITY_AI_LICENSE_ACCEPTED === "true" ? "configured" : "unavailable",
    license: "Stability AI Community License (gated weights)",
    priority: 36,
    notes: "Isolated Small Music identity. Requires STABLE_AUDIO_3_SMALL_MUSIC_API_URL, bearer authentication, Stability license acceptance, private source/model/artifact volumes, immutable source 779434a908193105335fd8d833418603625b2859 and snapshot 0fef1392cd842149a2b6d445e181c97608faac06. Exposes prompt, duration, initAudio, initNoiseLevel, inpaintStart, inpaintEnd, loraPath, and loraStrength; never READY from catalog configuration alone.",
  },
  {
    id: "STABLE_AUDIO_3_MEDIUM",
    name: "Stable Audio 3 Medium",
    provider: "Stability AI",
    version: "27b5a21b791b1b033d193a9e1e3ce78493f102f9",
    capabilities: ["audio_generation"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL"],
    execution: "remote",
    status: remoteConfigured("STABLE_AUDIO_3_MEDIUM") &&
      process.env.STABILITY_AI_LICENSE_ACCEPTED === "true" ? "configured" : "unavailable",
    license: "Stability AI Community License (gated weights)",
    priority: 37,
    notes: "Isolated Medium identity. Requires STABLE_AUDIO_3_MEDIUM_API_URL, bearer authentication, Stability license acceptance, private source/model/artifact volumes, immutable source 779434a908193105335fd8d833418603625b2859 and snapshot 27b5a21b791b1b033d193a9e1e3ce78493f102f9. Exposes prompt, duration, initAudio, initNoiseLevel, inpaintStart, inpaintEnd, loraPath, and loraStrength; never READY from catalog configuration alone.",
  },
  {
    id: "DIFFRHYTHM_2",
    name: "DiffRhythm 2",
    provider: "Xiaomi Research / ASLP Lab",
    version: "13a7b091f45124f611e36ee674973234f38d55b6",
    capabilities: ["audio_generation"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "INSTRUMENTAL"],
    execution: "remote",
    status: remoteConfigured("DIFFRHYTHM2") ? "configured" : "unavailable",
    license: "Apache-2.0 source and DiffRhythm weights; CC-BY-NC-4.0 MuQ weights",
    priority: 36,
    notes: "RESEARCH_READY only after signed promotion. MuQ-MuLan and its base MuQ weights are CC-BY-NC-4.0, so commercial production routing remains fail closed even when the isolated endpoint, immutable assets, and real smoke evidence verify.",
  },
  {
    id: "ANYACCOMP",
    name: "AnyAccomp",
    provider: "AnyAccomp",
    version: "anyaccomp-2025-12-22",
    capabilities: ["audio_generation"],
    inputTypes: ["VOCAL_ONLY"],
    execution: "remote",
    status: remoteConfigured("ANYACCOMP") ? "configured" : "unavailable",
    license: "MIT source; CC-BY-4.0 model",
    priority: 40,
    notes: "Dedicated V2A worker only. Requires ANYACCOMP_API_URL, bearer authentication, exact source/VQ/Flow-Matching/Vocoder inventory, and a real non-copy/non-silence source-conditioned smoke proof. It is not an arrangement-plan provider.",
  },
  {
    id: "LADA_BAND",
    name: "LaDA-Band",
    provider: "Duoluoluos / TME",
    version: "6d444caee85385677b0652ecb0b2b8220436dd37",
    capabilities: ["arrangement"],
    inputTypes: ["VOCAL_ONLY"],
    execution: "remote",
    status: "unavailable",
    license: "UNVERIFIED first-party source/model rights",
    priority: 41,
    notes: "BLOCKED_LICENSE: the first-party source has no owner-specified license, the license=other model revision requires manual approval, and no accepted-account or complete bundled-weight grant is retained. Endpoint, token, and acceptance environment values cannot authorize routing.",
  },
  {
    id: "HAFM",
    name: "HAFM",
    provider: "HackerHyper",
    version: "1653c3c7bffdc9b4b2d57d8b6e4f5bb3002a64fe",
    capabilities: ["arrangement"],
    inputTypes: ["VOCAL_ONLY"],
    execution: "remote",
    status: remoteConfigured("HAFM") ? "configured" : "unavailable",
    license: "Apache-2.0",
    priority: 42,
    notes: "Alternative vocal-to-instrumental accompaniment provider. Requires HAFM_API_URL, bearer authentication, immutable assets, real-audio smoke, and signed GPU deployment evidence.",
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
    version: "blocked-upstream",
    capabilities: ["arrangement", "orchestration"],
    inputTypes: ["VOCAL_ONLY", "SOLO_INSTRUMENT", "MIDI"],
    execution: "remote",
    status: "unavailable",
    license: "Apache-2.0 source; required asset licenses unresolved",
    priority: 65,
    notes: "BLOCKED_UPSTREAM. The pinned source lacks the required production adapter; endpoint and token environment variables cannot enable routing.",
  },
  {
    id: "MUSE_CONTROL_LITE",
    name: "MuseControlLite",
    provider: "MIDI-SAG packaged MuseControlLite",
    version: "blocked-missing-licensed-asset",
    capabilities: ["audio_generation"],
    inputTypes: ["MIDI", "VOCAL_ONLY", "INSTRUMENTAL"],
    execution: "remote",
    status: "unavailable",
    license: "BLOCKED_MISSING_LICENSED_ASSET: required asset license and artifact are unavailable",
    priority: 66,
    notes: "BLOCKED_MISSING_LICENSED_ASSET. This packaged MIDI-SAG identity cannot route until its required licensed asset is acquired and verified.",
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
    status: remoteConfigured("SFIZZ_RENDER") ? "configured" : "unavailable",
    license: "VSCO 2 CE / sfizz terms",
    priority: 66,
    notes: "Requires SFIZZ_RENDER_API_URL and a worker-attested licensed SFZ library/native host.",
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
    license: "MT3 upstream: Apache-2.0; converted checkpoint: NOASSERTION",
    priority: 80,
    notes: "Requires MT3_API_URL, a signed promotion record, and the exact verified converted checkpoint; consumes signed private source URLs.",
  },
  {
    id: "MR_MT3",
    name: "MR-MT3",
    provider: "OpenMIRLab / MT3",
    version: "mr-mt3",
    capabilities: ["transcription"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("MR_MT3") ? "configured" : "unavailable",
    license: "MIT",
    priority: 81,
    notes: "Speed-optimized transcription adapter. Installed from OpenMIRLab mt3-infer revision 280a95817a67da0ae46987ddbb18c946963afffe with the MIT-licensed gudgud1014/MR-MT3 checkpoint pinned at 539c08b0fe551076db6108a5f5b2a57d774881ed (SHA-256 b8a3807ed265059abd25ad7f68142c06c35e8f6144dcaa45bd55946a3745398f); requires MR_MT3_API_URL. Catalog configuration never implies readiness: live health and signed promotion verification are required.",
  },
  {
    id: "YOUR_MT3",
    name: "YourMT3",
    provider: "OpenMIRLab / MT3",
    version: "your-mt3",
    capabilities: ["transcription"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: "unavailable",
    license: "Apache-2.0",
    priority: 82,
    notes: "Multitask transcription adapter. Unavailable until the mutable upstream artifact hash and immutable revision are independently reviewed and signed promotion evidence succeeds.",
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
    license: "CC-BY-NC-SA-4.0 (structure weights) + MIT (Demucs)",
    priority: 90,
    notes: "Requires ALL_IN_ONE_API_URL and the verified eight-fold Harmonix ensemble plus HTDemucs checkpoint set; consumes signed private source URLs.",
  },
  {
    id: "BS_ROFORMER",
    name: "BS-RoFormer",
    provider: "Research model",
    version: "bs-roformer-viperx-v1",
    capabilities: ["separation"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: "unavailable",
    license: "UNVERIFIED checkpoint rights",
    priority: 100,
    notes: "BLOCKED_LICENSE: the MIT label belongs to an unofficial wrapper, not a retained checkpoint-owner redistribution or commercial-use grant. Endpoint aliases cannot configure or route this provider.",
  },
  {
    id: "DEMUCS",
    name: "DEMUCS",
    provider: "Meta Research",
    version: "configured-endpoint",
    capabilities: ["separation"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("DEMUCS") ? "configured" : "unavailable",
    license: "Model-specific",
    priority: 95,
    notes: "Requires DEMUCS_API_URL; preferred separation provider and returns stems copied into private analysis storage.",
  },
  {
    id: "SHEETSAGE",
    name: "SheetSage",
    provider: "Research model",
    version: "0.2.1",
    capabilities: ["transcription", "harmony", "structure"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: process.env.SHEETSAGE_LICENSE_AUTHORIZED === "true" &&
      (remoteConfigured("SHEETSAGE") || remoteConfigured("SHEET_SAGE"))
      ? "configured"
      : "unavailable",
    license: "CC-BY-NC-SA-3.0 weights; CC-BY-NC-SA-4.0 downbeat weights",
    priority: 110,
    notes: "RESEARCH_READY only: exact source and asset identities, persistent signed real-audio smoke, live health, and the Node melody/harmony/timing path were verified. Non-commercial/share-alike weights prohibit commercial routing.",
  },
  ...[
    ["MOSS_MUSIC_INSTRUCT", "MOSS-Music 8B Instruct", "Direct musical semantic reasoning"],
    ["MOSS_MUSIC_THINKING", "MOSS-Music 8B Thinking", "Deliberate musical semantic reasoning"],
  ].map(([id, name, role], index): MusicProviderDescriptor => ({
    id,
    name,
    provider: "OpenMOSS MOSS-Music",
    version: "ad107c7ddaa06de168a0dfbc18d3e1e6a40c0e5e",
    capabilities: ["structure", "harmony", "transcription"],
    inputTypes: ["FULL_SONG", "VOCAL_ONLY", "SOLO_INSTRUMENT", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured(id) || remoteConfigured("MOSS_MUSIC") ? "configured" : "unavailable",
    license: "Apache-2.0",
    priority: 121 + index,
    notes: `${role}; currently BLOCKED_UPSTREAM because the exact clean dependency graph fails native TorchCodec 0.8.0 WAV/MP3 preflight at libtorchcodec_custom_ops7.so. Any future endpoint must still pass exact health attestation. Output is MUSICAL_SEMANTIC_REASONING only and never canonical analysis truth.`,
  })),
  ...[
    ["MADMOM", "Madmom Rhythm Evidence", "structure", "CC-BY-NC-SA-4.0 weights"],
    ["TORCHCREPE", "TorchCREPE Pitch Evidence", "transcription", "MIT"],
    ["ESSENTIA", "Essentia Key/HPCP Evidence", "harmony", "AGPL-3.0-only"],
    ["PYLOUDNORM", "pyloudnorm Loudness Evidence", "structure", "MIT"],
  ].map(([id, name, capability, license], index): MusicProviderDescriptor => ({
    id,
    name,
    provider: id,
    version: "health-attested",
    capabilities: [capability as ModelCapability],
    inputTypes: id === "TORCHCREPE"
      ? ["VOCAL_ONLY", "SOLO_INSTRUMENT"]
      : ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: (
      remoteConfigured(id) ||
      remoteConfigured(id === "ESSENTIA" ? "MUSIC_MIR_ESSENTIA" : "MUSIC_MIR")
    ) ? "configured" : "unavailable",
    license,
    priority: 111 + index,
    notes: `Requires provider-specific ${id}_API_URL (or its MIR runtime URL) and strict runtime/package/smoke attestation.`,
  })),
  {
    id: "CHROMA",
    name: "Chroma Harmony Evidence",
    provider: "Configured analysis service",
    version: "configured-endpoint",
    capabilities: ["harmony"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "VIDEO"],
    execution: "remote",
    status: remoteConfigured("CHROMA") || remoteConfigured("MUSIC_MIR_ESSENTIA")
      ? "configured"
      : "unavailable",
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
  {
    id: "CLAMP3",
    name: "CLaMP 3 Cross-Modal Similarity",
    provider: "Sander Wood / research model",
    version: "355625cc1c6f73726bbcd0eb9276ac7152d56426",
    capabilities: ["structure"],
    inputTypes: ["FULL_SONG", "INSTRUMENTAL", "MIDI"],
    execution: "remote",
    status: remoteConfigured("CLAMP3") ? "configured" : "unavailable",
    license: "MIT model; CC-BY-NC-4.0 raw-audio dependency",
    priority: 140,
    notes: "Non-commercial research-only cross-modal similarity. Requires CLAMP3_API_URL, exact immutable assets, and persisted real GPU smoke evidence.",
  },
];

export function providerDescriptorCatalog(): ProviderDescriptorCatalogEntry[] {
  return MUSIC_PROVIDERS.map((provider) => {
    const status = provider.id === "ANYACCOMP" && !anyAccompCommercialUseAuthorized()
      ? "unavailable"
      : ["BASIC_PITCH", "DEMUCS", "MADMOM", "TORCHCREPE", "ESSENTIA", "CHROMA", "PYLOUDNORM"].includes(provider.id)
      ? remoteConfigured(provider.id) ? "configured" : "unavailable"
      : provider.status;
    const localReady = provider.execution === "local" && status === "ready";
    const configured = localReady || status === "configured";
    return {
      ...provider,
      status,
      configured,
      checkpointReady: localReady,
      runtimeReady: localReady,
      packageReady: localReady,
      smokeTested: localReady,
      reportedVersion: localReady ? provider.version : null,
      lastHealth: {
        status: localReady ? "healthy" as const : "unknown" as const,
        checkedAt: localReady ? new Date(0).toISOString() : null,
        latencyMs: localReady ? 0 : null,
        message: localReady
          ? "Local runtime is built into the API worker."
          : configured
            ? "Configured endpoint has not passed a runtime health check."
            : "Provider endpoint is not configured.",
      },
    };
  });
}

async function verifyAnalysisProviderHealth(
  provider: ProviderDescriptorCatalogEntry,
): Promise<ProviderDescriptorCatalogEntry> {
  if (
    !provider.configured ||
    !["BASIC_PITCH", "DEMUCS", "MADMOM", "TORCHCREPE", "ESSENTIA", "CHROMA", "PYLOUDNORM",
      "MR_MT3", "MOSS_MUSIC_INSTRUCT", "MOSS_MUSIC_THINKING"].includes(provider.id)
  ) {
    return provider;
  }
  const endpoint = provider.id === "MR_MT3"
    ? process.env.MR_MT3_API_URL
    : process.env[`MUSIC_PROVIDER_${provider.id}_URL`] ??
      process.env[`${provider.id}_API_URL`] ??
        (provider.id.startsWith("MOSS_MUSIC_") ? process.env.MOSS_MUSIC_API_URL : undefined) ??
      process.env[
        ["ESSENTIA", "CHROMA"].includes(provider.id)
          ? "MUSIC_MIR_ESSENTIA_API_URL"
          : "MUSIC_MIR_API_URL"
      ];
  if (!endpoint) return provider;
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const healthUrl = new URL("/health", endpoint);
    healthUrl.searchParams.set("provider", provider.id);
    const analysisToken = process.env[`${provider.id}_API_TOKEN`] ??
      process.env.MUSIC_AI_WORKER_TOKEN;
    const response = await fetch(healthUrl, {
      headers: analysisToken
        ? { Authorization: `Bearer ${analysisToken}` }
        : undefined,
      signal: AbortSignal.timeout(providerHealthTimeoutMs(provider.id)),
    });
    if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    if (!isRecord(payload)) throw new Error("health response must be a JSON object");
    const runtimeReady = payload["runtimeReady"] === true;
    const checkpointReady = payload["checkpointReady"] === true;
    const packageReady = payload["packageReady"] === true;
    const smokeTested = payload["smokeTested"] === true;
    const reportedVersion = typeof payload["modelVersion"] === "string" &&
      payload["modelVersion"].trim()
      ? payload["modelVersion"].trim()
      : null;
    let ready = false;
    try {
      attestAnalysisProviderHealth(provider.id, payload, endpoint);
      ready = true;
    } catch {
      // The descriptor remains configured until the full attestation passes.
    }
    const message = ready
      ? "Checkpoint, runtime, checksum, and smoke test are verified."
      : "Configured analysis worker health response did not satisfy the readiness contract.";
    return {
      ...provider,
      status: ready ? "ready" : "configured",
      checkpointReady,
      runtimeReady,
      packageReady,
      smokeTested,
      reportedVersion,
      lastHealth: {
        status: ready ? "healthy" : "unhealthy",
        checkedAt,
        latencyMs: Math.max(0, Date.now() - startedAt),
        message,
      },
    };
  } catch (error) {
    return {
      ...provider,
      status: "configured",
      checkpointReady: false,
      runtimeReady: false,
      packageReady: false,
      smokeTested: false,
      reportedVersion: null,
      lastHealth: {
        status: "unhealthy",
        checkedAt,
        latencyMs: Math.max(0, Date.now() - startedAt),
        message: error instanceof Error
          ? `Provider health check failed: ${error.message}`
          : "Provider health check failed.",
      },
    };
  }
}

export async function verifiedProviderDescriptorCatalog() {
  const descriptors = await Promise.all(
    providerDescriptorCatalog().map(verifyAnalysisProviderHealth),
  );
  const generationRegistry = await verifyProviderRegistry();
  const byId = new Map(descriptors.map((provider) => [provider.id, provider]));
  for (const generationProvider of generationRegistry) {
    const definition = generationProvider.definition;
    const readiness = generationProvider.readiness;
    const existing = byId.get(definition.id);
    byId.set(definition.id, {
      id: definition.id,
      name: definition.displayName,
      provider: existing?.provider ?? definition.displayName,
      version: definition.modelVersion,
      capabilities: [...new Set(definition.tasks.map(taskCapability))],
      inputTypes: existing?.inputTypes ?? ["Song Model", "Arrangement"],
      execution: "remote",
      status: readiness.availability,
      configured: readiness.configurationReady,
      checkpointReady: readiness.checkpointReady,
      runtimeReady: readiness.runtimeReady,
      packageReady: readiness.runtimeReady,
      smokeTested: readiness.smokeTested,
      reportedVersion: readiness.reportedVersion,
      lastHealth: {
        status: readiness.healthStatus,
        checkedAt: readiness.checkedAt,
        latencyMs: readiness.latencyMs,
        message: readiness.message,
      },
      license: existing?.license ?? "Provider terms",
      priority: existing?.priority ?? 100,
      notes: existing?.notes ??
        "Provider-backed generation runtime; readiness requires a verified checkpoint and worker health result.",
    });
  }
  return [...byId.values()];
}

export class ModelRouter {
  select(
    requested: string | undefined,
    sourceType: string,
    context?: { style?: string; mode?: string; hasExistingArrangement?: boolean },
  ): MusicProviderDescriptor {
    if (requested && requested !== "CUSTOM") {
      assertProviderCommercialUseAuthorized(requested);
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
        ? ["ACE_STEP_COMPLETE", "MIDI_SAG"]
        : style.includes("cinematic") || style.includes("orchestra")
          ? ["SYMPHONYGEN", "METEOR"]
          : sourceType === "MIDI"
            ? ["MIDI_SAG", "SYMPHONYGEN", "METEOR"]
            : ["ACE_STEP_BASE", "SYMPHONYGEN"];
    for (const id of preferredIds) {
      const provider = MUSIC_PROVIDERS.find((candidate) =>
        candidate.id === id &&
        (candidate.id !== "ANYACCOMP" || anyAccompCommercialUseAuthorized()) &&
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
  if (providerId === "ACE_STEP_BASE") return "ACE_STEP";
  if (providerId === "DIFFRHYTHM_2") return "DIFFRHYTHM2";
  return providerId;
}

function remoteProviderEndpoint(providerId: string): string | undefined {
  if (!providerRoutingAuthorized(providerId)) return undefined;
  const prefix = remoteEnvironmentPrefix(providerId);
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  return process.env[`MUSIC_PROVIDER_${key}_URL`] ??
    process.env["MUSIC_PROVIDER_GATEWAY_URL"] ??
    process.env[`${prefix}_API_URL`];
}

function remoteProviderToken(providerId: string): string | undefined {
  if (!providerRoutingAuthorized(providerId)) return undefined;
  const prefix = remoteEnvironmentPrefix(providerId);
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  return process.env[`MUSIC_PROVIDER_${key}_TOKEN`] ??
    process.env["MUSIC_PROVIDER_GATEWAY_TOKEN"] ??
    process.env[`${prefix}_API_TOKEN`] ??
    process.env.MUSIC_AI_WORKER_TOKEN;
}

export async function cancelRemoteProviderJob(
  providerId: string,
  cancelUrlValue: string,
): Promise<void> {
  assertProviderCommercialUseAuthorized(providerId);
  const endpoint = remoteProviderEndpoint(providerId);
  if (!endpoint) throw new Error(`${providerId} worker is not configured`);
  const endpointUrl = new URL(endpoint);
  const cancelUrl = new URL(cancelUrlValue, endpointUrl);
  if (cancelUrl.origin !== endpointUrl.origin) {
    throw new Error("Provider cancellation URL must use the configured worker origin");
  }
  const token = remoteProviderToken(providerId);
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(cancelUrl, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    lastStatus = response.status;
    if (response.ok || response.status === 404) return;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error(`Provider cancellation was not acknowledged (HTTP ${lastStatus})`);
}

export class ProviderCancellationAcknowledgedError extends Error {}
export class ProviderCancellationUnconfirmedError extends Error {}

export async function runArrangementProvider(
  provider: MusicProviderDescriptor,
  input: ArrangementProviderInput,
): Promise<ArrangementProviderOutput> {
  assertProviderCommercialUseAuthorized(provider.id);
  if (provider.execution === "local") {
    return generateLocalArrangement(provider, input);
  }

  const endpoint = remoteProviderEndpoint(provider.id);
  if (!endpoint) throw new ProviderUnavailableError(provider.id);
  const token = remoteProviderToken(provider.id);
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

function reportedMaximumCandidates(payload: Record<string, unknown>): number | null {
  const value = payload["maximumCandidates"] ?? payload["maxCandidates"] ??
    payload["candidateLimit"];
  return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 5
    ? value
    : null;
}
export async function syncModelRegistry(): Promise<void> {
  for (const provider of MUSIC_PROVIDERS) {
    const localReady = provider.execution === "local" && provider.status === "ready";
    const configurationReady = localReady || provider.status === "configured";
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
        configurationReady,
        checkpointReady: localReady,
        runtimeReady: localReady,
        healthStatus: localReady ? "healthy" : "unknown",
        healthCheckedAt: localReady ? new Date() : null,
        healthLatencyMs: localReady ? 0 : null,
        healthMessage: localReady
          ? "Local runtime is built into the API worker."
          : configurationReady
            ? "Configured endpoint has not passed a runtime health check."
            : "Provider endpoint is not configured.",
        reportedVersion: localReady ? provider.version : null,
        license: provider.license,
        priority: provider.priority,
        notes: provider.notes,
        updatedAt: new Date(),
      },
    });
  }
  const generationProviders = await verifyProviderRegistry(
    createProviderRegistry(),
    true,
  );
  for (const provider of generationProviders) {
    const snapshot = provider.readiness;
    const capabilities = provider.definition.tasks.map(taskCapability);
    await db.insert(modelRegistryTable).values({
      id: provider.definition.id,
      name: provider.definition.displayName,
      provider: provider.definition.displayName,
      version: provider.definition.modelVersion,
      capabilities: [...new Set(capabilities)],
      inputTypes: [],
      execution: "remote",
      status: snapshot.availability,
      configurationReady: snapshot.configurationReady,
      checkpointReady: snapshot.checkpointReady,
      runtimeReady: snapshot.runtimeReady,
      healthStatus: snapshot.healthStatus,
      healthCheckedAt: snapshot.checkedAt ? new Date(snapshot.checkedAt) : null,
      healthLatencyMs: snapshot.latencyMs,
      healthMessage: snapshot.message,
      reportedVersion: snapshot.reportedVersion,
      license: "Provider terms",
      priority: 100,
      notes: "Provider-backed generation runtime; readiness requires a verified checkpoint and worker health result.",
    }).onConflictDoUpdate({
      target: modelRegistryTable.id,
      set: {
        name: provider.definition.displayName,
        provider: provider.definition.displayName,
        version: provider.definition.modelVersion,
        capabilities: [...new Set(capabilities)],
        execution: "remote",
        status: snapshot.availability,
        configurationReady: snapshot.configurationReady,
        checkpointReady: snapshot.checkpointReady,
        runtimeReady: snapshot.runtimeReady,
        healthStatus: snapshot.healthStatus,
        healthCheckedAt: snapshot.checkedAt ? new Date(snapshot.checkedAt) : null,
        healthLatencyMs: snapshot.latencyMs,
        healthMessage: snapshot.message,
        reportedVersion: snapshot.reportedVersion,
        updatedAt: new Date(),
      },
    });
  }
}

function taskCapability(task: MusicGenerationTask): ModelCapability {
  switch (task) {
    case "SEPARATION":
      return "separation";
    case "TRANSCRIPTION":
      return "transcription";
    case "ORCHESTRATION":
      return "orchestration";
    case "ACCOMPANIMENT":
    case "ARRANGEMENT":
      return "arrangement";
  }
}

export const musicProviderIds = [
  "BS_ROFORMER",
  "ALL_IN_ONE",
  "MT3",
  "MUSICGEN",
  "BASIC_PITCH",
  "ACE_STEP",
  "ANYACCOMP",
  "LADA_BAND",
  "HAFM",
  "SYMPHONYGEN",
  "METEOR",
  "MIDI_SAG",
  "MUSE_CONTROL_LITE",
  "STABLE_AUDIO_3_SMALL_MUSIC",
  "STABLE_AUDIO_3_MEDIUM",
] as const;

export class HttpMusicGenerationProvider implements MusicGenerationProvider {
  readiness: ProviderRuntimeSnapshot;
  private attestedChecksum: string | null = null;

  constructor(
    readonly definition: ProviderDefinition,
    private readonly endpoint: string | undefined,
    private readonly token: string | undefined,
  ) {
    const routingAuthorized = providerRoutingAuthorized(definition.id);
    const cached = routingAuthorized && endpoint
      ? providerHealthCache.get(`${definition.id}:${endpoint}`)
      : undefined;
    this.readiness = routingAuthorized
      ? cached?.snapshot ?? initialProviderReadiness(Boolean(endpoint))
      : blockedProviderReadiness(definition.id);
  }

  get available(): boolean {
    return this.readiness.availability === "ready";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async checkHealth(force = false): Promise<ProviderRuntimeSnapshot> {
    if (!providerRoutingAuthorized(this.definition.id)) {
      this.attestedChecksum = null;
      this.readiness = blockedProviderReadiness(this.definition.id);
      return this.readiness;
    }
    if (!this.endpoint) {
      this.readiness = initialProviderReadiness(false);
      return this.readiness;
    }
    const cacheKey = `${this.definition.id}:${this.endpoint}`;
    const cached = providerHealthCache.get(cacheKey);
    if (!force && cached && cached.expiresAt > Date.now()) {
      this.readiness = cached.snapshot;
      return this.readiness;
    }
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    try {
      const healthUrl = providerHealthUrl(this.definition.id, this.endpoint);
      const response = await fetch(healthUrl, {
        headers: this.headers(),
        signal: AbortSignal.timeout(providerHealthTimeoutMs(this.definition.id)),
      });
      if (!response.ok) {
        throw new Error(`health check returned HTTP ${response.status}`);
      }
      const payload = await response.json() as unknown;
      if (!isRecord(payload)) {
        throw new Error("health response must be a JSON object");
      }
      const checkpoint = isRecord(payload["checkpoint"])
        ? payload["checkpoint"]
        : {};
      const runtime = isRecord(payload["runtime"]) ? payload["runtime"] : {};
      const status = typeof payload["status"] === "string"
        ? payload["status"].toLowerCase()
        : "";
      const checkpointReady =
        payload["checkpointReady"] === true || checkpoint["ready"] === true;
      const runtimeReady =
        payload["runtimeReady"] === true ||
        payload["ready"] === true ||
        runtime["ready"] === true;
      const healthy =
        ["ok", "healthy", "ready"].includes(status) ||
        payload["healthy"] === true;
      const reportedVersion = [
        payload["modelVersion"],
        payload["version"],
        checkpoint["version"],
      ].find((value): value is string =>
        typeof value === "string" && Boolean(value.trim())
      )?.trim() ?? null;
      const strictGpuAttestation = isGpuAttestedProvider(this.definition.id);
      const commercialUseAuthorized = providerRoutingAuthorized(
        this.definition.id,
      );
      const expectedVersion = strictGpuAttestation
        ? expectedGpuModelVersion(this.definition.id, this.definition.modelVersion)
        : this.definition.modelVersion;
      const expectedChecksum = strictGpuAttestation
        ? expectedGpuCheckpointSha256(this.definition.id)
        : null;
      const expectedModalImageId = strictGpuAttestation
        ? expectedGpuModalImageId(this.definition.id)
        : null;
      const expectedSourceImageDigest = strictGpuAttestation
        ? expectedGpuSourceImageDigest(this.definition.id)
        : null;
      const reportedProvider = typeof payload["provider"] === "string"
        ? payload["provider"].trim()
        : null;
      const reportedChecksum = payload["checkpointSha256"] ??
        payload["checksum"] ??
        checkpoint["sha256"];
      const smokeTested = payload["smokeTested"] === true;
      const gpuReady = payload["gpuReady"] === true ||
        runtime["gpuReady"] === true;
      const exactModel = expectedVersion !== null && reportedVersion === expectedVersion;
      const runtimeProvenance = parseRuntimeProvenance(payload, reportedVersion, reportedChecksum);
      const promotionFailure = requiresGpuPromotionRecord(this.definition.id)
        ? gpuPromotionAttestationFailure(this.definition.id, this.endpoint, payload)
        : null;
      const strictAttestationReady = !strictGpuAttestation || (
        reportedProvider === this.definition.id &&
        exactModel &&
        isSha256(reportedChecksum) &&
        reportedChecksum.toLowerCase() === expectedChecksum &&
        runtimeProvenance?.modalImageId === expectedModalImageId &&
        runtimeProvenance?.sourceImageDigest === expectedSourceImageDigest &&
        smokeTested &&
        gpuReady &&
        runtimeProvenance !== null &&
        promotionFailure === null &&
        commercialUseAuthorized
      );
      const ready = healthy && checkpointReady && runtimeReady &&
        Boolean(reportedVersion) && strictAttestationReady;
      const message = ready
        ? strictGpuAttestation
          ? "GPU runtime, independently promoted Modal image, checkpoint checksum, model version, and smoke inference are verified."
          : "Checkpoint and provider runtime are ready."
            : promotionFailure
              ? promotionFailure
              : typeof payload["message"] === "string" && payload["message"].trim()
          ? payload["message"].trim()
          : strictGpuAttestation && reportedProvider !== this.definition.id
            ? "GPU worker health response identified the wrong provider."
            : strictGpuAttestation && !exactModel
              ? `GPU worker model version does not match its immutable deployment pin.`
              : strictGpuAttestation && !commercialUseAuthorized
                ? "Provider routing is blocked until its commercial-use license is verified."
              : strictGpuAttestation && (
                  !expectedChecksum ||
                  !isSha256(reportedChecksum) ||
                  reportedChecksum.toLowerCase() !== expectedChecksum
                )
                ? "GPU worker checkpoint SHA-256 does not match the deployment pin."
                : strictGpuAttestation &&
                    (!expectedModalImageId ||
                      runtimeProvenance?.modalImageId !== expectedModalImageId)
                  ? "GPU worker Modal image ID does not match the independently promoted deployment pin."
                : strictGpuAttestation &&
                    (!expectedSourceImageDigest ||
                      runtimeProvenance?.sourceImageDigest !== expectedSourceImageDigest)
                  ? "GPU worker source image digest does not match the compatibility deployment pin."
                : strictGpuAttestation && !smokeTested
                  ? "GPU worker has not completed a real smoke inference."
                  : strictGpuAttestation && !gpuReady
                    ? "GPU worker did not attest an available GPU runtime."
                    : strictGpuAttestation && !runtimeProvenance
                      ? "GPU worker did not provide complete immutable runtime provenance."
          : !checkpointReady
            ? "Configured worker has not verified its model checkpoint."
            : !runtimeReady
              ? "Configured worker runtime is not ready."
              : !reportedVersion
                ? "Configured worker did not report a model version."
                : "Configured worker health check is unhealthy.";
      this.readiness = {
        availability: ready ? "ready" : commercialUseAuthorized ? "configured" : "unavailable",
        configurationReady: commercialUseAuthorized,
        checkpointReady,
        runtimeReady,
        smokeTested,
        healthStatus: ready ? "healthy" : "unhealthy",
        checkedAt,
        latencyMs: Math.max(0, Date.now() - startedAt),
        message,
        reportedVersion,
        maximumCandidates: reportedMaximumCandidates(payload),
        reportedChecksum: isSha256(reportedChecksum)
          ? reportedChecksum.toLowerCase()
          : null,
        runtimeProvenance,
      };
      this.attestedChecksum = ready && isSha256(reportedChecksum)
        ? reportedChecksum.toLowerCase()
        : null;
    } catch (error) {
      this.attestedChecksum = null;
      this.readiness = {
        availability: providerRoutingAuthorized(this.definition.id)
          ? "configured"
          : "unavailable",
        configurationReady: providerRoutingAuthorized(this.definition.id),
        checkpointReady: false,
        runtimeReady: false,
        smokeTested: false,
        healthStatus: "unhealthy",
        checkedAt,
        latencyMs: Math.max(0, Date.now() - startedAt),
        message: error instanceof Error
          ? `Provider health check failed: ${error.message}`
          : "Provider health check failed.",
        reportedVersion: null,
        maximumCandidates: null,
        reportedChecksum: null,
        runtimeProvenance: null,
      };
    }
    providerHealthCache.set(cacheKey, {
      expiresAt: Date.now() + PROVIDER_HEALTH_TTL_MS,
      snapshot: this.readiness,
    });
    return this.readiness;
  }

  private normalizeResult(
    payload: unknown,
    input: ProviderGenerationInput,
  ): ProviderGenerationResult {
    if (!isRecord(payload) || !Array.isArray(payload["candidates"])) {
      throw new Error(`${this.definition.displayName} worker response is invalid`);
    }
    const resultModelVersion = typeof payload["modelVersion"] === "string"
      ? payload["modelVersion"]
      : null;
    const resultCheckpointSha256 = payload["checkpointSha256"] ?? payload["checksum"];
    const runtimeProvenance = parseRuntimeProvenance(
      payload,
      resultModelVersion,
      resultCheckpointSha256,
    );
    if (isGpuAttestedProvider(this.definition.id)) {
      const provider = payload["provider"];
      const modelVersion = payload["modelVersion"];
      const checkpointSha256 = payload["checkpointSha256"] ??
        payload["checksum"];
      if (
        provider !== this.definition.id ||
        modelVersion !== this.definition.modelVersion ||
        !isSha256(checkpointSha256) ||
        checkpointSha256.toLowerCase() !== this.attestedChecksum ||
        payload["smokeTested"] !== true ||
        runtimeProvenance?.modalImageId !==
          expectedGpuModalImageId(this.definition.id) ||
        !sameRuntimeProvenance(runtimeProvenance, this.readiness.runtimeProvenance)
      ) {
        throw new Error(
          `${this.definition.displayName} worker result failed GPU provenance attestation`,
        );
      }
    }
    const sharedTrackModels = payload["trackModels"];
    const candidates = payload["candidates"]
      .slice(0, input.candidates)
      .map((candidate, index) =>
        normalizeCandidate(
          candidate,
          index,
          input,
          sharedTrackModels,
          this.endpoint ? new URL(this.endpoint).origin : undefined,
        ));
    if (candidates.length === 0) {
      throw new Error(`${this.definition.displayName} worker returned no candidates`);
    }
    return {
      requestId: typeof payload["requestId"] === "string" ? payload["requestId"] : null,
      modelVersion:
        typeof payload["modelVersion"] === "string"
          ? payload["modelVersion"]
          : this.definition.modelVersion,
      checkpointSha256: isSha256(
          payload["checkpointSha256"] ?? payload["checksum"],
        )
        ? String(payload["checkpointSha256"] ?? payload["checksum"]).toLowerCase()
        : null,
      runtimeProvenance: runtimeProvenance ?? undefined,
      candidates,
    };
  }

  async generate(
    input: ProviderGenerationInput,
    onProgress?: (progress: ProviderProgress) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<ProviderGenerationResult> {
    assertProviderCommercialUseAuthorized(this.definition.id);
    if (this.definition.id === "ANYACCOMP" && !input.sourceAudio?.url) {
      throw new Error("AnyAccomp requires a private source vocal artifact; it cannot run text-only accompaniment inference");
    }
    if (this.definition.id === "ANYACCOMP" && !this.available) {
      throw new ProviderUnavailableError(
        "ANYACCOMP (signed deployment health attestation has not passed)",
      );
    }
    if (!this.endpoint) {
      throw new Error(`${this.definition.displayName} worker is not configured`);
    }
    const requestUrl = providerGenerationUrl(
      this.endpoint,
      input.task,
      input.operation,
    );
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Idempotency-Key": input.jobId,
      },
      body: JSON.stringify({
        provider: this.definition.id,
        modelVersion: this.definition.modelVersion,
        ...input,
        prompt: providerGenerationPrompt(input),
        candidateCount: input.candidates,
        durationSeconds: providerGenerationDuration(input.songModel),
        ...(this.definition.id === "ANYACCOMP"
          ? { vocalSource: input.sourceAudio }
          : {}),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)])
        : AbortSignal.timeout(10 * 60 * 1000),
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
    const endpointUrl = new URL(requestUrl);
    const statusUrl = new URL(payload["statusUrl"], endpointUrl);
    if (statusUrl.origin !== endpointUrl.origin) {
      throw new Error("Provider status URL must use the configured worker origin");
    }
    const cancelUrl = new URL(
      typeof payload["cancelUrl"] === "string"
        ? payload["cancelUrl"]
        : payload["statusUrl"],
      endpointUrl,
    );
    if (cancelUrl.origin !== endpointUrl.origin) {
      throw new Error("Provider cancellation URL must use the configured worker origin");
    }
    let cancellationDelivery: Promise<void> | null = null;
    const cancelRemoteJob = () => {
      cancellationDelivery ??= cancelRemoteProviderJob(
        this.definition.id,
        cancelUrl.toString(),
      );
    };
    signal?.addEventListener("abort", cancelRemoteJob, { once: true });
    const requestId =
      typeof payload["requestId"] === "string" ? payload["requestId"] : undefined;
    await onProgress?.({
      progress: 35,
      stage: "provider_queued",
      requestId,
      cancelUrl: cancelUrl.toString(),
    });
    const deadline = Date.now() + 10 * 60 * 1000;
    try {
      while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const statusResponse = await fetch(statusUrl, {
        headers: this.headers(),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
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
        if (
          statusPayload["status"] === "succeeded" ||
          statusPayload["status"] === "completed"
        ) {
          return this.normalizeResult(statusPayload["result"] ?? statusPayload, input);
        }
      }
      throw new Error(`${this.definition.displayName} worker timed out`);
    } catch (error) {
      if (signal?.aborted) {
        try {
          await (cancellationDelivery ?? cancelRemoteProviderJob(
            this.definition.id,
            cancelUrl.toString(),
          ));
        } catch (cancellationError) {
          throw new ProviderCancellationUnconfirmedError(
            cancellationError instanceof Error
              ? cancellationError.message
              : `${this.definition.displayName} cancellation was not acknowledged`,
          );
        }
        throw new ProviderCancellationAcknowledgedError(
          `${this.definition.displayName} cancellation acknowledged`,
        );
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelRemoteJob);
    }
  }
}

export type ProviderProgress = {
  progress: number;
  stage: string;
  requestId?: string;
  cancelUrl?: string;
};

export interface MusicGenerationProvider {
  readonly definition: ProviderDefinition;
  readonly available: boolean;
  readiness: ProviderRuntimeSnapshot;
  checkHealth(force?: boolean): Promise<ProviderRuntimeSnapshot>;
  generate(
    input: ProviderGenerationInput,
    onProgress?: (progress: ProviderProgress) => Promise<void>,
    signal?: AbortSignal,
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
  if (request.requestedProvider) {
    assertProviderCommercialUseAuthorized(request.requestedProvider);
  }
  const compatible = registry.filter((provider) => {
    const definition = provider.definition;
    return (
      provider.available &&
      provider.readiness.checkpointReady &&
      provider.readiness.runtimeReady &&
      provider.readiness.healthStatus === "healthy" &&
      providerRoutingAuthorized(definition.id) &&
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
    modelVersion: "bs-roformer-viperx-v1",
    tasks: ["SEPARATION"],
    hardware: ["GPU"],
    speeds: ["BALANCED", "QUALITY"],
    styles: [],
    routingStatus: "BLOCKED_LICENSE",
  },
  {
    id: "ALL_IN_ONE",
    displayName: "All-In-One",
    modelVersion: "all-in-one-infer-3.1.0",
    tasks: ["SEPARATION", "TRANSCRIPTION"],
    hardware: ["CPU", "GPU"],
    speeds: ["FAST", "BALANCED"],
    styles: [],
  },
  {
    id: "MT3",
    displayName: "MT3",
    modelVersion: "mt3-pytorch-multitrack",
    tasks: ["TRANSCRIPTION"],
    hardware: ["GPU"],
    speeds: ["BALANCED", "QUALITY"],
    styles: [],
  },
  {
    id: "MUSICGEN",
    displayName: "MusicGen",
    modelVersion: "musicgen-large",
    tasks: ["ACCOMPANIMENT", "ARRANGEMENT"],
    hardware: ["GPU"],
    speeds: ["FAST", "BALANCED", "QUALITY"],
    styles: ["pop", "electronic", "ambient", "cinematic"],
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
    modelVersion: "anyaccomp-2025-12-22",
    tasks: ["ACCOMPANIMENT"],
    hardware: ["GPU"],
    speeds: ["BALANCED", "QUALITY"],
    styles: ["vocal", "solo", "acoustic"],
  },
  {
    id: "LADA_BAND",
    displayName: "LaDA-Band (Research Only)",
    modelVersion: "6d444caee85385677b0652ecb0b2b8220436dd37",
    tasks: ["ACCOMPANIMENT"],
    hardware: ["GPU"],
    speeds: ["QUALITY"],
    styles: ["vocal", "singing"],
  },
  {
    id: "HAFM",
    displayName: "HAFM",
    modelVersion: "1653c3c7bffdc9b4b2d57d8b6e4f5bb3002a64fe",
    tasks: ["ACCOMPANIMENT"],
    hardware: ["GPU"],
    speeds: ["BALANCED", "QUALITY"],
    styles: ["vocal", "singing", "acoustic"],
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
    modelVersion: "midi-sag-b79839ed0cdd0b5e5f39d4cc4a80fcc90002d32f",
    tasks: ["ACCOMPANIMENT", "ORCHESTRATION", "ARRANGEMENT"],
    hardware: ["CPU", "GPU"],
    speeds: ["FAST", "BALANCED", "QUALITY"],
    styles: ["pop", "jazz", "classical", "cinematic", "orchestral"],
  },
  {
    id: "MUSE_CONTROL_LITE",
    displayName: "MuseControlLite",
    modelVersion: "UNVERIFIED",
    tasks: ["ACCOMPANIMENT"],
    hardware: ["GPU"],
    speeds: ["BALANCED", "QUALITY"],
    styles: ["controlled", "midi-conditioned", "vocal-conditioned"],
  },
];

export function createProviderRegistry(): MusicGenerationProvider[] {
  return providerDefinitions.map((definition) => {
    const routingAuthorized = providerRoutingAuthorized(definition.id);
    const endpoint = routingAuthorized
      ? remoteProviderEndpoint(definition.id)
      : undefined;
    const token = routingAuthorized
      ? remoteProviderToken(definition.id)
      : undefined;
    return new HttpMusicGenerationProvider(definition, endpoint, token);
  });
}

const PROVIDER_HEALTH_TTL_MS = 30_000;
const providerHealthCache = new Map<string, {
  expiresAt: number;
  snapshot: ProviderRuntimeSnapshot;
}>();

function providerHealthTimeoutMs(providerId: string): number {
  const configured = Number.parseInt(
    process.env[`MUSIC_PROVIDER_${providerId}_HEALTH_TIMEOUT_MS`] ??
      process.env["MUSIC_PROVIDER_HEALTH_TIMEOUT_MS"] ??
      "5000",
    10,
  );
  return Number.isFinite(configured)
    ? Math.max(100, Math.min(300_000, configured))
    : 5_000;
}

function initialProviderReadiness(configured: boolean): ProviderRuntimeSnapshot {
  return {
    availability: configured ? "configured" : "unavailable",
    configurationReady: configured,
    checkpointReady: false,
    runtimeReady: false,
    smokeTested: false,
    healthStatus: "unknown",
    checkedAt: null,
    latencyMs: null,
    message: configured
      ? "Configured endpoint has not passed a runtime health check."
      : "Provider endpoint is not configured.",
    reportedVersion: null,
    maximumCandidates: null,
    reportedChecksum: null,
  };
}

function blockedProviderReadiness(providerId: string): ProviderRuntimeSnapshot {
  const reason = UPSTREAM_BLOCKED_PROVIDER_IDS.has(providerId)
    ? "BLOCKED_UPSTREAM: pinned source lacks the required production adapter."
    : MISSING_LICENSED_ASSET_PROVIDER_IDS.has(providerId)
      ? "BLOCKED_MISSING_LICENSED_ASSET: required licensed asset is unavailable."
      : "BLOCKED_LICENSE until checkpoint-owner rights are verified.";
  return {
    ...initialProviderReadiness(false),
    healthStatus: "unhealthy",
    message: `${providerId} is ${reason}`,
  };
}

function providerHealthUrl(
  providerId: MusicProviderId,
  endpoint: string,
): URL {
  const key = providerEnvKey(providerId);
  const configured = process.env[`MUSIC_PROVIDER_${key}_HEALTH_URL`];
  const url = configured
    ? new URL(configured)
    : new URL("/health", endpoint);
  if (!configured) {
    url.searchParams.set("provider", providerId);
  }
  return url;
}

export async function verifyProviderRegistry(
  registry = createProviderRegistry(),
  force = false,
): Promise<MusicGenerationProvider[]> {
  await Promise.all(registry.map((provider) =>
    providerRoutingAuthorized(provider.definition.id)
      ? provider.checkHealth(force)
      : Promise.resolve(provider.readiness)
  ));
  return registry;
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
  routingStatus?: "ACTIVE" | "BLOCKED_LICENSE";
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
  operation?: AceStepOperation;
  sourceAudio?: {
    artifactId: string;
    url: string;
  };
  instrument?: string;
  region?: AceStepRegion;
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

function providerGenerationUrl(
  endpoint: string,
  task: MusicGenerationTask,
  operation?: AceStepOperation,
): string {
  const url = new URL(endpoint);
  if (
    (url.pathname === "/" || url.pathname === "") &&
    url.hostname.endsWith(".modal.run")
  ) {
    url.pathname =
      operation && operation !== "COMPLETE"
        ? "/arrange"
        : task === "ARRANGEMENT"
          ? "/arrange"
          : "/generate";
  }
  return url.toString();
}

function providerGenerationDuration(songModelValue: unknown): number {
  const songModel = isRecord(songModelValue) ? songModelValue : {};
  const audio = isRecord(songModel["audio"]) ? songModel["audio"] : {};
  const duration = typeof audio["durationSeconds"] === "number" &&
      Number.isFinite(audio["durationSeconds"])
    ? audio["durationSeconds"]
    : 30;
  return Math.max(1, Math.min(120, duration));
}

function providerGenerationPrompt(input: ProviderGenerationInput): string {
  const task = input.operation === "LEGO"
    ? `focused ${input.instrument} accompaniment part`
    : input.operation === "REPAINT"
      ? `repaint only the requested ${input.region?.unit} region`
      : input.operation === "COVER"
        ? "instrumental cover preserving the source composition"
        : input.operation === "EXTRACT"
          ? "extract a source-conditioned instrumental part"
          : input.task === "ACCOMPANIMENT"
            ? "instrumental accompaniment"
            : "complete instrumental arrangement";
  const trackNames = input.tracks
    .map((track) => track.instrument || track.name)
    .filter(Boolean)
    .slice(0, 12)
    .join(", ");
  return [
    task,
    input.operation ? `operation: ${input.operation}` : "",
    input.instrument ? `focused instrument: ${input.instrument}` : "",
    input.region
      ? `region: ${input.region.unit} ${input.region.start}-${input.region.end}; crossfade ${input.region.crossfadeSeconds}s`
      : "",
    `style: ${input.style}`,
    `energy: ${input.arrangement.energy.toFixed(2)}`,
    `density: ${input.arrangement.density.toFixed(2)}`,
    trackNames ? `instrumentation: ${trackNames}` : "",
    "preserve clear space for the source vocal or lead melody",
    "no lead vocals",
  ].filter(Boolean).join("; ").slice(0, 4000);
}

export type GenerationHardware = "AUTO" | "CPU" | "GPU";

export type ProviderGenerationResult = {
  requestId: string | null;
  modelVersion: string;
  checkpointSha256: string | null;
  runtimeProvenance?: ProviderRuntimeProvenance;
  candidates: ProviderCandidate[];
};

export type ProviderRuntimeProvenance = {
  model: string;
  checkpointSha256: string;
  revision: string;
  modalImageId: string;
  sourceImageDigest: string;
  cudaVersion: string;
  pytorchVersion: string;
  gpu: string;
};

function provenanceText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 256
    ? value.trim()
    : null;
}

function parseRuntimeProvenance(
  payload: Record<string, unknown>,
  modelVersion: string | null,
  checksum: unknown,
): ProviderRuntimeProvenance | null {
  const runtime = isRecord(payload["runtime"]) ? payload["runtime"] : {};
  const model = provenanceText(modelVersion);
  const checkpointSha256 = isSha256(checksum) ? checksum.toLowerCase() : null;
  const revision = provenanceText(payload["revision"] ?? payload["checkpointRevision"] ?? runtime["revision"]);
  const modalImageId = provenanceText(
    payload["modalImageId"] ?? payload["imageId"] ??
      runtime["modalImageId"] ?? runtime["imageId"],
  );
  const sourceImageDigest = provenanceText(
    payload["sourceImageDigest"] ?? runtime["sourceImageDigest"] ??
      payload["containerDigest"] ?? runtime["containerDigest"],
  );
  const cudaVersion = provenanceText(payload["cudaVersion"] ?? runtime["cudaVersion"]);
  const pytorchVersion = provenanceText(payload["pytorchVersion"] ?? payload["torchVersion"] ?? runtime["pytorchVersion"] ?? runtime["torchVersion"]);
  const gpu = provenanceText(payload["gpu"] ?? payload["gpuModel"] ?? runtime["gpu"] ?? runtime["gpuModel"]);
  return model && checkpointSha256 && revision &&
      modalImageId && /^im-[A-Za-z0-9]+$/.test(modalImageId) &&
      sourceImageDigest && /^sha256:[a-f0-9]{64}$/i.test(sourceImageDigest) &&
      cudaVersion && pytorchVersion && gpu
    ? {
      model,
      checkpointSha256,
      revision,
      modalImageId,
      sourceImageDigest,
      cudaVersion,
      pytorchVersion,
      gpu,
    }
    : null;
}

function sameRuntimeProvenance(
  left: ProviderRuntimeProvenance | null,
  right: ProviderRuntimeProvenance | null | undefined,
): boolean {
  return Boolean(left && right &&
    left.model === right.model &&
    left.checkpointSha256 === right.checkpointSha256 &&
    left.revision === right.revision &&
    left.modalImageId === right.modalImageId &&
    left.sourceImageDigest === right.sourceImageDigest &&
    left.cudaVersion === right.cudaVersion &&
    left.pytorchVersion === right.pytorchVersion &&
    left.gpu === right.gpu);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

export function providerCatalog(registry: MusicGenerationProvider[]) {
  return registry.map((provider) => {
    const routingAuthorized = providerRoutingAuthorized(provider.definition.id);
    const blocked = blockedProviderReadiness(provider.definition.id);
    const readiness = routingAuthorized ? provider.readiness : blocked;
    return {
      id: provider.definition.id,
      name: provider.definition.displayName,
      modelVersion: provider.definition.modelVersion,
      tasks: provider.definition.tasks,
      hardware: provider.definition.hardware,
      speeds: provider.definition.speeds,
      routingStatus: provider.definition.routingStatus ?? "ACTIVE",
      available: routingAuthorized && provider.available,
      status: readiness.availability,
      configured: readiness.configurationReady,
      checkpointReady: readiness.checkpointReady,
      runtimeReady: readiness.runtimeReady,
      smokeTested: readiness.smokeTested,
      reportedVersion: readiness.reportedVersion,
      reportedChecksum: readiness.reportedChecksum ?? null,
      runtimeProvenance: readiness.runtimeProvenance ?? null,
      lastHealth: {
        status: readiness.healthStatus,
        checkedAt: readiness.checkedAt,
        latencyMs: readiness.latencyMs,
        message: readiness.message,
      },
    };
  });
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
  expectedArtifactOrigin?: string,
): ProviderCandidate {
  if (!isRecord(value)) throw new Error(`Provider candidate ${index + 1} is invalid`);
  const plan = isRecord(value["plan"])
    ? value["plan"]
    : providerFallbackPlan(input);
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
    if (rawTrackModels.length > 0) {
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
  }
  const audioArtifact = normalizeProviderAudioArtifact(
    value["artifact"] ??
      (Array.isArray(value["artifacts"]) ? value["artifacts"][0] : undefined),
    index,
    expectedArtifactOrigin,
  );
  if (audioArtifact && trackModels === undefined) {
    trackModels = [];
  }
  return {
    providerRequestId:
      typeof value["providerRequestId"] === "string" ? value["providerRequestId"] : null,
    label: optionalString(value["label"]) ?? `Candidate ${String.fromCharCode(65 + index)}`,
    score: optionalUnitNumber(value["score"]) ?? 0.5,
    confidence: optionalUnitNumber(value["confidence"]) ?? 0.5,
    summary: optionalString(value["summary"]) ??
      "Provider audio received; independent render analysis is pending.",
    seed: typeof value["seed"] === "number" &&
        Number.isInteger(value["seed"]) &&
        value["seed"] >= 0 &&
        value["seed"] <= 2_147_483_647
      ? value["seed"]
      : Math.min(2_147_483_647, input.seed + index),
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
    audioArtifact,
  };
}

export type ProviderAudioArtifact = {
  name: string;
  url: string;
  contentType: "audio/flac" | "audio/wav";
  format: "flac" | "wav";
  bytes: number;
  sha256: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
};

export type ProviderCandidate = {
  providerRequestId: string | null;
  label: string;
  score: number;
  confidence: number;
  summary: string;
  seed: number;
  plan: CandidatePlan;
  parameters: GenerationParameters;
  parentArtifactIds: string[];
  trackModels?: TrackModel[];
  audioArtifact?: ProviderAudioArtifact;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalUnitNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function providerFallbackPlan(input: ProviderGenerationInput): Record<string, unknown> {
  const songModel = isRecord(input.songModel) ? input.songModel : {};
  const sections = Array.isArray(songModel["sections"])
    ? songModel["sections"].filter(isRecord)
    : [];
  const focusedInstrument = input.instrument?.toLowerCase();
  const enabledTracks =
    input.operation === "LEGO" || input.operation === "EXTRACT"
      ? input.tracks
          .filter((track) =>
            [track.name, track.role, track.instrument]
              .join(" ")
              .toLowerCase()
              .includes(focusedInstrument ?? "\u0000"),
          )
          .map((track) => track.id)
      : input.tracks.map((track) => track.id);
  return {
    sections: sections.length
      ? sections.map((section, index) => ({
          name: optionalString(section["name"]) ?? `Section ${index + 1}`,
          energy: optionalUnitNumber(section["energy"]) ?? input.arrangement.energy,
          density: input.arrangement.density,
          tracks: enabledTracks,
        }))
      : [{
          name: "Full Song",
          energy: input.arrangement.energy,
          density: input.arrangement.density,
          tracks: enabledTracks,
        }],
  };
}

function normalizeProviderAudioArtifact(
  value: unknown,
  candidateIndex: number,
  expectedOrigin?: string,
): ProviderAudioArtifact | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Provider candidate ${candidateIndex + 1} audio artifact is invalid`);
  }
  const name = stringValue(value["name"], `candidates[${candidateIndex}].artifact.name`);
  const format = optionalString(value["format"])?.toLowerCase();
  const contentType = optionalString(value["contentType"])?.toLowerCase();
  if (
    (format !== "flac" && format !== "wav") ||
    (contentType !== "audio/flac" && contentType !== "audio/wav")
  ) {
    throw new Error(`Provider candidate ${candidateIndex + 1} audio format is unsupported`);
  }
  const urlValue = stringValue(value["url"], `candidates[${candidateIndex}].artifact.url`);
  const url = new URL(urlValue);
  if (
    url.protocol !== "https:" ||
    (expectedOrigin && url.origin !== expectedOrigin) ||
    !url.searchParams.get("expires") ||
    !url.searchParams.get("capability")
  ) {
    throw new Error(`Provider candidate ${candidateIndex + 1} audio URL is not a trusted capability`);
  }
  const bytes = finiteNumber(value["bytes"], `candidates[${candidateIndex}].artifact.bytes`);
  const durationSeconds = finiteNumber(
    value["durationSeconds"],
    `candidates[${candidateIndex}].artifact.durationSeconds`,
  );
  const sampleRate = finiteNumber(
    value["sampleRate"],
    `candidates[${candidateIndex}].artifact.sampleRate`,
  );
  const channels = finiteNumber(
    value["channels"],
    `candidates[${candidateIndex}].artifact.channels`,
  );
  const artifactSha256 = optionalString(value["sha256"])?.toLowerCase();
  if (
    !Number.isInteger(bytes) ||
    bytes <= 0 ||
    bytes > 128 * 1024 * 1024 ||
    durationSeconds <= 0 ||
    durationSeconds > 120 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 192_000 ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 2 ||
    !artifactSha256 ||
    !isSha256(artifactSha256)
  ) {
    throw new Error(`Provider candidate ${candidateIndex + 1} audio metadata is invalid`);
  }
  return {
    name,
    url: url.toString(),
    contentType,
    format,
    bytes,
    sha256: artifactSha256,
    durationSeconds,
    sampleRate,
    channels,
  };
}

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

const MISSING_LICENSED_ASSET_PROVIDER_IDS = new Set<string>(["MUSE_CONTROL_LITE"]);
