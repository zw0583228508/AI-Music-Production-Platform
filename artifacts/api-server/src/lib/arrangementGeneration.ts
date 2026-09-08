import { execFile } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  arrangementsTable,
  db,
  musicArtifactsTable,
  musicGenerationCandidatesTable,
  musicGenerationJobsTable,
  musicProjectsTable,
  songModelsTable,
  studioActivitiesTable,
  tracksTable,
  type AceStepOperation,
  type AceStepRegion,
  type ArrangementPlan,
  type CandidateEvaluation,
  type CandidateRepairSnapshot,
  type CriticRepairFinding,
  type GenerationParameters,
  type HarmonyDecisionEvidence,
  type MusicGenerationTask,
  type SongModelData,
  type TrackModel,
} from "@workspace/db";
import {
  createProviderRegistry,
  cancelRemoteProviderJob,
  ProviderCancellationAcknowledgedError,
  ProviderCancellationUnconfirmedError,
  providerCatalog,
  selectMusicProvider,
  validateCanonicalTrackModels,
  verifyProviderRegistry,
  type GenerationHardware,
  type GenerationSpeed,
  type MusicProviderId,
  type ProviderAudioArtifact,
  type ProviderCandidate,
} from "./musicProviders";
import {
  applyPlanModulations,
  applyCompositionIntelligence,
  buildArrangementBrain,
  buildTrackModels,
  createArrangementPlan,
  createStyleSpec,
  decodePcm16Wav,
  HarmonyEngine,
  QualityEngine,
  renderMusicPipeline,
} from "./musicEngines";
import { createPerformanceMidi, encodeWav } from "./exportEngine";
import {
  createPrivateExportDownloadUrl,
  createSourceDownloadUrl,
  deleteExportObject,
  isPrivateExportObjectPath,
  isSourceObjectPath,
  saveExportObject,
} from "./objectStorage";
import {
  deployedCalibrationFeatures,
  hasCompleteQualityEvidence,
  isSelectableCandidate,
  publicCandidateEvaluation,
  rankEvaluatedCandidates,
} from "./candidateRanking";
import {
  diversityEvidence,
  fingerprintCandidate,
  seedForCandidate,
  strategyForCandidate,
} from "./candidateDiversity";
import {
  applyBoundedRepair,
  boundedRepairSourceSeed,
  audioFindingToRepairFinding,
  MAX_REPAIR_ATTEMPTS,
  repairTimeBounds,
  validateServerAuthoredRepairFinding,
} from "./candidateRepair";
import { evaluateCandidateMusicalFit } from "./candidateQuality";
import { evaluateRenderedPcm } from "./perceptualAudioCritic";
import {
  activeCalibrationForOwner,
  activeGenerationPreferenceForOwner,
} from "./producerDecisionLedger";
import { appendProducerDecisionTx } from "./producerDecisionLedger";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);
const PROVIDER_AUDIO_LIMIT_BYTES = 128 * 1024 * 1024;

async function ingestProviderAudio(artifact: ProviderAudioArtifact): Promise<Buffer> {
  const response = await fetch(artifact.url, {
    headers: { Accept: "audio/flac, audio/wav" },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Provider audio download returned HTTP ${response.status}`);
  }
  const declaredLength = Number(
    response.headers.get("content-length") ?? artifact.bytes,
  );
  if (
    !Number.isFinite(declaredLength) ||
    declaredLength !== artifact.bytes ||
    declaredLength <= 0 ||
    declaredLength > PROVIDER_AUDIO_LIMIT_BYTES
  ) {
    throw new Error(
      "Provider audio download size does not match its attested metadata",
    );
  }
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (
    downloaded.byteLength !== artifact.bytes ||
    sha256(downloaded) !== artifact.sha256
  ) {
    throw new Error("Provider audio download failed checksum verification");
  }

  const workspace = await mkdtemp(join(tmpdir(), "music-provider-audio-"));
  const inputPath = join(workspace, `input.${artifact.format}`);
  const outputPath = join(workspace, "output.wav");
  try {
    await writeFile(inputPath, downloaded);
    await execFileAsync("ffmpeg", [
      "-v", "error",
      "-nostdin",
      "-y",
      "-i", inputPath,
      "-map", "0:a:0",
      "-ac", "2",
      "-ar", "44100",
      "-c:a", "pcm_s16le",
      outputPath,
    ], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const wav = await readFile(outputPath);
    if (wav.byteLength <= 44 || wav.byteLength > PROVIDER_AUDIO_LIMIT_BYTES) {
      throw new Error("Provider audio transcoding produced an invalid WAV");
    }
    decodePcm16Wav(wav, 44_100);
    return wav;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export type QueueGenerationInput = {
  candidates?: number;
  idempotencyKey?: string;
  provider?: MusicProviderId;
  task?: MusicGenerationTask;
  hardware?: GenerationHardware;
  speed?: GenerationSpeed;
  seed?: number;
  parameters?: GenerationParameters;
  operation?: AceStepOperation;
  sourceArtifactId?: string;
  instrument?: string;
  region?: Partial<AceStepRegion> & Pick<AceStepRegion, "unit" | "start" | "end">;
  repair?: CandidateRepairSnapshot;
};

const LEGO_INSTRUMENT_FAMILIES = new Map([
  ["drum", "drums"],
  ["drums", "drums"],
  ["percussion", "percussion"],
  ["bass", "bass"],
  ["guitar", "guitar"],
  ["piano", "piano"],
  ["keys", "keys"],
  ["keyboard", "keys"],
  ["strings", "strings"],
  ["brass", "brass"],
  ["synth", "synth"],
  ["orchestral", "orchestral"],
  ["harmony", "harmony"],
  ["melody", "melody"],
]);

function normalizeAceStepRegion(
  operation: AceStepOperation | null,
  value: QueueGenerationInput["region"],
): AceStepRegion | null {
  if (operation !== "REPAINT") {
    if (value) throw new Error("A generation region is only valid for REPAINT");
    return null;
  }
  if (!value) throw new Error("REPAINT requires a bar, beat, or time region");
  if (
    !["bar", "beat", "time"].includes(value.unit) ||
    !Number.isFinite(value.start) ||
    !Number.isFinite(value.end) ||
    value.start < (value.unit === "bar" ? 1 : 0) ||
    value.end <= value.start
  ) {
    throw new Error("REPAINT region must have a valid unit and increasing start/end");
  }
  const crossfadeSeconds = value.crossfadeSeconds ?? 0.25;
  if (
    !Number.isFinite(crossfadeSeconds) ||
    crossfadeSeconds < 0 ||
    crossfadeSeconds > 10
  ) {
    throw new Error("REPAINT crossfadeSeconds must be between 0 and 10");
  }
  return {
    unit: value.unit,
    start: value.start,
    end: value.end,
    crossfadeSeconds,
  };
}

export const generationJobResponse = (
  row: typeof musicGenerationJobsTable.$inferSelect,
) => ({
  id: row.id,
  projectId: row.projectId,
  arrangementId: row.arrangementId,
  task: row.task,
  status: row.status,
  provider: row.provider,
  modelVersion: row.modelVersion,
  providerRuntime: row.providerRuntime,
  hardware: row.hardware,
  speed: row.speed,
  progress: row.progress,
  stage: row.stage,
  providerRequestId: row.providerRequestId,
  requestedCandidates: row.requestedCandidates,
  seed: row.seed,
  parameters: row.parameters,
  parentArtifactIds: row.parentArtifactIds,
  error: row.error,
  errorCode: row.errorCode,
  retryable: row.retryable,
  attempt: row.attempt,
  maxAttempts: row.maxAttempts,
  cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  completedAt: row.completedAt?.toISOString() ?? null,
});

export const generationCandidateResponse = (
  row: typeof musicGenerationCandidatesTable.$inferSelect,
) => ({
  id: row.id,
  jobId: row.jobId,
  provider: row.provider,
  modelVersion: row.modelVersion,
  reportedModelVersion: row.reportedModelVersion,
  checkpointSha256: row.checkpointSha256,
  providerRequestId: row.providerRequestId,
  seed: row.seed,
  rank: row.rank,
  label: row.label,
  score: row.score,
  confidence: row.confidence,
  summary: row.summary,
  status: row.status,
  parameters: row.parameters,
  harmonyDecisions: row.parameters.harmonyDecisions ?? [],
  parentArtifactIds: row.parentArtifactIds,
  plan: row.plan,
  trackModels: row.trackModels,
  // Historical candidates remain readable with an explicit null critic, while
  // internal diversity fingerprints never cross the API boundary.
  evaluation: publicCandidateEvaluation(row.evaluation),
  createdAt: row.createdAt.toISOString(),
});

type CandidateMaterializationInput = {
  candidateId: string;
  version: number;
  source: {
    style: string;
    harmonyComplexity: number;
    energy: number;
    density: number;
    orchestraSize: number;
    rhythmIntensity: number;
  };
  songModel: SongModelData;
  songModelVersion: number | null;
  tracks: Array<{ id: string; name: string; role: string; instrument: string }>;
  candidate: {
    provider: string;
    seed: number;
    plan: ProviderCandidate["plan"];
    parentArtifactIds: string[];
    trackModels?: TrackModel[] | null;
  };
  generationPreference?: import("@workspace/db").GenerationPreferenceSnapshot | null;
  trackModelsMaterialized?: boolean;
};

function materializeCandidate(input: CandidateMaterializationInput): {
  plan: ArrangementPlan;
  trackModels: TrackModel[];
  styleSpec: ReturnType<typeof createStyleSpec>;
  engineParameters: Record<string, number | string | boolean>;
  harmonyDecisions: HarmonyDecisionEvidence[];
} {
  const { candidate, source, songModel, tracks } = input;
  const generationPreference = input.generationPreference ?? null;
  const engineParameters: Record<string, number | string | boolean> = {
    seed: candidate.seed,
    harmonyComplexity: source.harmonyComplexity,
    energy: source.energy,
    density: source.density,
    orchestraSize: source.orchestraSize,
    rhythmIntensity: source.rhythmIntensity,
    songModelVersion: input.songModelVersion ?? 0,
    provider: candidate.provider,
    modulationSemitones: source.harmonyComplexity >= 8 ? 2 : 0,
    styleGrammarVersion: "1.0",
    generationPreferenceVersion: generationPreference?.calibrationVersion ?? 0,
  };
  const styleSpec = createStyleSpec(source.style, {
    density: source.density,
    harmonyComplexity: source.harmonyComplexity,
    energy: source.energy,
    orchestraSize: source.orchestraSize,
    rhythmIntensity: source.rhythmIntensity,
  }, generationPreference);
  engineParameters.styleGrammarEvidenceSha256 = styleSpec.grammar?.evidenceSha256 ?? "legacy";
  engineParameters.generationPreferenceEvidenceSha256 =
    generationPreference?.evidenceSha256 ?? "none";
  // The global pass is deliberately completed before local plan construction,
  // so every candidate section receives one consistent whole-song direction.
  const arrangementBrain = buildArrangementBrain({
    songModel,
    controls: {
      energy: source.energy,
      density: source.density,
      orchestraSize: source.orchestraSize,
    },
    compositionVersion: "2.0",
  });
  const generatedPlan = createArrangementPlan({
    arrangementId: input.candidateId,
    version: input.version,
    songModel,
    style: styleSpec,
    tracks,
    parameters: { ...engineParameters, arrangementId: input.candidateId },
    parentIds: candidate.parentArtifactIds,
    arrangementBrain,
    compositionVersion: "2.0",
    generationPreference,
  });
  const providerSections = new Map(
    candidate.plan.sections.map((section) => [section.name.toLowerCase(), section]),
  );
  const descriptorByToken = new Map<string, Set<string>>();
  const registerTrackToken = (token: string, trackName: string) => {
    const normalized = token.toLowerCase();
    const matches = descriptorByToken.get(normalized) ?? new Set<string>();
    matches.add(trackName);
    descriptorByToken.set(normalized, matches);
  };
  for (const track of tracks) {
    registerTrackToken(track.id, track.name);
    registerTrackToken(track.name, track.name);
    registerTrackToken(track.role, track.name);
  }
  for (const descriptor of candidate.plan.tracks ?? []) {
    const projectTrack = tracks.find((track) => track.id === descriptor.id);
    if (!projectTrack) continue;
    registerTrackToken(descriptor.id, projectTrack.name);
    registerTrackToken(descriptor.name, projectTrack.name);
    registerTrackToken(descriptor.role, projectTrack.name);
  }
  const plan: ArrangementPlan = {
    ...generatedPlan,
    sections: generatedPlan.sections.map((section) => {
      const providerSection = providerSections.get(
        section.section.replaceAll("_", " ").toLowerCase(),
      );
      if (!providerSection) return section;
      // Provider section suggestions are local descriptions. Once the brain
      // has sufficient observed-form evidence, membership and operations stay
      // with its coordinated plan rather than reintroducing independent
      // section-level layer choices.
      if (arrangementBrain.enabled) return section;
      const enabled = new Set(providerSection.tracks.flatMap((track) =>
        [...(descriptorByToken.get(track.toLowerCase()) ?? [])]));
        const roleOperations = Object.fromEntries(
          Object.entries(section.tracks).map(([trackName, operation]) => [
            trackName,
            enabled.has(trackName) ? operation : "none",
          ]),
        );
        const enabledIds = new Set(
          tracks.filter((track) => enabled.has(track.name)).map((track) => track.id),
        );
        return {
        ...section,
        energy: providerSection.energy,
        density: providerSection.density,
          tracks: roleOperations,
          // Canonical plans use stable IDs; old persisted plans may still
          // carry names, which are resolved once at this boundary.
          activeTracks: [...enabledIds],
          trackDirectives: Object.fromEntries(
            Object.entries(section.trackDirectives ?? {})
              .flatMap(([key, directive]) => {
                const resolved = tracks.find((track) => track.id === key || track.name === key);
                return resolved && enabledIds.has(resolved.id)
                  ? [[resolved.id, directive]]
                  : [];
              }),
          ),
      };
    }),
  };
  const trackModels = candidate.trackModels === undefined ||
      candidate.trackModels === null
    ? buildTrackModels({
        songModel,
        plan,
        tracks,
        style: styleSpec,
        seed: candidate.seed,
      })
    : input.trackModelsMaterialized
      ? candidate.trackModels
      : applyCompositionIntelligence(
          applyPlanModulations(
            candidate.trackModels,
            plan,
            songModel.tempoMap[0]?.bpm ?? 92,
            songModel.meterMap[0]?.meter,
          ),
          plan,
          songModel,
        );
  const harmonyDecisions = new HarmonyEngine().generate(songModel, plan).map((harmony) => {
    const decision = harmony.decision ?? {};
    const numberField = (key: string) =>
      typeof decision[key] === "number" && Number.isFinite(decision[key])
        ? decision[key] as number
        : undefined;
    const source = decision.source === "song_model_chord_evidence"
      ? "song_model_chord_evidence" as const
      : "deterministic_candidate_scoring" as const;
    const candidateRationale = Array.isArray(decision.candidateRationale)
      ? decision.candidateRationale.filter(
          (item): item is NonNullable<HarmonyDecisionEvidence["candidateRationale"]>[number] =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as { symbol?: unknown }).symbol === "string" &&
            typeof (item as { function?: unknown }).function === "string" &&
            typeof (item as { score?: unknown }).score === "number" &&
            typeof (item as { melodyFit?: unknown }).melodyFit === "number" &&
            typeof (item as { bassFit?: unknown }).bassFit === "number" &&
            typeof (item as { voiceLeading?: unknown }).voiceLeading === "number" &&
            typeof (item as { selected?: unknown }).selected === "boolean",
        )
      : undefined;
    const bassSupportEvidence = Array.isArray(decision.bassSupportEvidence)
      ? decision.bassSupportEvidence.filter(
          (item): item is NonNullable<HarmonyDecisionEvidence["bassSupportEvidence"]>[number] =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as { start?: unknown }).start === "number" &&
            typeof (item as { end?: unknown }).end === "number" &&
            typeof (item as { pitch?: unknown }).pitch === "number" &&
            typeof (item as { confidence?: unknown }).confidence === "number" &&
            typeof (item as { provider?: unknown }).provider === "string",
        ).slice(0, 16)
      : undefined;
    return {
      start: harmony.start,
      end: harmony.end,
      symbol: harmony.symbol,
      function: harmony.function,
      source,
      score: numberField("score"),
      melodyFit: numberField("melodyFit"),
      bassFit: numberField("bassFit"),
      voiceLeading: numberField("voiceLeading"),
      harmonicBars: numberField("harmonicBars"),
      complexity: numberField("complexity"),
      ...(candidateRationale?.length ? { candidateRationale } : {}),
      ...(bassSupportEvidence?.length ? { bassSupportEvidence } : {}),
    };
  });
  const playabilityErrors = validateCanonicalTrackModels(
    trackModels,
    tracks.map((track) => track.id),
  );
  if (playabilityErrors.length) {
    throw new Error(
      `Generated TrackModels are not playable: ${playabilityErrors.join("; ")}`,
    );
  }
  return { plan, trackModels, styleSpec, engineParameters, harmonyDecisions };
}

function normalizeSongModelSnapshot(value: unknown): SongModelData {
  const raw = value && typeof value === "object"
    ? value as Partial<SongModelData>
    : {};
  return {
    contractVersion: raw.contractVersion ?? "1.0",
    ...(raw.contractVersion === undefined || raw.contractVersion === "1.0"
      ? {}
      : {
          timebase: raw.timebase ?? {
            ppq: 960,
            originSeconds: 0,
            coordinateSystem: "seconds+ticks",
          },
        }),
    validation: { status: "accepted", issues: [] },
    fusion: { selectedProvider: null, confidence: 0, decisions: [] },
    audio: {
      name: "generation-input",
      contentType: "application/octet-stream",
      size: 0,
      durationSeconds: 8,
      sampleRate: 44_100,
      channels: 2,
      proxyObjectPath: null,
      proxyContentType: null,
      analysisStartSeconds: 0,
      analysisDurationSeconds: 8,
      analysisCoverage: "full",
      ...raw.audio,
    },
    analysisStartSeconds: raw.analysisStartSeconds ?? 0,
    analysisDurationSeconds: raw.analysisDurationSeconds ??
      raw.audio?.durationSeconds ?? 8,
    analysisCoverage: raw.analysisCoverage ?? 1,
    beats: raw.beats ?? [],
    bars: raw.bars ?? [],
    dynamics: raw.dynamics ?? [],
    waveform: raw.waveform ?? [],
    stems: raw.stems ?? [],
    sourceStems: raw.sourceStems ?? [],
    lyrics: raw.lyrics ?? [],
    confidenceByField: raw.confidenceByField ?? {},
    providerProvenance: raw.providerProvenance ?? [],
    tempoMap: raw.tempoMap ?? [],
    meterMap: raw.meterMap ?? [],
    keyMap: raw.keyMap ?? [],
    melody: raw.melody ?? [],
    bass: raw.bass ?? [],
    chords: raw.chords ?? [],
    sections: raw.sections ?? [],
    energy: raw.energy ?? [],
    fieldStatus: raw.fieldStatus ?? {},
    provenance: raw.provenance ?? {},
  };
}

export async function listProviderCatalog() {
  return providerCatalog(await verifyProviderRegistry());
}

export async function queueArrangementGeneration(
  arrangementId: string,
  input: QueueGenerationInput,
  ownerId: string,
) {
  const [arrangement] = await db
    .select()
    .from(arrangementsTable)
    .where(eq(arrangementsTable.id, arrangementId))
    .limit(1);
  if (!arrangement) return null;

  const [project, songModels, artifacts, projectTracks] = await Promise.all([
    db
      .select()
      .from(musicProjectsTable)
      .where(eq(musicProjectsTable.id, arrangement.projectId))
      .limit(1),
    db
      .select()
      .from(songModelsTable)
      .where(eq(songModelsTable.projectId, arrangement.projectId))
      .orderBy(desc(songModelsTable.version))
      .limit(1),
    db
      .select()
      .from(musicArtifactsTable)
      .where(eq(musicArtifactsTable.projectId, arrangement.projectId))
      .orderBy(desc(musicArtifactsTable.createdAt)),
    db
      .select()
      .from(tracksTable)
      .where(eq(tracksTable.projectId, arrangement.projectId)),
  ]);
  const projectRow = project[0];
  if (!projectRow || projectRow.ownerId !== ownerId) return null;
  const generationPreference = await activeGenerationPreferenceForOwner(ownerId);

  const task = input.task ?? "ARRANGEMENT";
  const operation = input.operation ?? null;
  if (
    operation &&
    task !== "ARRANGEMENT" &&
    task !== "ACCOMPANIMENT"
  ) {
    throw new Error("ACE-Step operations require ARRANGEMENT or ACCOMPANIMENT");
  }
  const region = normalizeAceStepRegion(operation, input.region);
  const rawInstrument = input.instrument?.trim().toLowerCase() ?? null;
  const instrument = rawInstrument
    ? LEGO_INSTRUMENT_FAMILIES.get(rawInstrument) ?? null
    : null;
  if ((operation === "LEGO" || operation === "EXTRACT") && !instrument) {
    throw new Error(
      `${operation} requires one supported instrument family: ${[
        ...new Set(LEGO_INSTRUMENT_FAMILIES.values()),
      ].join(", ")}`,
    );
  }
  if (operation !== "LEGO" && operation !== "EXTRACT" && rawInstrument) {
    throw new Error("A focused instrument is only valid for LEGO or EXTRACT");
  }
  const hardware = input.hardware ?? "AUTO";
  const speed =
    input.speed ??
    (arrangement.mode === "QUICK_ARRANGE"
      ? "FAST"
      : arrangement.mode === "PRO_SCORE"
        ? "QUALITY"
        : "BALANCED");
  const registry = await verifyProviderRegistry(createProviderRegistry(), true);
  const provider = selectMusicProvider(registry, {
    requestedProvider: operation ? "ACE_STEP" : input.provider,
    task,
    style: arrangement.style,
    hardware,
    speed,
  });
  const count = Math.max(1, Math.min(5, Math.round(input.candidates ?? 3)));
  if (input.repair && count !== 1) {
    throw new Error("A bounded repair produces exactly one candidate per attempt");
  }
  if (
    provider.readiness.maximumCandidates !== null &&
    provider.readiness.maximumCandidates !== undefined &&
    count > provider.readiness.maximumCandidates
  ) {
    throw new Error(
      `${provider.definition.displayName} reports a maximum of ${provider.readiness.maximumCandidates} candidates per request; requested ${count}`,
    );
  }
  const sourceRequired = operation !== null;
  const requestedSourceArtifactId = input.sourceArtifactId?.trim() || null;
  const sourceArtifact = requestedSourceArtifactId
    ? artifacts.find((artifact) => artifact.id === requestedSourceArtifactId)
    : sourceRequired
      ? artifacts.find((artifact) =>
          ["SOURCE", "NORMALIZED_AUDIO", "STEM", "AUDIO_TRACK"].includes(
            artifact.type,
          ))
      : null;
  if (requestedSourceArtifactId && !sourceArtifact) {
    throw new Error("The requested ACE-Step source artifact is not part of this project");
  }
  if (sourceRequired && !sourceArtifact) {
    throw new Error(`${operation} requires a project-owned source audio artifact`);
  }
  const sourceArtifactId = sourceArtifact?.id ?? requestedSourceArtifactId;
  const normalizedParameters: GenerationParameters = {
    ...(input.parameters ?? {}),
    ...(operation ? { operation } : {}),
    ...(sourceArtifactId ? { sourceArtifactId } : {}),
    ...(instrument ? { instrument } : {}),
    ...(region ? { region } : {}),
    generationPreference,
  };
  const idempotencyKey = (input.idempotencyKey?.trim() ||
    `arrangement:${arrangement.id}:v${arrangement.version}:${task}:${sha256(JSON.stringify({
      candidates: count,
      provider: operation ? "ACE_STEP" : input.provider ?? null,
      hardware,
      speed,
      seed: input.seed ?? null,
      parameters: normalizedParameters,
    })).slice(0, 24)}`).slice(0, 200);
  // A caller supplied idempotency key is a reservation for one exact paid
  // request, not a general-purpose "return my last job" key.  In particular,
  // never let a changed provider, task, seed, or parameters silently reuse a
  // request that may already have reached a provider.
  const normalizedSeed = input.repair?.seed ?? (input.seed === undefined
    ? null
    : Math.max(0, Math.min(2_147_483_647, Math.trunc(input.seed))));
  const requestedCandidates = count;
  const [existingJob] = await db
    .select()
    .from(musicGenerationJobsTable)
    .where(and(
      eq(musicGenerationJobsTable.arrangementId, arrangement.id),
      eq(musicGenerationJobsTable.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  if (existingJob) {
    const sameRequest =
      existingJob.task === task &&
      existingJob.provider === provider.definition.id &&
      existingJob.modelVersion === provider.definition.modelVersion &&
      existingJob.hardware === hardware &&
      existingJob.speed === speed &&
      existingJob.requestedCandidates === requestedCandidates &&
      existingJob.songModelVersion === (songModels[0]?.version ?? null) &&
      existingJob.inputSnapshot.arrangement.version === arrangement.version &&
      (normalizedSeed === null || existingJob.seed === normalizedSeed) &&
      isDeepStrictEqual(existingJob.parameters, normalizedParameters);
    if (!sameRequest) {
      throw new Error("Idempotency key was already used with different generation input");
    }
    return existingJob;
  }
  const seed =
    normalizedSeed === null
      ? randomInt(1, 2_147_483_647)
      : normalizedSeed;
  const relevantArtifacts = artifacts.filter((artifact) =>
    ["SOURCE", "STEM", "SONG_MODEL", "ARRANGEMENT_PLAN", "MIDI"].includes(
      artifact.type,
    ),
  );
  const parentArtifactIds = [
    ...new Set([
      ...relevantArtifacts.map((artifact) => artifact.id),
      ...(sourceArtifactId ? [sourceArtifactId] : []),
    ]),
  ];
  const songModel = songModels[0];
  const songModelSnapshot =
    songModel?.model ?? {
      tempoMap: [{ time: 0, bpm: projectRow.bpm, confidence: projectRow.confidence }],
      meterMap: [{ bar: 1, meter: projectRow.meter, confidence: projectRow.confidence }],
      keyMap: [{ time: 0, key: projectRow.key, confidence: projectRow.confidence }],
      sections: projectRow.sections,
      energy: projectRow.energy,
      providers: projectRow.providers,
    };
  const jobId = randomUUID();
  const jobValues: typeof musicGenerationJobsTable.$inferInsert = {
      id: jobId,
      projectId: arrangement.projectId,
      arrangementId: arrangement.id,
      songModelId: songModel?.id ?? null,
      songModelVersion:
        songModel?.version ??
        relevantArtifacts.find((artifact) => artifact.type === "SONG_MODEL")
          ?.version ??
        null,
      task,
      status: "queued",
      provider: provider.definition.id,
      modelVersion: provider.definition.modelVersion,
      providerRuntime: provider.readiness,
      hardware,
      speed,
      progress: 0,
      stage: "queued",
      idempotencyKey,
      maxAttempts: input.repair?.maxAttempts ?? 3,
      retryable: true,
      requestedCandidates: count,
      seed,
      parameters: normalizedParameters,
      parentArtifactIds,
      inputSnapshot: {
        operation,
        sourceArtifactId: sourceArtifactId ?? null,
        instrument,
        region,
        arrangement: {
          id: arrangement.id,
          version: arrangement.version,
          style: arrangement.style,
          mode: arrangement.mode,
          status: arrangement.status,
          harmonyComplexity: arrangement.harmonyComplexity,
          energy: arrangement.energy,
          density: arrangement.density,
          orchestraSize: arrangement.orchestraSize,
          rhythmIntensity: arrangement.rhythmIntensity,
        },
        songModel: songModelSnapshot,
        tracks: projectTracks.map((track) => ({
          id: track.id,
          name: track.name,
          role: track.role,
          instrument: track.name,
        })),
        generationPreference,
        repair: input.repair ?? null,
      },
    };
  const job = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(musicGenerationJobsTable)
      .values(jobValues)
      .onConflictDoNothing({
        target: [
          musicGenerationJobsTable.arrangementId,
          musicGenerationJobsTable.idempotencyKey,
        ],
      })
      .returning();
    if (!created || !input.repair) return created;
    const [sourceCandidate] = await tx
      .select()
      .from(musicGenerationCandidatesTable)
      .where(and(
        eq(musicGenerationCandidatesTable.id, input.repair.sourceCandidateId),
        eq(musicGenerationCandidatesTable.projectId, arrangement.projectId),
      ))
      .limit(1);
    if (!sourceCandidate) {
      throw new Error("Repair source candidate is not part of this project");
    }
    const features = deployedCalibrationFeatures(sourceCandidate.evaluation);
    await appendProducerDecisionTx(tx, {
      ownerId,
      projectId: arrangement.projectId,
      domain: "repair",
      kind: "repair_requested",
      source: "inferred_behavior",
      context: {
        subjectId: sourceCandidate.id,
        modelVersion: sourceCandidate.modelVersion,
        lineageIds: sourceCandidate.parentArtifactIds,
        ...features,
      },
    });
    return created;
  });
  if (!job) {
    const [racedJob] = await db
      .select()
      .from(musicGenerationJobsTable)
      .where(and(
        eq(musicGenerationJobsTable.arrangementId, arrangement.id),
        eq(musicGenerationJobsTable.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    if (!racedJob) {
      throw new Error("Generation job disappeared after idempotent queueing");
    }
    const sameRequest =
      racedJob.task === task &&
      racedJob.provider === provider.definition.id &&
      racedJob.modelVersion === provider.definition.modelVersion &&
      racedJob.hardware === hardware &&
      racedJob.speed === speed &&
      racedJob.requestedCandidates === requestedCandidates &&
      racedJob.songModelVersion === (songModels[0]?.version ?? null) &&
      racedJob.inputSnapshot.arrangement.version === arrangement.version &&
      (normalizedSeed === null || racedJob.seed === normalizedSeed) &&
      isDeepStrictEqual(racedJob.parameters, normalizedParameters);
    if (!sameRequest) {
      throw new Error("Idempotency key was already used with different generation input");
    }
    return racedJob;
  }
  await db
    .update(arrangementsTable)
    .set({ status: "generating" })
    .where(eq(arrangementsTable.id, arrangement.id));
  setImmediate(() => {
    void runArrangementGeneration(jobId);
  });
  return job;
}

export async function runArrangementGeneration(jobId: string): Promise<void> {
  const workerId = randomUUID();
  const leaseDurationMs = 2 * 60 * 1000;
  const [job] = await db
    .update(musicGenerationJobsTable)
    .set({
      status: "running",
      progress: 12,
      stage: "preparing_inputs",
      workerId,
      leaseVersion: sql`${musicGenerationJobsTable.leaseVersion} + 1`,
      attempt: sql`${musicGenerationJobsTable.attempt} + 1`,
      heartbeatAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
    })
    .where(
      and(
        eq(musicGenerationJobsTable.id, jobId),
        eq(musicGenerationJobsTable.status, "queued"),
      ),
    )
    .returning();
  if (!job) return;
  const leaseVersion = job.leaseVersion;

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cancellationWatcher: ReturnType<typeof setInterval> | undefined;
  const abortController = new AbortController();
  const unpublishedEvaluationUrls: string[] = [];
  try {
    const provider = createProviderRegistry().find(
      (candidate) => candidate.definition.id === job.provider,
    );
    if (!provider) {
      throw new Error(`${job.provider} worker is not registered`);
    }
    const providerRuntime = await provider.checkHealth(true);
    const [owned] = await db
      .update(musicGenerationJobsTable)
      .set({
        progress: provider.available ? 30 : 12,
        stage: provider.available
          ? "running_model"
          : "provider_runtime_unavailable",
        providerRuntime,
      })
      .where(
        and(
          eq(musicGenerationJobsTable.id, job.id),
          eq(musicGenerationJobsTable.workerId, workerId),
          eq(musicGenerationJobsTable.leaseVersion, leaseVersion),
          eq(musicGenerationJobsTable.status, "running"),
          gt(musicGenerationJobsTable.leaseExpiresAt, new Date()),
        ),
      )
      .returning({ id: musicGenerationJobsTable.id });
    if (!owned) throw new Error("Generation job lease was lost");
    if (!provider.available) {
      throw new ProviderRuntimeUnavailableError(
        job.provider,
        providerRuntime.message ??
          "The configured provider has no verified checkpoint runtime.",
        providerRuntime.checkpointReady ||
          providerRuntime.message?.startsWith("Provider health check failed:") ===
            true,
      );
    }
    heartbeat = setInterval(() => {
      void db
        .update(musicGenerationJobsTable)
        .set({
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
        })
        .where(
          and(
            eq(musicGenerationJobsTable.id, job.id),
            eq(musicGenerationJobsTable.workerId, workerId),
            eq(musicGenerationJobsTable.leaseVersion, leaseVersion),
            eq(musicGenerationJobsTable.status, "running"),
            gt(musicGenerationJobsTable.leaseExpiresAt, new Date()),
          ),
        );
    }, 30_000);
    cancellationWatcher = setInterval(() => {
      void db
        .select({ status: musicGenerationJobsTable.status })
        .from(musicGenerationJobsTable)
        .where(and(
          eq(musicGenerationJobsTable.id, job.id),
          eq(musicGenerationJobsTable.workerId, workerId),
          eq(musicGenerationJobsTable.leaseVersion, leaseVersion),
          gt(musicGenerationJobsTable.leaseExpiresAt, new Date()),
        ))
        .limit(1)
        .then(([current]) => {
          if (!current || current.status === "cancel_requested") {
            abortController.abort();
          }
        });
    }, 1_000);

    const snapshot = job.inputSnapshot;
    const evaluationSongModel = normalizeSongModelSnapshot(snapshot.songModel);
    let sourceAudio: {
      artifactId: string;
      url: string;
    } | undefined;
    if (snapshot.sourceArtifactId) {
      const [sourceArtifact] = await db
        .select()
        .from(musicArtifactsTable)
        .where(and(
          eq(musicArtifactsTable.id, snapshot.sourceArtifactId),
          eq(musicArtifactsTable.projectId, job.projectId),
        ))
        .limit(1);
      const sourceUpload =
        sourceArtifact?.storageUri &&
        isSourceObjectPath(sourceArtifact.storageUri);
      const providerAudio =
        sourceArtifact?.storageUri &&
        isPrivateExportObjectPath(sourceArtifact.storageUri) &&
        sourceArtifact.type === "AUDIO_TRACK" &&
        sourceArtifact.format === "WAV" &&
        sourceArtifact.createdBy === "gpu-provider-output-ingest";
      if (!sourceArtifact?.storageUri || (!sourceUpload && !providerAudio)) {
        throw new Error("ACE-Step source artifact is unavailable or has an invalid storage location");
      }
      sourceAudio = {
        artifactId: sourceArtifact.id,
        url: sourceUpload
          ? await createSourceDownloadUrl(sourceArtifact.storageUri)
          : await createPrivateExportDownloadUrl(sourceArtifact.storageUri),
      };
    }
    // Check ownership immediately before the non-transactional provider call.
    // Provider calls cannot be rolled back, so a recovered worker must not
    // issue one after a newer lease has fenced it out.
    const [providerCallOwner] = await db
      .select({ id: musicGenerationJobsTable.id })
      .from(musicGenerationJobsTable)
      .where(and(
        eq(musicGenerationJobsTable.id, job.id),
        eq(musicGenerationJobsTable.workerId, workerId),
        eq(musicGenerationJobsTable.leaseVersion, leaseVersion),
        eq(musicGenerationJobsTable.status, "running"),
        gt(musicGenerationJobsTable.leaseExpiresAt, new Date()),
      ))
      .limit(1);
    if (!providerCallOwner || abortController.signal.aborted) {
      throw new Error("Generation job lease was lost before provider dispatch");
    }
    const result = await provider.generate(
      {
        jobId: job.id,
        projectId: job.projectId,
        arrangementId: job.arrangementId,
        task: job.task,
        style: snapshot.arrangement.style,
        mode: snapshot.arrangement.mode,
        hardware: job.hardware as GenerationHardware,
        speed: job.speed as GenerationSpeed,
        candidates: job.requestedCandidates,
        seed: job.seed,
        parameters: {
          ...job.parameters,
          ...(snapshot.repair
            ? {
                repair: {
                  sourceCandidateId: snapshot.repair.sourceCandidateId,
                  finding: snapshot.repair.finding,
                  seed: snapshot.repair.seed,
                  attempt: job.attempt,
                  maxAttempts: snapshot.repair.maxAttempts,
                },
              }
            : {}),
          candidateStrategies: Array.from(
            { length: job.requestedCandidates },
            (_, index) => ({
              name: strategyForCandidate(index),
              index,
              seed: seedForCandidate(job.seed, index),
            }),
          ),
        },
        operation: snapshot.operation ?? undefined,
        sourceAudio,
        instrument: snapshot.instrument ?? undefined,
        region: snapshot.region ?? undefined,
        parentArtifactIds: job.parentArtifactIds,
        songModel: snapshot.songModel,
        tracks: snapshot.tracks,
        arrangement: {
          version: snapshot.arrangement.version,
          harmonyComplexity: snapshot.arrangement.harmonyComplexity,
          energy: snapshot.arrangement.energy,
          density: snapshot.arrangement.density,
          orchestraSize: snapshot.arrangement.orchestraSize,
          rhythmIntensity: snapshot.arrangement.rhythmIntensity,
        },
      },
      async (progress) => {
        const [progressOwner] = await db
          .update(musicGenerationJobsTable)
          .set({
            progress: progress.progress,
            stage: progress.stage,
            providerRequestId: progress.requestId,
            providerCancelUrl: progress.cancelUrl,
            heartbeatAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
          })
          .where(
            and(
              eq(musicGenerationJobsTable.id, job.id),
              eq(musicGenerationJobsTable.workerId, workerId),
              eq(musicGenerationJobsTable.leaseVersion, leaseVersion),
              eq(musicGenerationJobsTable.status, "running"),
              gt(musicGenerationJobsTable.leaseExpiresAt, new Date()),
            ),
          )
          .returning({ id: musicGenerationJobsTable.id });
        if (!progressOwner) abortController.abort();
      },
      abortController.signal,
    );
    const [rankingOwner] = await db
      .update(musicGenerationJobsTable)
      .set({
        providerRequestId: result.requestId,
        progress: 70,
        stage: "rendering_candidates",
      })
      .where(
        and(
          eq(musicGenerationJobsTable.id, job.id),
          eq(musicGenerationJobsTable.workerId, workerId),
          eq(musicGenerationJobsTable.leaseVersion, leaseVersion),
          eq(musicGenerationJobsTable.status, "running"),
          gt(musicGenerationJobsTable.leaseExpiresAt, new Date()),
        ),
      )
      .returning({ id: musicGenerationJobsTable.id });
    if (!rankingOwner) throw new Error("Generation job lease was lost");

    if (result.candidates.length !== job.requestedCandidates) {
      throw new ProviderIncompleteResultError(
        provider.definition.id,
        job.requestedCandidates,
        result.candidates.length,
      );
    }
    const providerCandidates = result.candidates;
    const artifactRows: Array<typeof musicArtifactsTable.$inferInsert> = [];
    const candidateRows: Array<
      typeof musicGenerationCandidatesTable.$inferInsert & {
        evaluation: CandidateEvaluation;
        score: number;
      }
    > = [];
    for (const [providerIndex, providerCandidate] of providerCandidates.entries()) {
      // Provider-provided seeds are metadata, not the source of candidate
      // identity. The request seed and stable strategy rotation must survive a
      // lease recovery and any provider retry unchanged.
      const strategy = strategyForCandidate(providerIndex);
      const candidate = {
        ...providerCandidate,
        seed: seedForCandidate(job.seed, providerIndex),
        parameters: {
          ...providerCandidate.parameters,
          candidateStrategy: strategy,
        },
      };
      if (abortController.signal.aborted) {
        throw new ProviderCancellationAcknowledgedError(
          "Generation cancelled before candidate evaluation completed",
        );
      }
      const candidateId = randomUUID();
      const planArtifactId = randomUUID();
      const candidateParentIds = snapshot.repair
        ? [...new Set(job.parentArtifactIds)]
        : [
            ...new Set([
              ...job.parentArtifactIds,
              ...candidate.parentArtifactIds,
            ]),
          ];
      const serializedProviderPlan = JSON.stringify(candidate.plan);
      const planChecksum = sha256(serializedProviderPlan);
      artifactRows.push({
        id: planArtifactId,
        projectId: job.projectId,
        type: "ARRANGEMENT_PLAN",
        label: `${candidate.label} · ${provider.definition.displayName}`,
        version: snapshot.arrangement.version,
        size: `${Buffer.byteLength(serializedProviderPlan)} B`,
        format: "JSON",
        hash: planChecksum,
        checksum: planChecksum,
        parentIds: candidateParentIds,
        createdBy: "arrangement-provider",
        modelVersion: `${provider.definition.id}@${result.modelVersion}`,
        provider: provider.definition.id,
        retentionPolicy: "project",
        technicalMetadata: {
          mediaType: "application/json",
          providerOrdinal: providerIndex + 1,
          providerScore: candidate.score,
          confidence: candidate.confidence,
          generationSeed: candidate.seed,
          candidateStrategy: strategy,
          generationParameters: JSON.stringify(job.parameters),
          providerRuntimeProvenance: JSON.stringify(result.runtimeProvenance ?? null),
          ...(result.checkpointSha256
            ? { checkpointSha256: result.checkpointSha256 }
            : {}),
        },
        storageUri: `db://music_generation_candidates/${candidateId}`,
      });

      let phase: CandidateEvaluation["status"] = "rendering";
      let evaluation: CandidateEvaluation;
      let materializedTrackModels: TrackModel[] | null = null;
      let materializedHarmonyDecisions: HarmonyDecisionEvidence[] = [];
      let evaluatedPlan: ArrangementPlan | null = null;
      let evaluatedStyleSpec: ReturnType<typeof createStyleSpec> | null = null;
      let evaluationScore = 0;
      let candidateStatus = "rejected";
      const candidateObjectUrls: string[] = [];
      try {
        const audioArtifactId = randomUUID();
        const midiArtifactId = randomUUID();
        const qualityArtifactId = randomUUID();
        const proposedMaterialized = materializeCandidate({
          candidateId,
          version: snapshot.arrangement.version + 1,
          source: snapshot.arrangement,
          songModel: evaluationSongModel,
          songModelVersion: job.songModelVersion,
          tracks: snapshot.tracks,
          candidate: {
            provider: provider.definition.id,
            // Bounded repair is a child revision of the persisted source, not
            // a fresh candidate identity. Keep both generation and reasoning
            // seeds source-owned through materialization.
            seed: snapshot.repair?.seed ?? candidate.seed,
            plan: candidate.plan,
            parentArtifactIds: candidateParentIds,
            trackModels: candidate.trackModels,
          },
          generationPreference: snapshot.generationPreference ?? null,
        });
        const bounded = snapshot.repair
          ? applyBoundedRepair({
              snapshot: snapshot.repair,
              proposedPlan: proposedMaterialized.plan,
              proposedTrackModels: proposedMaterialized.trackModels,
              timeBounds: repairTimeBounds(
                snapshot.repair.finding,
                evaluationSongModel.tempoMap.map(({ time, bpm }) => ({ time, bpm })),
                evaluationSongModel.meterMap.map(({ bar, meter }) => ({ bar, meter })),
              ),
            })
          : null;
        if (bounded && !bounded.outsideScopePreserved) {
          phase = "analyzing";
          throw new RepairScopeViolationError();
        }
        const materialized = bounded
          ? {
              ...proposedMaterialized,
              plan: bounded.plan,
              trackModels: bounded.trackModels,
            }
          : proposedMaterialized;
        materializedTrackModels = materialized.trackModels;
        materializedHarmonyDecisions = materialized.harmonyDecisions;
        evaluatedPlan = materialized.plan;
        evaluatedStyleSpec = materialized.styleSpec;
        const evaluatedAt = new Date().toISOString();
        // Provider audio is a whole-file result. A bounded repair may only use
        // the canonically merged TrackModels unless a future provider supplies
        // a verifiable regional audio splice contract.
        const providerWav = candidate.audioArtifact && !snapshot.repair
          ? await ingestProviderAudio(candidate.audioArtifact)
          : null;
        const hasSymbolicTrackModels = materialized.trackModels.length > 0;
        if (!providerWav && !hasSymbolicTrackModels) {
          throw new Error(
            "Candidate produced neither provider audio nor symbolic TrackModels",
          );
        }
        const renderArtifactIds = hasSymbolicTrackModels
          ? [audioArtifactId, midiArtifactId]
          : [audioArtifactId];
        const pipeline = renderMusicPipeline({
          songModel: evaluationSongModel,
          plan: materialized.plan,
          tracks: snapshot.tracks,
          trackModels: materialized.trackModels,
          style: materialized.styleSpec,
          seed: candidate.seed,
          masterProfile: "BALANCED",
          quality: {
            lineageComplete:
              Boolean(result.modelVersion && provider.definition.id) &&
              materialized.trackModels.every((track) =>
                Boolean(
                  track.provenance.model &&
                  track.provenance.version &&
                  track.provenance.createdBy,
                )),
            renderArtifactIds,
            evaluatedAt,
          },
        });
        const wav = providerWav ?? encodeWav(pipeline.master);
        // Analyze precisely the bytes persisted as the audio artifact, after WAV quantization.
        const renderedPcm = decodePcm16Wav(wav, 44_100);
        const quality = providerWav
          ? new QualityEngine().assess(
              materialized.trackModels,
              renderedPcm,
              materialized.plan,
              {
                lineageComplete: pipeline.quality.lineageComplete,
                renderArtifactIds,
                evaluatedAt,
                bpm: evaluationSongModel.tempoMap[0]?.bpm ?? 92,
                meter: evaluationSongModel.meterMap[0]?.meter ?? "4/4",
              },
            )
          : pipeline.quality;
        const musicCritic = evaluateCandidateMusicalFit({
          songModel: evaluationSongModel,
          plan: materialized.plan,
          tracks: materialized.trackModels,
          harmonyDecisions: materialized.harmonyDecisions,
        });
        const audioCritic = evaluateRenderedPcm({
          pcm: renderedPcm,
          sampleRate: 44_100,
          channels: 2,
          artifactId: audioArtifactId,
          artifactSha256: sha256(wav),
          ...(providerWav ? {} : { renderedTracks: pipeline.tracks.map((track) => ({
            id: track.trackModel.id, pcm: track.samples, channels: 2, sampleRate: 44_100,
          })) }),
          vocalEvidence: evaluationSongModel.vocalEvidence,
          analyzedDurationSeconds: evaluationSongModel.analysisDurationSeconds ??
            evaluationSongModel.audio.durationSeconds,
        });
        const candidateDuration =
          candidate.audioArtifact?.durationSeconds ?? pipeline.durationSeconds;
        const midi = hasSymbolicTrackModels
          ? createPerformanceMidi(
              materialized.trackModels,
              evaluationSongModel.tempoMap[0]?.bpm ?? 92,
              evaluationSongModel.meterMap[0]?.meter ?? "4/4",
              candidateDuration,
            )
          : null;
        const objectPrefix = `generation/${job.id}/${candidateId}`;
        const audioUrl = await saveExportObject(
          `${objectPrefix}/render.wav`,
          wav,
          "audio/wav",
        );
        candidateObjectUrls.push(audioUrl);
        unpublishedEvaluationUrls.push(audioUrl);
        const midiUrl = midi
          ? await saveExportObject(
              `${objectPrefix}/performance.mid`,
              midi,
              "audio/midi",
            )
          : null;
        if (midiUrl) {
          candidateObjectUrls.push(midiUrl);
          unpublishedEvaluationUrls.push(midiUrl);
        }
        phase = "analyzing";
        const requiredDimensions = [
          "silence",
          "clipping",
          "notePlayability",
          "timing",
          "sectionCoverage",
          "lineage",
        ];
        const renderArtifactIdSet = new Set<string>(renderArtifactIds);
        if (
          !Number.isFinite(quality.score) ||
          !quality.lineageComplete ||
          quality.renderArtifactIds.length !== renderArtifactIds.length ||
          quality.renderArtifactIds.some((id) => !renderArtifactIdSet.has(id)) ||
          requiredDimensions.some((name) =>
            !Number.isFinite(quality.checks[name]))
        ) {
          throw new Error("Independent quality analysis is incomplete");
        }
        const qualityData = Buffer.from(JSON.stringify({
          candidateId,
          provider: provider.definition.id,
          modelVersion: job.modelVersion,
          reportedModelVersion: result.modelVersion,
          checkpointSha256: result.checkpointSha256,
          providerRequestId: candidate.providerRequestId ?? result.requestId,
          seed: candidate.seed,
          parameters: job.parameters,
          runtimeProvenance: result.runtimeProvenance ?? null,
          providerScore: candidate.score,
          quality,
          musicCritic,
           audioCritic,
        }, null, 2));
        const qualityUrl = await saveExportObject(
          `${objectPrefix}/quality-report.json`,
          qualityData,
          "application/json",
        );
        candidateObjectUrls.push(qualityUrl);
        unpublishedEvaluationUrls.push(qualityUrl);
        evaluation = {
          status: "evaluated",
          providerScore: candidate.score,
          renderArtifactIds,
          artifacts: [
            { id: audioArtifactId, type: "AUDIO_TRACK", label: "Rendered audio", url: audioUrl, artifactSha256: sha256(wav) },
            ...(midiUrl
              ? [{ id: midiArtifactId, type: "MIDI" as const, label: "Performance MIDI", url: midiUrl }]
              : []),
            { id: qualityArtifactId, type: "QUALITY_REPORT", label: "Quality report", url: qualityUrl },
          ],
          qualityReport: quality,
          musicCritic,
           audioCritic,
          error: null,
          strategy: {
            name: strategy,
            index: providerIndex,
            baseSeed: job.seed,
            seed: candidate.seed,
          },
          ...(snapshot.repair
            ? {
                repair: {
                  sourceCandidateId: snapshot.repair.sourceCandidateId,
                  sourceCandidateLabel: snapshot.repair.sourceCandidateLabel,
                  findingId: snapshot.repair.finding.id,
                  seed: snapshot.repair.seed,
                  attempt: job.attempt,
                  maxAttempts: snapshot.repair.maxAttempts,
                  scope: {
                    affectedSections: snapshot.repair.finding.affectedSections,
                    startBar: snapshot.repair.finding.startBar,
                    endBar: snapshot.repair.finding.endBar,
                    affectedTrackIds: snapshot.repair.finding.affectedTrackIds,
                  },
                  musicalReason: snapshot.repair.finding.musicalReason,
                  outsideScopePreserved: true,
                  changedScopes: bounded?.changedScopes ?? [],
                  sourceQualityScore: snapshot.repair.sourceScore,
                  repairedQualityScore: (musicCritic.score + (audioCritic.score ?? musicCritic.score)) / 2,
                  improved: (musicCritic.score + (audioCritic.score ?? musicCritic.score)) / 2 > snapshot.repair.sourceScore,
                },
              }
            : {}),
        };
        evaluationScore = (musicCritic.score + (audioCritic.score ?? musicCritic.score)) / 2;
        candidateStatus = snapshot.repair && evaluationScore <= snapshot.repair.sourceScore
          ? "repair_not_improved"
          : "validated";
        if (candidateStatus === "repair_not_improved") {
          evaluation.status = "repair_not_improved";
        }
        const artifactParentIds = [planArtifactId, ...candidateParentIds];
        artifactRows.push({
            id: audioArtifactId,
            projectId: job.projectId,
            type: "AUDIO_TRACK",
            label: providerWav
              ? `${candidate.label} · ACE-Step generated accompaniment`
              : `${candidate.label} · evaluation render`,
            version: snapshot.arrangement.version,
            size: `${wav.byteLength} B`,
            format: "WAV",
            url: audioUrl,
            storageUri: audioUrl,
            hash: sha256(wav),
            checksum: sha256(wav),
            parentIds: artifactParentIds,
            createdBy: providerWav
              ? "gpu-provider-output-ingest"
              : "candidate-render-evaluator",
            modelVersion: providerWav
              ? result.modelVersion
              : "LOCAL_EXPRESSIVE_SYNTH@1.0.0",
            provider: provider.definition.id,
            technicalMetadata: {
              mediaType: "audio/wav",
              bytes: wav.byteLength,
              durationSeconds: candidateDuration,
              candidateId,
              generationSeed: candidate.seed,
              generationParameters: JSON.stringify(job.parameters),
              audioSource: providerWav
                ? "provider-output"
                : "local-evaluation-render",
              ...(candidate.audioArtifact
                ? {
                    providerArtifactSha256: candidate.audioArtifact.sha256,
                    providerArtifactFormat: candidate.audioArtifact.format,
                    providerArtifactBytes: candidate.audioArtifact.bytes,
                  }
                : {}),
              providerRuntimeProvenance: JSON.stringify(result.runtimeProvenance ?? null),
              ...(result.checkpointSha256
                ? { checkpointSha256: result.checkpointSha256 }
                : {}),
            },
          });
        if (midi && midiUrl) {
          artifactRows.push({
            id: midiArtifactId,
            projectId: job.projectId,
            type: "MIDI",
            label: `${candidate.label} · evaluation MIDI`,
            version: snapshot.arrangement.version,
            size: `${midi.byteLength} B`,
            format: "MIDI",
            url: midiUrl,
            storageUri: midiUrl,
            hash: sha256(midi),
            checksum: sha256(midi),
            parentIds: artifactParentIds,
            createdBy: "candidate-render-evaluator",
            modelVersion: "PERFORMANCE_MIDI@1.0.0",
            provider: provider.definition.id,
            technicalMetadata: {
              mediaType: "audio/midi",
              bytes: midi.byteLength,
              durationSeconds: candidateDuration,
              candidateId,
              generationSeed: candidate.seed,
              generationParameters: JSON.stringify(job.parameters),
              providerRuntimeProvenance: JSON.stringify(result.runtimeProvenance ?? null),
              ...(result.checkpointSha256
                ? { checkpointSha256: result.checkpointSha256 }
                : {}),
            },
          });
        }
        artifactRows.push({
            id: qualityArtifactId,
            projectId: job.projectId,
            type: "QUALITY_REPORT",
            label: `${candidate.label} · independent quality`,
            version: snapshot.arrangement.version,
            size: `${qualityData.byteLength} B`,
            format: "JSON",
            url: qualityUrl,
            storageUri: qualityUrl,
            hash: sha256(qualityData),
            checksum: sha256(qualityData),
            parentIds: [...renderArtifactIds, planArtifactId],
            createdBy: "quality-engine",
            modelVersion: "QUALITY_ENGINE@1.0.0",
            provider: provider.definition.id,
            technicalMetadata: {
              mediaType: "application/json",
              bytes: qualityData.byteLength,
              qualityScore: quality.score,
              candidateId,
              generationSeed: candidate.seed,
              generationParameters: JSON.stringify(job.parameters),
              providerRuntimeProvenance: JSON.stringify(result.runtimeProvenance ?? null),
              ...(result.checkpointSha256
                ? { checkpointSha256: result.checkpointSha256 }
                : {}),
            },
          });
      } catch (error) {
        await Promise.all(candidateObjectUrls.map((url) =>
          deleteExportObject(url).catch(() => undefined)));
        for (const url of candidateObjectUrls) {
          const index = unpublishedEvaluationUrls.indexOf(url);
          if (index >= 0) unpublishedEvaluationUrls.splice(index, 1);
        }
        evaluation = {
          status: error instanceof RepairScopeViolationError
            ? "repair_scope_violated"
            : phase === "analyzing" ? "analysis_failed" : "render_failed",
          providerScore: candidate.score,
          renderArtifactIds: [],
          artifacts: [],
          qualityReport: null,
          musicCritic: null,
          audioCritic: null,
          error: error instanceof Error ? error.message : "Candidate evaluation failed",
          strategy: {
            name: strategy,
            index: providerIndex,
            baseSeed: job.seed,
            seed: candidate.seed,
          },
          ...(snapshot.repair
            ? {
                repair: {
                  sourceCandidateId: snapshot.repair.sourceCandidateId,
                  sourceCandidateLabel: snapshot.repair.sourceCandidateLabel,
                  findingId: snapshot.repair.finding.id,
                  seed: snapshot.repair.seed,
                  attempt: job.attempt,
                  maxAttempts: snapshot.repair.maxAttempts,
                  scope: {
                    affectedSections: snapshot.repair.finding.affectedSections,
                    startBar: snapshot.repair.finding.startBar,
                    endBar: snapshot.repair.finding.endBar,
                    affectedTrackIds: snapshot.repair.finding.affectedTrackIds,
                  },
                  musicalReason: snapshot.repair.finding.musicalReason,
                  outsideScopePreserved: !(error instanceof RepairScopeViolationError),
                  changedScopes: [],
                  sourceQualityScore: snapshot.repair.sourceScore,
                  repairedQualityScore: null,
                  improved: false,
                },
              }
            : {}),
        };
      }
      candidateRows.push({
        id: candidateId,
        jobId: job.id,
        projectId: job.projectId,
        arrangementId: job.arrangementId,
        artifactId: planArtifactId,
        providerRequestId: candidate.providerRequestId ?? result.requestId,
        provider: provider.definition.id,
        modelVersion: job.modelVersion,
        reportedModelVersion: result.modelVersion,
        checkpointSha256: result.checkpointSha256,
        seed: candidate.seed,
        rank: null,
        label: candidate.label,
        score: evaluationScore,
        confidence: candidate.confidence,
        summary: candidate.summary,
        status: candidateStatus,
        parameters: {
          ...job.parameters,
          ...candidate.parameters,
          providerScore: candidate.score,
          harmonyDecisions: materializedHarmonyDecisions,
          candidateStrategy: strategy,
        },
        parentArtifactIds: candidateParentIds,
        plan: candidate.plan,
        trackModels: materializedTrackModels,
        evaluatedPlan,
        evaluatedStyleSpec,
        evaluation,
      });
      await db
        .update(musicGenerationJobsTable)
        .set({
          progress: 70 + Math.round(((providerIndex + 1) / providerCandidates.length) * 22),
          stage: phase === "analyzing" ? "analyzing_candidates" : "rendering_candidates",
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
        })
        .where(and(
          eq(musicGenerationJobsTable.id, job.id),
          eq(musicGenerationJobsTable.workerId, workerId),
          eq(musicGenerationJobsTable.leaseVersion, leaseVersion),
          eq(musicGenerationJobsTable.status, "running"),
        ));
    }
    const acceptedFingerprints: Array<{ id: string; fingerprint: ReturnType<typeof fingerprintCandidate> }> = [];
    for (const candidate of candidateRows) {
      if (
        !candidate.evaluatedPlan ||
        !candidate.trackModels ||
        !hasCompleteQualityEvidence(candidate.evaluation)
      ) continue;
      const evidence = diversityEvidence(
        fingerprintCandidate(candidate.evaluatedPlan, candidate.trackModels),
        acceptedFingerprints,
      );
      candidate.evaluation = { ...candidate.evaluation, diversity: evidence };
      if (evidence.rejected) {
        candidate.status = "diversity_rejected";
        candidate.rank = null;
      } else {
        acceptedFingerprints.push({ id: candidate.id, fingerprint: evidence.fingerprint });
      }
    }
    const ranked = rankEvaluatedCandidates(candidateRows);
    const allEvaluationsFailed = ranked.every((candidate) =>
      !hasCompleteQualityEvidence(candidate.evaluation));
    const diversityEvaluated = ranked.filter((candidate) =>
      candidate.evaluation.diversity !== undefined);
    const insufficientDiversity = diversityEvaluated.length > 1 &&
      diversityEvaluated.filter((candidate) =>
        !candidate.evaluation.diversity?.rejected).length === 1;
    const now = new Date();
    await db.transaction(async (tx) => {
      const [completed] = await tx
        .update(musicGenerationJobsTable)
        .set({
          status: allEvaluationsFailed ? "failed" : "succeeded",
          progress: 100,
          stage: allEvaluationsFailed
            ? "evaluation_failed"
            : insufficientDiversity
              ? "insufficient_diversity"
              : "complete",
          error: allEvaluationsFailed
            ? "No candidate produced complete render and quality evidence."
            : null,
          errorCode: allEvaluationsFailed
            ? "CANDIDATE_EVALUATION_FAILED"
            : insufficientDiversity
              ? "INSUFFICIENT_DIVERSITY"
              : null,
          retryable: !allEvaluationsFailed,
          completedAt: now,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(musicGenerationJobsTable.id, job.id),
            eq(musicGenerationJobsTable.workerId, workerId),
            eq(musicGenerationJobsTable.leaseVersion, leaseVersion),
            eq(musicGenerationJobsTable.status, "running"),
            gt(musicGenerationJobsTable.leaseExpiresAt, now),
          ),
        )
        .returning({ id: musicGenerationJobsTable.id });
      if (!completed) throw new Error("Generation job lease was lost");
      await tx.insert(musicArtifactsTable).values(artifactRows);
      await tx.insert(musicGenerationCandidatesTable).values(ranked);
      if (snapshot.repair) {
        const [project] = await tx
          .select({ ownerId: musicProjectsTable.ownerId })
          .from(musicProjectsTable)
          .where(eq(musicProjectsTable.id, job.projectId))
          .limit(1);
        if (!project?.ownerId) throw new Error("Repair project owner disappeared");
        for (const repairedCandidate of ranked) {
          const improved = repairedCandidate.status === "validated" &&
            repairedCandidate.evaluation.repair?.improved === true;
          await appendProducerDecisionTx(tx, {
            ownerId: project.ownerId,
            projectId: job.projectId,
            domain: "repair",
            kind: "repair_completed",
            source: "inferred_behavior",
            reasons: [improved ? "improved" : "rejected"],
            context: {
              subjectId: snapshot.repair.sourceCandidateId,
              comparedSubjectId: repairedCandidate.id,
              modelVersion: repairedCandidate.modelVersion,
              lineageIds: repairedCandidate.parentArtifactIds,
              ...deployedCalibrationFeatures(repairedCandidate.evaluation),
            },
          });
        }
      }
      await tx
        .update(arrangementsTable)
        .set({
          status: allEvaluationsFailed
            ? (snapshot.arrangement.status === "ready" ? "ready" : "draft")
            : "ready",
        })
        .where(eq(arrangementsTable.id, job.arrangementId));
      await tx.insert(studioActivitiesTable).values({
        id: randomUUID(),
        projectId: job.projectId,
        title: allEvaluationsFailed
          ? "Candidate evaluation failed"
          : "Rendered candidate evaluation completed",
          detail: insufficientDiversity
            ? `${provider.definition.displayName} · insufficient_diversity: only the retained baseline is selectable`
            : `${provider.definition.displayName} · ${ranked.filter((candidate) => candidate.status === "validated").length}/${ranked.length} candidates passed render and quality analysis`,
        type: "arrangement",
      });
    });
    unpublishedEvaluationUrls.length = 0;
  } catch (error) {
    await Promise.all(unpublishedEvaluationUrls.map((url) =>
      deleteExportObject(url).catch(() => undefined)));
    const message = error instanceof Error ? error.message : "Generation failed";
    const cancellationUnconfirmed =
      error instanceof ProviderCancellationUnconfirmedError;
    const cancelled =
      error instanceof ProviderCancellationAcknowledgedError ||
      (abortController.signal.aborted && !cancellationUnconfirmed);
    const runtimeUnavailable = error instanceof ProviderRuntimeUnavailableError;
    const incompleteProviderResult = error instanceof ProviderIncompleteResultError;
    const retryable = !cancelled && !cancellationUnconfirmed &&
      (!runtimeUnavailable || error.retryable) &&
      !incompleteProviderResult &&
      !/invalid|unauthorized|forbidden|not configured|license/i.test(message);
    const willRetry = retryable && job.attempt < job.maxAttempts;
    const originalStatus = job.inputSnapshot.arrangement.status === "ready"
      ? "ready"
      : "draft";
    await db.transaction(async (tx) => {
      const [failed] = await tx
        .update(musicGenerationJobsTable)
        .set({
          status: cancelled
            ? "cancelled"
            : cancellationUnconfirmed
              ? "cancel_requested"
              : willRetry
                ? "queued"
                : "failed",
          progress: cancelled || (!willRetry && !cancellationUnconfirmed)
            ? 100
            : cancellationUnconfirmed
              ? job.progress
              : 5,
          stage: cancelled
            ? "cancelled"
            : cancellationUnconfirmed
              ? "cancellation_pending"
              : willRetry
                ? "retry_queued"
                : "failed",
          error: cancelled ? null : message,
          errorCode: cancelled
            ? "CANCELLED"
            : cancellationUnconfirmed
              ? "PROVIDER_CANCELLATION_UNCONFIRMED"
              : runtimeUnavailable
                ? "PROVIDER_RUNTIME_UNAVAILABLE"
                  : incompleteProviderResult
                    ? "PROVIDER_INCOMPLETE_RESULT"
                : "PROVIDER_EXECUTION_FAILED",
          retryable,
          workerId: willRetry || cancellationUnconfirmed ? null : workerId,
          completedAt: cancelled || (!willRetry && !cancellationUnconfirmed)
            ? new Date()
            : null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(musicGenerationJobsTable.id, job.id),
            eq(musicGenerationJobsTable.workerId, workerId),
            eq(musicGenerationJobsTable.leaseVersion, leaseVersion),
            or(
              eq(musicGenerationJobsTable.status, "running"),
              eq(musicGenerationJobsTable.status, "cancel_requested"),
            ),
            gt(musicGenerationJobsTable.leaseExpiresAt, new Date()),
          ),
        )
        .returning({ id: musicGenerationJobsTable.id });
      if (failed && !willRetry) {
        await tx
          .update(arrangementsTable)
          .set({ status: originalStatus })
          .where(eq(arrangementsTable.id, job.arrangementId));
      }
    });
    if (willRetry) {
      setImmediate(() => {
        void runArrangementGeneration(job.id);
      });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (cancellationWatcher) clearInterval(cancellationWatcher);
  }
}

class ProviderRuntimeUnavailableError extends Error {
  constructor(
    providerId: string,
    detail: string,
    readonly retryable: boolean,
  ) {
    super(`${providerId} is configured but unavailable: ${detail}`);
  }
}

class ProviderIncompleteResultError extends Error {
  constructor(
    providerId: string,
    requested: number,
    received: number,
  ) {
    super(
      `${providerId} returned an incomplete candidate set: requested ${requested}, received ${received}`,
    );
  }
}

class RepairScopeViolationError extends Error {
  constructor() {
    super("Repair changed canonical content outside the critic-declared scope");
  }
}

export async function queueCandidateRepair(
  candidateId: string,
  findingId: string,
  finding: CriticRepairFinding,
  ownerId: string,
  idempotencyKey?: string,
) {
  const [candidate] = await db
    .select()
    .from(musicGenerationCandidatesTable)
    .where(eq(musicGenerationCandidatesTable.id, candidateId))
    .limit(1);
  if (
    !candidate ||
    candidate.status !== "validated" ||
    !candidate.evaluatedPlan ||
    !candidate.trackModels ||
    !hasCompleteQualityEvidence(candidate.evaluation)
  ) return null;
  const [project] = await db
    .select({ ownerId: musicProjectsTable.ownerId })
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, candidate.projectId))
    .limit(1);
  if (project?.ownerId !== ownerId) return null;
  const audioFinding = candidate.evaluation.audioCritic?.dimensions
    ? Object.values(candidate.evaluation.audioCritic.dimensions)
      .flatMap((dimension) => dimension.findings).find((item) => item.id === findingId)
    : undefined;
  const normalizedFinding = audioFinding
    ? await (async () => {
        const [job] = await db.select({ songModelId: musicGenerationJobsTable.songModelId })
          .from(musicGenerationJobsTable).where(eq(musicGenerationJobsTable.id, candidate.jobId)).limit(1);
        if (!job?.songModelId) throw new Error("Audio finding cannot be mapped without canonical song timing");
        const [songModel] = await db.select({ model: songModelsTable.model }).from(songModelsTable)
          .where(eq(songModelsTable.id, job.songModelId)).limit(1);
        if (!songModel) throw new Error("Audio finding cannot be mapped without its song model");
        return audioFindingToRepairFinding({
          finding: audioFinding, plan: candidate.evaluatedPlan!, trackModels: candidate.trackModels!,
          tempoMap: songModel.model.tempoMap, meterMap: songModel.model.meterMap,
        });
      })()
    : validateServerAuthoredRepairFinding(
      findingId, finding,
      Object.values(candidate.evaluation.musicCritic!.dimensions).flatMap((dimension) => dimension.findings ?? []),
      candidate.evaluatedPlan, candidate.trackModels,
    );
  // A bounded repair is another evaluation of the persisted candidate, not a
  // new stochastic branch. Its seed remains source-owned end to end.
  const seed = boundedRepairSourceSeed(candidate.seed);
  return queueArrangementGeneration(candidate.arrangementId, {
    candidates: 1,
    provider: candidate.provider as MusicProviderId,
    task: "ARRANGEMENT",
    seed,
    idempotencyKey: idempotencyKey?.trim() ||
      `repair:${candidate.id}:${sha256(JSON.stringify(normalizedFinding)).slice(0, 24)}`,
    parameters: { repairSourceCandidateId: candidate.id },
    repair: {
      sourceCandidateId: candidate.id,
      sourceCandidateLabel: candidate.label,
      sourceScore: audioFinding
        ? (candidate.evaluation.musicCritic!.score + (candidate.evaluation.audioCritic!.score ?? 0)) / 2
        : candidate.evaluation.musicCritic!.score,
      seed,
      maxAttempts: MAX_REPAIR_ATTEMPTS,
      finding: normalizedFinding,
      plan: candidate.evaluatedPlan,
      trackModels: candidate.trackModels,
    },
  }, ownerId);
}

export async function resumePendingGenerationJobs(): Promise<void> {
  const now = new Date();
  const pendingCancellations = await db
    .select()
    .from(musicGenerationJobsTable)
    .where(and(
      eq(musicGenerationJobsTable.status, "cancel_requested"),
      or(
        isNull(musicGenerationJobsTable.leaseExpiresAt),
        lt(musicGenerationJobsTable.leaseExpiresAt, now),
      ),
    ));
  for (const pending of pendingCancellations) {
    let acknowledged = !pending.providerRequestId;
    if (pending.providerCancelUrl) {
      try {
        await cancelRemoteProviderJob(pending.provider, pending.providerCancelUrl);
        acknowledged = true;
      } catch {
        acknowledged = false;
      }
    }
    if (!acknowledged) continue;
    await db
      .update(musicGenerationJobsTable)
      .set({
        status: "cancelled",
        stage: "cancelled",
        progress: 100,
        error: null,
        errorCode: "CANCELLED",
        retryable: false,
        providerCancellationAcknowledgedAt: now,
        leaseExpiresAt: null,
        completedAt: now,
      })
      .where(and(
        eq(musicGenerationJobsTable.id, pending.id),
        eq(musicGenerationJobsTable.status, "cancel_requested"),
      ));
  }
  await db
    .update(musicGenerationJobsTable)
    .set({
      status: "failed",
      stage: "retries_exhausted",
      progress: 100,
      retryable: false,
      errorCode: "RETRIES_EXHAUSTED",
      error: "The generation worker stopped before completing all retry attempts.",
      leaseExpiresAt: null,
      completedAt: now,
    })
    .where(and(
      eq(musicGenerationJobsTable.status, "running"),
      or(
        isNull(musicGenerationJobsTable.leaseExpiresAt),
        lt(musicGenerationJobsTable.leaseExpiresAt, now),
      ),
      sql`${musicGenerationJobsTable.attempt} >= ${musicGenerationJobsTable.maxAttempts}`,
    ));
  await db
    .update(musicGenerationJobsTable)
    .set({
      status: "queued",
      stage: "recovered",
      progress: 5,
      workerId: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(musicGenerationJobsTable.status, "running"),
        or(
          isNull(musicGenerationJobsTable.leaseExpiresAt),
          lt(musicGenerationJobsTable.leaseExpiresAt, now),
        ),
        eq(musicGenerationJobsTable.retryable, true),
        sql`${musicGenerationJobsTable.attempt} < ${musicGenerationJobsTable.maxAttempts}`,
      ),
    );
  const queued = await db
    .select({ id: musicGenerationJobsTable.id })
    .from(musicGenerationJobsTable)
    .where(eq(musicGenerationJobsTable.status, "queued"));
  for (const job of queued) {
    setImmediate(() => {
      void runArrangementGeneration(job.id);
    });
  }
}

export function startGenerationRecoveryScheduler(
  intervalMs = 60_000,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  let recoveryInFlight = false;
  const recover = async () => {
    if (recoveryInFlight) return;
    recoveryInFlight = true;
    try {
      await resumePendingGenerationJobs();
    } catch (error) {
      onError(error);
    } finally {
      recoveryInFlight = false;
    }
  };
  void recover();
  const timer = setInterval(() => {
    void recover();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function getGenerationJobForOwner(
  jobId: string,
  ownerId: string,
) {
  const [job] = await db
    .select()
    .from(musicGenerationJobsTable)
    .where(eq(musicGenerationJobsTable.id, jobId))
    .limit(1);
  if (!job) return null;
  const [project] = await db
    .select({ ownerId: musicProjectsTable.ownerId })
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, job.projectId))
    .limit(1);
  return project?.ownerId === ownerId ? job : null;
}

export async function cancelGenerationJob(
  jobId: string,
  ownerId: string,
) {
  const job = await getGenerationJobForOwner(jobId, ownerId);
  if (!job) return null;
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
  const now = new Date();
  const queued = job.status === "queued";
  const [updated] = await db
    .update(musicGenerationJobsTable)
    .set({
      status: queued ? "cancelled" : "cancel_requested",
      stage: queued ? "cancelled" : job.stage,
      progress: queued ? 100 : job.progress,
      cancelRequestedAt: now,
      completedAt: queued ? now : null,
      leaseExpiresAt: queued ? null : job.leaseExpiresAt,
      retryable: false,
      errorCode: "CANCELLED",
      error: null,
    })
    .where(and(
      eq(musicGenerationJobsTable.id, job.id),
      or(
        eq(musicGenerationJobsTable.status, "queued"),
        eq(musicGenerationJobsTable.status, "running"),
      ),
    ))
    .returning();
  if (!updated) return getGenerationJobForOwner(jobId, ownerId);
  if (queued) {
    await db.update(arrangementsTable)
      .set({ status: job.inputSnapshot.arrangement.status === "ready" ? "ready" : "draft" })
      .where(eq(arrangementsTable.id, job.arrangementId));
  }
  if (!queued && updated.providerCancelUrl) {
    try {
      await cancelRemoteProviderJob(updated.provider, updated.providerCancelUrl);
      const [acknowledged] = await db
        .update(musicGenerationJobsTable)
        .set({
          status: "cancelled",
          stage: "cancelled",
          progress: 100,
          providerCancellationAcknowledgedAt: new Date(),
          completedAt: new Date(),
          leaseExpiresAt: null,
        })
        .where(and(
          eq(musicGenerationJobsTable.id, updated.id),
          eq(musicGenerationJobsTable.status, "cancel_requested"),
        ))
        .returning();
      if (acknowledged) return acknowledged;
    } catch {
      await db.update(musicGenerationJobsTable).set({
        errorCode: "PROVIDER_CANCELLATION_PENDING",
        error: "Provider cancellation is pending acknowledgement.",
      }).where(and(
        eq(musicGenerationJobsTable.id, updated.id),
        eq(musicGenerationJobsTable.status, "cancel_requested"),
      ));
    }
  }
  return getGenerationJobForOwner(jobId, ownerId);
}

export async function retryGenerationJob(
  jobId: string,
  ownerId: string,
) {
  const job = await getGenerationJobForOwner(jobId, ownerId);
  if (
    !job ||
    job.status !== "failed" ||
    !job.retryable ||
    job.attempt >= job.maxAttempts
  ) {
    return null;
  }
  const [updated] = await db
    .update(musicGenerationJobsTable)
    .set({
      status: "queued",
      stage: "retry_queued",
      progress: 0,
      workerId: null,
      leaseExpiresAt: null,
      cancelRequestedAt: null,
      error: null,
      errorCode: null,
      completedAt: null,
    })
    .where(and(
      eq(musicGenerationJobsTable.id, job.id),
      eq(musicGenerationJobsTable.status, "failed"),
      eq(musicGenerationJobsTable.retryable, true),
    ))
    .returning();
  if (!updated) return null;
  await db.update(arrangementsTable)
    .set({ status: "generating" })
    .where(eq(arrangementsTable.id, job.arrangementId));
  setImmediate(() => {
    void runArrangementGeneration(job.id);
  });
  return updated;
}

export async function listGenerationCandidatesForOwner(
  jobId: string,
  ownerId: string,
) {
  const job = await getGenerationJobForOwner(jobId, ownerId);
  if (!job) return null;
  const rows = await db
    .select()
    .from(musicGenerationCandidatesTable)
    .where(eq(musicGenerationCandidatesTable.jobId, jobId))
    .orderBy(musicGenerationCandidatesTable.rank);
  // The calibration is read per owner and applied only to this response; it
  // never changes persisted ranks or another producer's view.
  return rankEvaluatedCandidates(rows, (await activeCalibrationForOwner(ownerId)) ?? undefined);
}

export async function selectGenerationCandidate(
  candidateId: string,
  ownerId: string,
) {
  const [candidate] = await db
    .select()
    .from(musicGenerationCandidatesTable)
    .where(eq(musicGenerationCandidatesTable.id, candidateId))
    .limit(1);
  if (!candidate) return null;
  const [project, sourceArrangement] = await Promise.all([
    db
      .select({ ownerId: musicProjectsTable.ownerId })
      .from(musicProjectsTable)
      .where(eq(musicProjectsTable.id, candidate.projectId))
      .limit(1),
    db
      .select()
      .from(arrangementsTable)
      .where(eq(arrangementsTable.id, candidate.arrangementId))
      .limit(1),
  ]);
  if (project[0]?.ownerId !== ownerId || !sourceArrangement[0]) return null;
  if (candidate.status === "selected") {
    const [existing] = await db
      .select()
      .from(arrangementsTable)
      .where(eq(arrangementsTable.sourceCandidateId, candidate.id))
      .limit(1);
    return existing ?? null;
  }
  if (
    !isSelectableCandidate(candidate) ||
    candidate.trackModels === null ||
    candidate.evaluatedPlan === null ||
    candidate.evaluatedStyleSpec === null
  ) return null;
  const source = sourceArrangement[0];
  const evaluatedPlan = candidate.evaluatedPlan;
  const evaluatedStyleSpec = candidate.evaluatedStyleSpec;
  const evaluatedTrackModels = candidate.trackModels;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${candidate.projectId}))`,
    );
    const [claimed] = await tx
      .update(musicGenerationCandidatesTable)
      .set({ status: "selected" })
      .where(
        and(
          eq(musicGenerationCandidatesTable.id, candidate.id),
          eq(musicGenerationCandidatesTable.status, "validated"),
        ),
      )
      .returning();
    if (!claimed) {
      const [existing] = await tx
        .select()
        .from(arrangementsTable)
        .where(eq(arrangementsTable.sourceCandidateId, candidate.id))
        .limit(1);
      return existing ?? null;
    }
    const [job, existingArrangements, projectTracks] = await Promise.all([
      tx
        .select()
        .from(musicGenerationJobsTable)
        .where(eq(musicGenerationJobsTable.id, candidate.jobId))
        .limit(1),
      tx
        .select({ version: arrangementsTable.version })
        .from(arrangementsTable)
        .where(eq(arrangementsTable.projectId, candidate.projectId)),
      tx
        .select()
        .from(tracksTable)
        .where(eq(tracksTable.projectId, candidate.projectId)),
    ]);
    const generationJob = job[0];
    if (!generationJob) {
      throw new Error("Selected arrangement candidate is missing its generation job");
    }
    const nextVersion =
      Math.max(0, ...existingArrangements.map((item) => item.version)) + 1;
    const evaluatedArrangement = generationJob.inputSnapshot.arrangement;
    const engineParameters = {
      seed: candidate.seed,
      harmonyComplexity: evaluatedArrangement.harmonyComplexity,
      energy: evaluatedArrangement.energy,
      density: evaluatedArrangement.density,
      orchestraSize: evaluatedArrangement.orchestraSize,
      rhythmIntensity: evaluatedArrangement.rhythmIntensity,
      songModelVersion: generationJob.songModelVersion ?? 0,
      provider: candidate.provider,
      modulationSemitones:
        evaluatedArrangement.harmonyComplexity >= 8 ? 2 : 0,
    };
    const styleSpec = evaluatedStyleSpec;
    const plan = evaluatedPlan;
    const generatedTrackModels = evaluatedTrackModels;
    const selectedPlanArtifactId = randomUUID();
    const trackModels = generatedTrackModels;
    const [arrangement] = await tx
      .insert(arrangementsTable)
      .values({
        id: randomUUID(),
        projectId: source.projectId,
        name: `${source.name} · ${candidate.label}`,
        style: evaluatedArrangement.style,
        mode: evaluatedArrangement.mode,
        version: nextVersion,
        status: "ready",
        harmonyComplexity: evaluatedArrangement.harmonyComplexity,
        energy: evaluatedArrangement.energy,
        density: evaluatedArrangement.density,
        orchestraSize: evaluatedArrangement.orchestraSize,
        rhythmIntensity: evaluatedArrangement.rhythmIntensity,
        sections: candidate.plan.sections,
        sourceGenerationJobId: candidate.jobId,
        sourceCandidateId: candidate.id,
        styleSpec,
        plan,
        trackModels,
        songModelVersion: generationJob.songModelVersion,
        parentArrangementId: source.id,
        parameters: engineParameters,
        seed: candidate.seed,
        modelVersion: candidate.modelVersion,
        provenance: {
          model: candidate.provider,
          version: candidate.modelVersion,
          parameters: engineParameters,
          parentIds: candidate.artifactId ? [selectedPlanArtifactId] : candidate.parentArtifactIds,
          createdBy: "arrangement-provider",
        },
        generationProvenance: {
          jobId: candidate.jobId,
          candidateId: candidate.id,
          provider: candidate.provider,
          modelVersion: candidate.modelVersion,
          reportedModelVersion: candidate.reportedModelVersion,
          checkpointSha256: candidate.checkpointSha256,
          providerRequestId: candidate.providerRequestId,
          songModelVersion: generationJob.songModelVersion,
          seed: candidate.seed,
          parameters: candidate.parameters,
          parentArtifactIds: candidate.parentArtifactIds,
          evaluation: candidate.evaluation,
        },
      })
      .returning();
    await Promise.all(projectTracks.map((track) => {
      const trackModel = trackModels.find((model) => model.id === track.id);
      return trackModel
        ? tx.update(tracksTable).set({
            instrumentDefinition: trackModel.instrumentDefinition,
            trackModel,
            provenance: trackModel.provenance,
            status: "rendered",
          }).where(eq(tracksTable.id, track.id))
        : Promise.resolve();
    }));
    if (candidate.artifactId) {
      const serializedPlan = JSON.stringify(plan);
      const checksum = sha256(serializedPlan);
      await tx.insert(musicArtifactsTable).values({
        id: selectedPlanArtifactId,
        projectId: arrangement.projectId,
        type: "ARRANGEMENT_PLAN",
        label: `${arrangement.name} · ${candidate.provider}`,
        version: arrangement.version,
        size: `${Buffer.byteLength(serializedPlan)} B`,
        format: "JSON",
        hash: checksum,
        checksum,
        parentIds: [candidate.artifactId],
        createdBy: "arrangement-provider",
        modelVersion: `${candidate.provider}@${candidate.modelVersion}`,
        provider: candidate.provider,
        license: "Provider terms",
        retentionPolicy: "project",
        technicalMetadata: {
          mediaType: "application/json",
          bytes: Buffer.byteLength(serializedPlan),
          selectedCandidateId: candidate.id,
          ...(candidate.checkpointSha256
            ? { checkpointSha256: candidate.checkpointSha256 }
            : {}),
        },
        parameters: engineParameters,
        storageUri: `db://music_arrangements/${arrangement.id}`,
      });
      if (trackModels.length > 0) {
        await tx.insert(musicArtifactsTable).values(trackModels.map((trackModel) => {
          const serialized = JSON.stringify(trackModel);
          return {
            id: randomUUID(),
            projectId: arrangement.projectId,
            type: "TRACK_MODEL",
            label: `${arrangement.name} · ${trackModel.instrument}`,
            version: arrangement.version,
            size: `${Buffer.byteLength(serialized)} B`,
            format: "JSON",
            hash: sha256(serialized),
            checksum: sha256(serialized),
            parentIds: [selectedPlanArtifactId],
            createdBy: "performance-engine",
            modelVersion: `${trackModel.provenance.model}@${trackModel.provenance.version}`,
            parameters: {
              ...trackModel.provenance.parameters,
              trackId: trackModel.id,
              arrangementId: arrangement.id,
              ...(candidate.checkpointSha256
                ? { checkpointSha256: candidate.checkpointSha256 }
                : {}),
            },
            storageUri: `db://music_arrangements/${arrangement.id}/tracks/${trackModel.id}`,
          };
        }));
      }
    }
    await tx.insert(studioActivitiesTable).values({
      id: randomUUID(),
      projectId: source.projectId,
      title: "Generation candidate selected",
      detail: `${candidate.label} · arrangement v${nextVersion}`,
      type: "arrangement",
    });
    await appendProducerDecisionTx(tx, {
      ownerId, projectId: arrangement.projectId, domain: "candidate", kind: "approval",
      source: "inferred_behavior",
      context: { subjectId: candidate.id, modelVersion: candidate.modelVersion,
        evidenceIds: candidate.evaluation.renderArtifactIds, lineageIds: candidate.parentArtifactIds,
        evidenceSha256: sha256(JSON.stringify(candidate.evaluation.renderArtifactIds)),
        rankingScore: candidate.evaluation.qualityReport?.score ?? null,
        criticScore: candidate.evaluation.musicCritic?.score ?? null },
    });
    return arrangement;
  });
}
