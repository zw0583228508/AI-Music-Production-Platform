import { createHash, randomInt, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  type ArrangementPlan,
  type CandidateEvaluation,
  type GenerationParameters,
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
  type ProviderCandidate,
} from "./musicProviders";
import {
  applyPlanModulations,
  buildTrackModels,
  createArrangementPlan,
  createStyleSpec,
  renderMusicPipeline,
} from "./musicEngines";
import { createPerformanceMidi, encodeWav } from "./exportEngine";
import { deleteExportObject, saveExportObject } from "./objectStorage";
import {
  hasCompleteQualityEvidence,
  isSelectableCandidate,
  rankEvaluatedCandidates,
} from "./candidateRanking";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export type QueueGenerationInput = {
  candidates?: number;
  idempotencyKey?: string;
  provider?: MusicProviderId;
  task?: MusicGenerationTask;
  hardware?: GenerationHardware;
  speed?: GenerationSpeed;
  seed?: number;
  parameters?: GenerationParameters;
};

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
  parentArtifactIds: row.parentArtifactIds,
  plan: row.plan,
  trackModels: row.trackModels,
  evaluation: row.evaluation,
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
  trackModelsMaterialized?: boolean;
};

function materializeCandidate(input: CandidateMaterializationInput): {
  plan: ArrangementPlan;
  trackModels: TrackModel[];
  styleSpec: ReturnType<typeof createStyleSpec>;
  engineParameters: Record<string, number | string | boolean>;
} {
  const { candidate, source, songModel, tracks } = input;
  const engineParameters = {
    seed: candidate.seed,
    harmonyComplexity: source.harmonyComplexity,
    energy: source.energy,
    density: source.density,
    orchestraSize: source.orchestraSize,
    rhythmIntensity: source.rhythmIntensity,
    songModelVersion: input.songModelVersion ?? 0,
    provider: candidate.provider,
    modulationSemitones: source.harmonyComplexity >= 8 ? 2 : 0,
  };
  const styleSpec = createStyleSpec(source.style, {
    density: source.density,
    harmonyComplexity: source.harmonyComplexity,
    energy: source.energy,
  });
  const generatedPlan = createArrangementPlan({
    arrangementId: input.candidateId,
    version: input.version,
    songModel,
    style: styleSpec,
    tracks,
    parameters: { ...engineParameters, arrangementId: input.candidateId },
    parentIds: candidate.parentArtifactIds,
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
      const enabled = new Set(providerSection.tracks.flatMap((track) =>
        [...(descriptorByToken.get(track.toLowerCase()) ?? [])]));
      return {
        ...section,
        energy: providerSection.energy,
        density: providerSection.density,
        tracks: Object.fromEntries(
          Object.entries(section.tracks).map(([trackName, operation]) => [
            trackName,
            enabled.has(trackName) ? operation : "none",
          ]),
        ),
      };
    }),
  };
  const trackModels = candidate.trackModels == null
    ? buildTrackModels({
        songModel,
        plan,
        tracks,
        style: styleSpec,
        seed: candidate.seed,
      })
    : input.trackModelsMaterialized
      ? candidate.trackModels
      : applyPlanModulations(
          candidate.trackModels,
          plan,
          songModel.tempoMap[0]?.bpm ?? 92,
          songModel.meterMap[0]?.meter,
        );
  const playabilityErrors = validateCanonicalTrackModels(
    trackModels,
    tracks.map((track) => track.id),
  );
  if (playabilityErrors.length) {
    throw new Error(
      `Generated TrackModels are not playable: ${playabilityErrors.join("; ")}`,
    );
  }
  return { plan, trackModels, styleSpec, engineParameters };
}

function normalizeSongModelSnapshot(value: unknown): SongModelData {
  const raw = value && typeof value === "object"
    ? value as Partial<SongModelData>
    : {};
  return {
    contractVersion: "1.0",
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

  const task = input.task ?? "ARRANGEMENT";
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
    requestedProvider: input.provider,
    task,
    style: arrangement.style,
    hardware,
    speed,
  });
  const count = Math.max(1, Math.min(3, Math.round(input.candidates ?? 3)));
  const idempotencyKey = (input.idempotencyKey?.trim() ||
    `arrangement:${arrangement.id}:v${arrangement.version}:${task}:${sha256(JSON.stringify({
      candidates: count,
      provider: input.provider ?? null,
      hardware,
      speed,
      seed: input.seed ?? null,
      parameters: input.parameters ?? {},
    })).slice(0, 24)}`).slice(0, 200);
  // A caller supplied idempotency key is a reservation for one exact paid
  // request, not a general-purpose "return my last job" key.  In particular,
  // never let a changed provider, task, seed, or parameters silently reuse a
  // request that may already have reached a provider.
  const normalizedParameters = input.parameters ?? {};
  const normalizedSeed = input.seed === undefined
    ? null
    : Math.max(0, Math.min(2_147_483_647, Math.trunc(input.seed)));
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
  const parentArtifactIds = relevantArtifacts.map((artifact) => artifact.id);
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
  const [job] = await db
    .insert(musicGenerationJobsTable)
    .values({
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
      maxAttempts: 3,
      retryable: true,
      requestedCandidates: count,
      seed,
      parameters: normalizedParameters,
      parentArtifactIds,
      inputSnapshot: {
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
      },
    })
    .onConflictDoNothing({
      target: [
        musicGenerationJobsTable.arrangementId,
        musicGenerationJobsTable.idempotencyKey,
      ],
    })
    .returning();
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
        parameters: job.parameters,
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

    const providerCandidates = result.candidates.slice(0, job.requestedCandidates);
    const artifactRows: Array<typeof musicArtifactsTable.$inferInsert> = [];
    const candidateRows: Array<
      typeof musicGenerationCandidatesTable.$inferInsert & {
        evaluation: CandidateEvaluation;
        score: number;
      }
    > = [];
    for (const [providerIndex, candidate] of providerCandidates.entries()) {
      if (abortController.signal.aborted) {
        throw new ProviderCancellationAcknowledgedError(
          "Generation cancelled before candidate evaluation completed",
        );
      }
      const candidateId = randomUUID();
      const planArtifactId = randomUUID();
      const candidateParentIds = [
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
          ...(result.checkpointSha256
            ? { checkpointSha256: result.checkpointSha256 }
            : {}),
        },
        storageUri: `db://music_generation_candidates/${candidateId}`,
      });

      let phase: CandidateEvaluation["status"] = "rendering";
      let evaluation: CandidateEvaluation;
      let materializedTrackModels: TrackModel[] | null = null;
      let evaluatedPlan: ArrangementPlan | null = null;
      let evaluatedStyleSpec: ReturnType<typeof createStyleSpec> | null = null;
      let evaluationScore = 0;
      let candidateStatus = "rejected";
      const candidateObjectUrls: string[] = [];
      try {
        const audioArtifactId = randomUUID();
        const midiArtifactId = randomUUID();
        const qualityArtifactId = randomUUID();
        const renderArtifactIds = [audioArtifactId, midiArtifactId];
        const materialized = materializeCandidate({
          candidateId,
          version: snapshot.arrangement.version + 1,
          source: snapshot.arrangement,
          songModel: evaluationSongModel,
          songModelVersion: job.songModelVersion,
          tracks: snapshot.tracks,
          candidate: {
            provider: provider.definition.id,
            seed: job.seed,
            plan: candidate.plan,
            parentArtifactIds: candidateParentIds,
            trackModels: candidate.trackModels,
          },
        });
        materializedTrackModels = materialized.trackModels;
        evaluatedPlan = materialized.plan;
        evaluatedStyleSpec = materialized.styleSpec;
        const evaluatedAt = new Date().toISOString();
        const pipeline = renderMusicPipeline({
          songModel: evaluationSongModel,
          plan: materialized.plan,
          tracks: snapshot.tracks,
          trackModels: materialized.trackModels,
          style: materialized.styleSpec,
          seed: job.seed,
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
        const wav = encodeWav(pipeline.master);
        const midi = createPerformanceMidi(
          materialized.trackModels,
          evaluationSongModel.tempoMap[0]?.bpm ?? 92,
          evaluationSongModel.meterMap[0]?.meter ?? "4/4",
          pipeline.durationSeconds,
        );
        const objectPrefix = `generation/${job.id}/${candidateId}`;
        const audioUrl = await saveExportObject(
          `${objectPrefix}/render.wav`,
          wav,
          "audio/wav",
        );
        candidateObjectUrls.push(audioUrl);
        unpublishedEvaluationUrls.push(audioUrl);
        const midiUrl = await saveExportObject(
          `${objectPrefix}/performance.mid`,
          midi,
          "audio/midi",
        );
        candidateObjectUrls.push(midiUrl);
        unpublishedEvaluationUrls.push(midiUrl);
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
          !Number.isFinite(pipeline.quality.score) ||
          !pipeline.quality.lineageComplete ||
          pipeline.quality.renderArtifactIds.length !== renderArtifactIds.length ||
          pipeline.quality.renderArtifactIds.some((id) => !renderArtifactIdSet.has(id)) ||
          requiredDimensions.some((name) =>
            !Number.isFinite(pipeline.quality.checks[name]))
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
          seed: job.seed,
          providerScore: candidate.score,
          quality: pipeline.quality,
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
            { id: audioArtifactId, type: "AUDIO_TRACK", label: "Rendered audio", url: audioUrl },
            { id: midiArtifactId, type: "MIDI", label: "Performance MIDI", url: midiUrl },
            { id: qualityArtifactId, type: "QUALITY_REPORT", label: "Quality report", url: qualityUrl },
          ],
          qualityReport: pipeline.quality,
          error: null,
        };
        evaluationScore = pipeline.quality.score;
        candidateStatus = "validated";
        const artifactParentIds = [planArtifactId, ...candidateParentIds];
        artifactRows.push(
          {
            id: audioArtifactId,
            projectId: job.projectId,
            type: "AUDIO_TRACK",
            label: `${candidate.label} · evaluation render`,
            version: snapshot.arrangement.version,
            size: `${wav.byteLength} B`,
            format: "WAV",
            url: audioUrl,
            storageUri: audioUrl,
            hash: sha256(wav),
            checksum: sha256(wav),
            parentIds: artifactParentIds,
            createdBy: "candidate-render-evaluator",
            modelVersion: "LOCAL_EXPRESSIVE_SYNTH@1.0.0",
            provider: provider.definition.id,
            technicalMetadata: {
              mediaType: "audio/wav",
              bytes: wav.byteLength,
              durationSeconds: pipeline.durationSeconds,
              candidateId,
              ...(result.checkpointSha256
                ? { checkpointSha256: result.checkpointSha256 }
                : {}),
            },
          },
          {
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
              durationSeconds: pipeline.durationSeconds,
              candidateId,
              ...(result.checkpointSha256
                ? { checkpointSha256: result.checkpointSha256 }
                : {}),
            },
          },
          {
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
            parentIds: [audioArtifactId, midiArtifactId, planArtifactId],
            createdBy: "quality-engine",
            modelVersion: "QUALITY_ENGINE@1.0.0",
            provider: provider.definition.id,
            technicalMetadata: {
              mediaType: "application/json",
              bytes: qualityData.byteLength,
              qualityScore: pipeline.quality.score,
              candidateId,
              ...(result.checkpointSha256
                ? { checkpointSha256: result.checkpointSha256 }
                : {}),
            },
          },
        );
      } catch (error) {
        await Promise.all(candidateObjectUrls.map((url) =>
          deleteExportObject(url).catch(() => undefined)));
        for (const url of candidateObjectUrls) {
          const index = unpublishedEvaluationUrls.indexOf(url);
          if (index >= 0) unpublishedEvaluationUrls.splice(index, 1);
        }
        evaluation = {
          status: phase === "analyzing" ? "analysis_failed" : "render_failed",
          providerScore: candidate.score,
          renderArtifactIds: [],
          artifacts: [],
          qualityReport: null,
          error: error instanceof Error ? error.message : "Candidate evaluation failed",
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
        seed: job.seed,
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
    const ranked = rankEvaluatedCandidates(candidateRows);
    const allEvaluationsFailed = ranked.every((candidate) =>
      !hasCompleteQualityEvidence(candidate.evaluation));
    const now = new Date();
    await db.transaction(async (tx) => {
      const [completed] = await tx
        .update(musicGenerationJobsTable)
        .set({
          status: allEvaluationsFailed ? "failed" : "succeeded",
          progress: 100,
          stage: allEvaluationsFailed ? "evaluation_failed" : "complete",
          error: allEvaluationsFailed
            ? "No candidate produced complete render and quality evidence."
            : null,
          errorCode: allEvaluationsFailed
            ? "CANDIDATE_EVALUATION_FAILED"
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
        detail: `${provider.definition.displayName} · ${ranked.filter((candidate) => candidate.status === "validated").length}/${ranked.length} candidates passed render and quality analysis`,
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
    const retryable = !cancelled && !cancellationUnconfirmed &&
      (!runtimeUnavailable || error.retryable) &&
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
  return db
    .select()
    .from(musicGenerationCandidatesTable)
    .where(eq(musicGenerationCandidatesTable.jobId, jobId))
    .orderBy(musicGenerationCandidatesTable.rank);
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
    await tx.insert(studioActivitiesTable).values({
      id: randomUUID(),
      projectId: source.projectId,
      title: "Generation candidate selected",
      detail: `${candidate.label} · arrangement v${nextVersion}`,
      type: "arrangement",
    });
    return arrangement;
  });
}