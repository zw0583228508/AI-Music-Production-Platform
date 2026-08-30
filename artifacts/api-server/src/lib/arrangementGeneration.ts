import { randomInt, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  arrangementsTable,
  db,
  musicArtifactsTable,
  musicGenerationCandidatesTable,
  musicGenerationJobsTable,
  musicProjectsTable,
  songModelsTable,
  studioActivitiesTable,
  type GenerationParameters,
  type MusicGenerationTask,
} from "@workspace/db";
import {
  createProviderRegistry,
  providerCatalog,
  selectMusicProvider,
  type GenerationHardware,
  type GenerationSpeed,
  type MusicProviderId,
} from "./musicProviders";

export type QueueGenerationInput = {
  candidates?: number;
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
  createdAt: row.createdAt.toISOString(),
});

export function listProviderCatalog() {
  return providerCatalog(createProviderRegistry());
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

  const [project, songModels, artifacts] = await Promise.all([
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
  const registry = createProviderRegistry();
  const provider = selectMusicProvider(registry, {
    requestedProvider: input.provider,
    task,
    style: arrangement.style,
    hardware,
    speed,
  });
  const count = Math.max(1, Math.min(3, Math.round(input.candidates ?? 3)));
  const seed =
    input.seed === undefined
      ? randomInt(1, 2_147_483_647)
      : Math.max(0, Math.min(2_147_483_647, Math.trunc(input.seed)));
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
      hardware,
      speed,
      progress: 0,
      stage: "queued",
      requestedCandidates: count,
      seed,
      parameters: input.parameters ?? {},
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
      },
    })
    .returning();
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

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const provider = createProviderRegistry().find(
      (candidate) => candidate.definition.id === job.provider,
    );
    if (!provider?.available) {
      throw new Error(`${job.provider} worker is no longer available`);
    }
    const [owned] = await db
      .update(musicGenerationJobsTable)
      .set({ progress: 30, stage: "running_model" })
      .where(
        and(
          eq(musicGenerationJobsTable.id, job.id),
          eq(musicGenerationJobsTable.workerId, workerId),
          eq(musicGenerationJobsTable.status, "running"),
        ),
      )
      .returning({ id: musicGenerationJobsTable.id });
    if (!owned) throw new Error("Generation job lease was lost");
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
            eq(musicGenerationJobsTable.status, "running"),
          ),
        );
    }, 30_000);

    const snapshot = job.inputSnapshot;
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
        await db
          .update(musicGenerationJobsTable)
          .set({
            progress: progress.progress,
            stage: progress.stage,
            providerRequestId: progress.requestId,
            heartbeatAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
          })
          .where(
            and(
              eq(musicGenerationJobsTable.id, job.id),
              eq(musicGenerationJobsTable.workerId, workerId),
            ),
          );
      },
    );
    const [rankingOwner] = await db
      .update(musicGenerationJobsTable)
      .set({
        providerRequestId: result.requestId,
        progress: 76,
        stage: "ranking_candidates",
      })
      .where(
        and(
          eq(musicGenerationJobsTable.id, job.id),
          eq(musicGenerationJobsTable.workerId, workerId),
          eq(musicGenerationJobsTable.status, "running"),
        ),
      )
      .returning({ id: musicGenerationJobsTable.id });
    if (!rankingOwner) throw new Error("Generation job lease was lost");

    const ranked = result.candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, job.requestedCandidates);
    const now = new Date();
    await db.transaction(async (tx) => {
      const [completed] = await tx
        .update(musicGenerationJobsTable)
        .set({
          status: "succeeded",
          progress: 100,
          stage: "complete",
          completedAt: now,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(musicGenerationJobsTable.id, job.id),
            eq(musicGenerationJobsTable.workerId, workerId),
            eq(musicGenerationJobsTable.status, "running"),
          ),
        )
        .returning({ id: musicGenerationJobsTable.id });
      if (!completed) throw new Error("Generation job lease was lost");
      for (const [index, candidate] of ranked.entries()) {
        const artifactId = randomUUID();
        const candidateId = randomUUID();
        await tx.insert(musicArtifactsTable).values({
          id: artifactId,
          projectId: job.projectId,
          type: "ARRANGEMENT_PLAN",
          label: `${candidate.label} · ${provider.definition.displayName}`,
          version: snapshot.arrangement.version,
          size: `${Buffer.byteLength(JSON.stringify(candidate.plan))} B`,
          format: "JSON",
        });
        await tx.insert(musicGenerationCandidatesTable).values({
          id: candidateId,
          jobId: job.id,
          projectId: job.projectId,
          arrangementId: job.arrangementId,
          artifactId,
          providerRequestId: candidate.providerRequestId ?? result.requestId,
          provider: provider.definition.id,
          modelVersion: job.modelVersion,
          reportedModelVersion: result.modelVersion,
          seed: job.seed,
          rank: index + 1,
          label: candidate.label,
          score: candidate.score,
          confidence: candidate.confidence,
          summary: candidate.summary,
          status: "validated",
          parameters: job.parameters,
          parentArtifactIds: job.parentArtifactIds,
          plan: candidate.plan,
        });
      }
      await tx
        .update(arrangementsTable)
        .set({ status: "ready" })
        .where(eq(arrangementsTable.id, job.arrangementId));
      await tx.insert(studioActivitiesTable).values({
        id: randomUUID(),
        projectId: job.projectId,
        title: "Provider generation completed",
        detail: `${provider.definition.displayName} · ${ranked.length} ranked candidate${ranked.length === 1 ? "" : "s"}`,
        type: "arrangement",
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    const originalStatus = job.inputSnapshot.arrangement.status === "ready"
      ? "ready"
      : "draft";
    await db.transaction(async (tx) => {
      const [failed] = await tx
        .update(musicGenerationJobsTable)
        .set({
          status: "failed",
          progress: 100,
          stage: "failed",
          error: message,
          completedAt: new Date(),
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(musicGenerationJobsTable.id, job.id),
            eq(musicGenerationJobsTable.workerId, workerId),
          ),
        )
        .returning({ id: musicGenerationJobsTable.id });
      if (failed) {
        await tx
          .update(arrangementsTable)
          .set({ status: originalStatus })
          .where(eq(arrangementsTable.id, job.arrangementId));
      }
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

export async function resumePendingGenerationJobs(): Promise<void> {
  await db
    .update(musicGenerationJobsTable)
    .set({ status: "queued", stage: "recovered", progress: 5 })
    .where(
      and(
        eq(musicGenerationJobsTable.status, "running"),
        or(
          isNull(musicGenerationJobsTable.leaseExpiresAt),
          lt(musicGenerationJobsTable.leaseExpiresAt, new Date()),
        ),
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
  if (candidate.status !== "validated") return null;
  const source = sourceArrangement[0];
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
    const [job, existingArrangements] = await Promise.all([
      tx
        .select()
        .from(musicGenerationJobsTable)
        .where(eq(musicGenerationJobsTable.id, candidate.jobId))
        .limit(1),
      tx
        .select({ version: arrangementsTable.version })
        .from(arrangementsTable)
        .where(eq(arrangementsTable.projectId, candidate.projectId)),
    ]);
    const nextVersion =
      Math.max(0, ...existingArrangements.map((item) => item.version)) + 1;
    const [arrangement] = await tx
      .insert(arrangementsTable)
      .values({
        id: randomUUID(),
        projectId: source.projectId,
        name: `${source.name} · ${candidate.label}`,
        style: source.style,
        mode: source.mode,
        version: nextVersion,
        status: "ready",
        harmonyComplexity: source.harmonyComplexity,
        energy: source.energy,
        density: source.density,
        orchestraSize: source.orchestraSize,
        rhythmIntensity: source.rhythmIntensity,
        sections: candidate.plan.sections,
        sourceGenerationJobId: candidate.jobId,
        sourceCandidateId: candidate.id,
        generationProvenance: {
          jobId: candidate.jobId,
          candidateId: candidate.id,
          provider: candidate.provider,
          modelVersion: candidate.modelVersion,
          reportedModelVersion: candidate.reportedModelVersion,
          providerRequestId: candidate.providerRequestId,
          songModelVersion: job[0]?.songModelVersion ?? null,
          seed: candidate.seed,
          parameters: candidate.parameters,
          parentArtifactIds: candidate.parentArtifactIds,
        },
      })
      .returning();
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