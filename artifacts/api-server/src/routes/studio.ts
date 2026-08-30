import { randomUUID } from "node:crypto";
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  CreateArrangementBody,
  CreateArrangementParams,
  CreateArrangementResponse,
  CreateProjectExportBody,
  CreateProjectExportParams,
  CreateProjectExportResponse,
  CreateProjectBody,
  CreateProjectResponse,
  DownloadProjectExportParams,
  GenerateArrangementBody,
  GenerateArrangementParams,
  GenerateArrangementResponse,
  GetDashboardResponse,
  GetProjectParams,
  GetProjectResponse,
  GetProjectSongModelParams,
  GetProjectSongModelResponse,
  CorrectProjectSongModelBody,
  CorrectProjectSongModelParams,
  CorrectProjectSongModelResponse,
  ListArrangementsParams,
  ListArrangementsResponse,
  ListArtifactsParams,
  ListArtifactsResponse,
  ListAnalysisJobsParams,
  ListAnalysisJobsResponse,
  ListMusicProvidersResponse,
  ListProjectsResponse,
  ListProjectSourcesParams,
  ListProjectSourcesResponse,
  ListTracksParams,
  ListTracksResponse,
  RunCopilotBody,
  RunCopilotParams,
  RunCopilotResponse,
  RegisterProjectSourceBody,
  RegisterProjectSourceParams,
  RegisterProjectSourceResponse,
  RetrySourceAnalysisParams,
  RetrySourceAnalysisResponse,
  UpdateArrangementBody,
  UpdateArrangementParams,
  UpdateArrangementResponse,
} from "@workspace/api-zod";
import {
  analysisJobsTable,
  arrangementsTable,
  db,
  musicArtifactsTable,
  musicProjectsTable,
  projectSourcesTable,
  songModelsTable,
  studioActivitiesTable,
  tracksTable,
} from "@workspace/db";
import { analyzeProjectSource } from "../lib/sourceAnalyzer";
import { validateSourceFileMetadata } from "../lib/sourceFormats";
import {
  MUSIC_PROVIDERS,
  ProviderUnavailableError,
  runArrangementProvider,
  selectArrangementProvider,
  validateArrangementProviderOutput,
} from "../lib/musicProviders";
import {
  createExportBundle,
  createTrackPerformance,
  loadExportZip,
  persistExportBundle,
  type ExportBundle,
} from "../lib/export-pipeline";

const router: IRouter = Router();
const exportBundles = new Map<string, ExportBundle>();

function requireStudioAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.use(requireStudioAuth);

router.param("projectId", async (req, res, next, projectId): Promise<void> => {
  try {
    const [project] = await db
      .select({ id: musicProjectsTable.id })
      .from(musicProjectsTable)
      .where(sql`${musicProjectsTable.id} = ${projectId} and ${musicProjectsTable.ownerId} = ${req.user!.id}`);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

router.param("arrangementId", async (req, res, next, arrangementId): Promise<void> => {
  try {
    const [arrangement] = await db
      .select({ projectId: arrangementsTable.projectId })
      .from(arrangementsTable)
      .where(eq(arrangementsTable.id, arrangementId));
    if (!arrangement) {
      res.status(404).json({ error: "Arrangement not found" });
      return;
    }
    const [project] = await db
      .select({ id: musicProjectsTable.id })
      .from(musicProjectsTable)
      .where(sql`${musicProjectsTable.id} = ${arrangement.projectId} and ${musicProjectsTable.ownerId} = ${req.user!.id}`);
    if (!project) {
      res.status(404).json({ error: "Arrangement not found" });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

router.param("exportId", async (req, res, next, exportId): Promise<void> => {
  try {
    const [artifact] = await db
      .select({ projectId: musicArtifactsTable.projectId })
      .from(musicArtifactsTable)
      .where(eq(musicArtifactsTable.id, exportId));
    if (!artifact) {
      res.status(404).json({ error: "Export package not found" });
      return;
    }
    const [project] = await db
      .select({ id: musicProjectsTable.id })
      .from(musicProjectsTable)
      .where(sql`${musicProjectsTable.id} = ${artifact.projectId} and ${musicProjectsTable.ownerId} = ${req.user!.id}`);
    if (!project) {
      res.status(404).json({ error: "Export package not found" });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

const iso = (value: Date) => value.toISOString();

const projectResponse = (project: typeof musicProjectsTable.$inferSelect) => ({
  id: project.id,
  name: project.name,
  sourceType: project.sourceType,
  status: project.status,
  updatedAt: iso(project.updatedAt),
  duration: project.duration,
  key: project.key,
  bpm: project.bpm,
  coverColor: project.coverColor,
});

const analysisResponse = (project: typeof musicProjectsTable.$inferSelect) => ({
  bpm: project.bpm,
  meter: project.meter,
  key: project.key,
  confidence: project.confidence,
  sections: project.sections,
  energy: project.energy,
  providers: project.providers,
});

const arrangementResponse = (
  arrangement: typeof arrangementsTable.$inferSelect,
) => ({
  ...arrangement,
  createdAt: iso(arrangement.createdAt),
});

const artifactResponse = (
  artifact: typeof musicArtifactsTable.$inferSelect,
) => ({
  ...artifact,
  createdAt: iso(artifact.createdAt),
});

const sourceResponse = (
  source: typeof projectSourcesTable.$inferSelect,
) => ({
  id: source.id,
  projectId: source.projectId,
  name: source.name,
  size: source.size,
  contentType: source.contentType,
  sourceType: source.sourceType,
  status: source.status,
  progress: source.progress,
  durationSeconds: source.durationSeconds,
  sampleRate: source.sampleRate,
  channels: source.channels,
  error: source.error,
  createdAt: iso(source.createdAt),
});

const songModelResponse = (
  row: typeof songModelsTable.$inferSelect,
) => ({
  id: row.id,
  projectId: row.projectId,
  sourceId: row.sourceId,
  version: row.version,
  status: row.status,
  parentModelId: row.parentModelId,
  correction: row.correction,
  ...row.model,
  providers: row.providers,
  confidence: row.confidence,
  createdAt: iso(row.createdAt),
});

const analysisJobResponse = (
  job: typeof analysisJobsTable.$inferSelect,
) => ({
  ...job,
  error: job.error ?? null,
  startedAt: job.startedAt ? iso(job.startedAt) : null,
  finishedAt: job.finishedAt ? iso(job.finishedAt) : null,
  createdAt: iso(job.createdAt),
  updatedAt: iso(job.updatedAt),
});

async function ensureSeeded(): Promise<void> {
  const existing = await db.select({ id: musicProjectsTable.id }).from(musicProjectsTable).limit(1);
  if (existing.length > 0) return;

  const projectId = "demo-cinematic-vocal";
  const secondProjectId = "demo-acoustic-sketch";
  const sections = [
    { name: "Intro", startBar: 1, endBar: 8, energy: 0.24 },
    { name: "Verse 1", startBar: 9, endBar: 24, energy: 0.38 },
    { name: "Chorus", startBar: 25, endBar: 40, energy: 0.82 },
    { name: "Verse 2", startBar: 41, endBar: 56, energy: 0.52 },
    { name: "Bridge", startBar: 57, endBar: 64, energy: 0.31 },
    { name: "Final Chorus", startBar: 65, endBar: 80, energy: 0.96 },
    { name: "Outro", startBar: 81, endBar: 88, energy: 0.27 },
  ];

  await db.insert(musicProjectsTable).values([
    {
      id: projectId,
      name: "Midnight Cinema",
      sourceType: "VOCAL_ONLY",
      sourceName: "midnight-cinema-vocal.wav",
      status: "ready",
      duration: "3:42",
      key: "D minor",
      bpm: 92,
      meter: "4/4",
      confidence: 0.94,
      coverColor: "#8b5cf6",
      sections,
      energy: [0.2, 0.28, 0.4, 0.78, 0.85, 0.5, 0.36, 0.92, 0.3],
      providers: ["DEMO_REFERENCE_DATA"],
    },
    {
      id: secondProjectId,
      name: "Open Road",
      sourceType: "SOLO_INSTRUMENT",
      sourceName: "open-road-guitar.m4a",
      status: "draft",
      duration: "2:18",
      key: "G major",
      bpm: 108,
      meter: "4/4",
      confidence: 0.78,
      coverColor: "#f97316",
      sections: [
        { name: "Verse", startBar: 1, endBar: 16, energy: 0.42 },
        { name: "Chorus", startBar: 17, endBar: 32, energy: 0.71 },
      ],
      energy: [0.31, 0.41, 0.55, 0.73, 0.48],
      providers: ["DEMO_REFERENCE_DATA"],
    },
  ]);

  await db.insert(arrangementsTable).values({
    id: "arr-cinematic-1",
    projectId,
    name: "Cinematic Pop — Full Orchestra",
    style: "Cinematic Pop",
    mode: "STUDIO",
    version: 3,
    status: "ready",
    harmonyComplexity: 8,
    energy: 0.78,
    density: 0.7,
    orchestraSize: 0.88,
    rhythmIntensity: 0.62,
    sections: sections.map((section) => ({
      name: section.name,
      energy: section.energy,
      density: section.name.includes("Chorus") ? 0.9 : 0.48,
      tracks: section.name === "Bridge"
        ? ["Piano", "Cello", "Strings"]
        : ["Drums", "Bass", "Piano", "Strings", "Brass"],
    })),
  });

  await db.insert(tracksTable).values([
    { id: "track-vocal", projectId, name: "Lead Vocal", role: "melody", kind: "audio", color: "#a78bfa", volume: -1.5, muted: false, solo: false, status: "source" },
    { id: "track-drums", projectId, name: "Studio Drums", role: "rhythm", kind: "audio", color: "#fb7185", volume: -4, muted: false, solo: false, status: "generated" },
    { id: "track-bass", projectId, name: "Electric Bass", role: "bass", kind: "midi", color: "#38bdf8", volume: -3, muted: false, solo: false, status: "rendered" },
    { id: "track-piano", projectId, name: "Grand Piano", role: "harmony", kind: "midi", color: "#fbbf24", volume: -5, muted: false, solo: false, status: "rendered" },
    { id: "track-strings", projectId, name: "Orchestral Strings", role: "countermelody", kind: "midi", color: "#34d399", volume: -6, muted: false, solo: false, status: "rendered" },
    { id: "track-brass", projectId, name: "French Horns", role: "lift", kind: "midi", color: "#f97316", volume: -7, muted: false, solo: false, status: "generated" },
  ]);

  await db.insert(musicArtifactsTable).values([
    { id: "artifact-source", projectId, type: "SOURCE", label: "Original vocal", version: 1, size: "38.4 MB", format: "WAV" },
    { id: "artifact-song-model", projectId, type: "SONG_MODEL", label: "Unified Song Model", version: 4, size: "186 KB", format: "JSON" },
    { id: "artifact-plan", projectId, type: "ARRANGEMENT_PLAN", label: "Cinematic arrangement plan", version: 3, size: "42 KB", format: "JSON" },
    { id: "artifact-midi", projectId, type: "MIDI", label: "Full arrangement", version: 3, size: "1.8 MB", format: "MIDI" },
    { id: "artifact-master", projectId, type: "MASTER", label: "Streaming master", version: 2, size: "64.1 MB", format: "WAV" },
  ]);

  await db.insert(studioActivitiesTable).values([
    { id: "activity-1", projectId, title: "Master completed", detail: "Streaming master · v2", type: "export", createdAt: new Date(Date.now() - 1000 * 60 * 18) },
    { id: "activity-2", projectId, title: "Arrangement generated", detail: "Cinematic Pop · 6 tracks", type: "arrangement", createdAt: new Date(Date.now() - 1000 * 60 * 64) },
    { id: "activity-3", projectId: secondProjectId, title: "Source imported", detail: "Solo guitar · 2:18", type: "analysis", createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5) },
  ]);
}

router.get("/dashboard", async (req, res): Promise<void> => {
  await ensureSeeded();
  const projects = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.ownerId, req.user!.id));
  const projectIds = projects.map((project) => project.id);
  const [artifacts, activities] = projectIds.length
    ? await Promise.all([
        db.select().from(musicArtifactsTable)
          .where(inArray(musicArtifactsTable.projectId, projectIds)),
        db.select().from(studioActivitiesTable)
          .where(inArray(studioActivitiesTable.projectId, projectIds))
          .orderBy(desc(studioActivitiesTable.createdAt))
          .limit(8),
      ])
    : [[], []];
  const payload = {
    activeProjects: projects.length,
    totalRenders: artifacts.filter((item) => ["AUDIO_TRACK", "MIX", "MASTER"].includes(item.type)).length,
    savedArtifacts: artifacts.length,
    recentActivity: activities.map((item) => ({
      id: item.id,
      title: item.title,
      detail: item.detail,
      time: iso(item.createdAt),
      type: item.type,
    })),
  };
  res.json(GetDashboardResponse.parse(payload));
});

router.get("/projects", async (req, res): Promise<void> => {
  await ensureSeeded();
  const projects = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.ownerId, req.user!.id))
    .orderBy(desc(musicProjectsTable.updatedAt));
  res.json(ListProjectsResponse.parse(projects.map(projectResponse)));
});

router.post("/projects", async (req, res): Promise<void> => {
  const body = CreateProjectBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const id = randomUUID();
  const [project] = await db.insert(musicProjectsTable).values({
    id,
    name: body.data.name,
    sourceType: body.data.sourceType,
    sourceName: body.data.sourceName ?? null,
    ownerId: req.user!.id,
    status: "draft",
    coverColor: "#06b6d4",
  }).returning();
  await db.insert(studioActivitiesTable).values({
    id: randomUUID(),
    projectId: id,
    title: "Project created",
    detail: body.data.sourceName ?? body.data.sourceType,
    type: "analysis",
  });
  res.status(201).json(CreateProjectResponse.parse(projectResponse(project)));
});

router.get("/projects/:projectId", async (req, res): Promise<void> => {
  await ensureSeeded();
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [project] = await db.select().from(musicProjectsTable).where(eq(musicProjectsTable.id, params.data.projectId));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [arrangements, tracks, artifacts] = await Promise.all([
    db.select().from(arrangementsTable).where(eq(arrangementsTable.projectId, project.id)).orderBy(desc(arrangementsTable.version)),
    db.select().from(tracksTable).where(eq(tracksTable.projectId, project.id)),
    db.select().from(musicArtifactsTable).where(eq(musicArtifactsTable.projectId, project.id)).orderBy(desc(musicArtifactsTable.createdAt)),
  ]);
  res.json(GetProjectResponse.parse({
    project: projectResponse(project),
    analysis: analysisResponse(project),
    arrangements: arrangements.map(arrangementResponse),
    tracks,
    artifacts: artifacts.map(artifactResponse),
  }));
});

router.get("/projects/:projectId/sources", async (req, res): Promise<void> => {
  const params = ListProjectSourcesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const sources = await db
    .select()
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.projectId, params.data.projectId))
    .orderBy(desc(projectSourcesTable.createdAt));
  res.json(ListProjectSourcesResponse.parse(sources.map(sourceResponse)));
});

router.post("/projects/:projectId/sources", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = RegisterProjectSourceParams.safeParse(req.params);
  const body = RegisterProjectSourceBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid source metadata" });
    return;
  }
  const [project] = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, params.data.projectId))
    .limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.ownerId && project.ownerId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const sourceFormat = validateSourceFileMetadata(
    body.data.name,
    body.data.contentType,
  );
  if (!sourceFormat.valid) {
    res.status(415).json({ error: "Unsupported source file format" });
    return;
  }
  if (!body.data.objectPath.startsWith("/objects/uploads/")) {
    res.status(400).json({ error: "Invalid uploaded object path" });
    return;
  }
  const [source] = await db.insert(projectSourcesTable).values({
    id: randomUUID(),
    projectId: project.id,
    ownerId: req.user.id,
    objectPath: body.data.objectPath,
    name: body.data.name,
    size: body.data.size,
    contentType: sourceFormat.normalizedContentType,
    sourceType: body.data.sourceType,
    status: "queued",
    progress: 4,
  }).returning();
  await db.insert(analysisJobsTable).values({
    id: randomUUID(),
    projectId: project.id,
    sourceId: source.id,
    status: "queued",
    stage: "queued",
    progress: 4,
  });
  await db.update(musicProjectsTable)
    .set({
      ownerId: project.ownerId ?? req.user.id,
      sourceName: body.data.name,
      sourceType: body.data.sourceType,
      status: "analyzing",
      updatedAt: new Date(),
    })
    .where(eq(musicProjectsTable.id, project.id));
  setImmediate(() => {
    void analyzeProjectSource(source.id);
  });
  res.status(202).json(RegisterProjectSourceResponse.parse(sourceResponse(source)));
});

router.get("/projects/:projectId/song-model", async (req, res): Promise<void> => {
  const params = GetProjectSongModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [songModel] = await db
    .select()
    .from(songModelsTable)
    .where(eq(songModelsTable.projectId, params.data.projectId))
    .orderBy(desc(songModelsTable.version))
    .limit(1);
  if (!songModel) {
    res.status(404).json({ error: "Song Model not ready" });
    return;
  }
  res.json(GetProjectSongModelResponse.parse(songModelResponse(songModel)));
});

router.patch("/projects/:projectId/song-model", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = CorrectProjectSongModelParams.safeParse(req.params);
  const body = CorrectProjectSongModelBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid Song Model correction" });
    return;
  }

  const [project] = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, params.data.projectId))
    .limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.ownerId && project.ownerId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [latest] = await db
    .select()
    .from(songModelsTable)
    .where(eq(songModelsTable.projectId, project.id))
    .orderBy(desc(songModelsTable.version))
    .limit(1);
  if (!latest) {
    res.status(404).json({ error: "Song Model not ready" });
    return;
  }

  const correction = body.data;
  if (correction.baseVersion !== latest.version) {
    res.status(409).json({
      error: "Song Model changed while corrections were being edited. Review the latest version and try again.",
    });
    return;
  }
  if (correction.sections) {
    if (correction.sections.length !== latest.model.sections.length) {
      res.status(400).json({ error: "Section corrections must retain the existing section count" });
      return;
    }
    const invalidBoundary = correction.sections.some((section, index) =>
      !Number.isInteger(section.startBar) ||
      !Number.isInteger(section.endBar) ||
      section.endBar < section.startBar ||
      (index > 0 && section.startBar <= correction.sections![index - 1].endBar),
    );
    if (invalidBoundary) {
      res.status(400).json({ error: "Section boundaries must be ordered and have an end bar at or after their start bar" });
      return;
    }
  }

  const fields = (["bpm", "key", "meter", "sections"] as const)
    .filter((field) => correction[field] !== undefined);
  const now = new Date();
  const existingTempo = latest.model.tempoMap[0];
  const existingKey = latest.model.keyMap[0];
  const existingMeter = latest.model.meterMap[0];
  const correctedModel = {
    ...latest.model,
    ...(correction.bpm === undefined
      ? {}
      : {
          tempoMap: [
            {
              time: existingTempo?.time ?? 0,
              bpm: correction.bpm,
              confidence: existingTempo?.confidence
                ?? latest.model.confidenceByField.tempo
                ?? latest.confidence,
            },
            ...latest.model.tempoMap.slice(1),
          ],
        }),
    ...(correction.key === undefined
      ? {}
      : {
          keyMap: [
            {
              time: existingKey?.time ?? 0,
              key: correction.key,
              confidence: existingKey?.confidence
                ?? latest.model.confidenceByField.key
                ?? latest.confidence,
            },
            ...latest.model.keyMap.slice(1),
          ],
        }),
    ...(correction.meter === undefined
      ? {}
      : {
          meterMap: [
            {
              bar: existingMeter?.bar ?? 1,
              meter: correction.meter,
              confidence: existingMeter?.confidence
                ?? latest.model.confidenceByField.meter
                ?? latest.confidence,
            },
            ...latest.model.meterMap.slice(1),
          ],
        }),
    ...(correction.sections === undefined
      ? {}
      : {
          sections: correction.sections.map((section, index) => ({
            ...section,
            energy: latest.model.sections[index].energy,
          })),
        }),
  };

  const created = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${project.id}))`,
    );
    const [lockedLatest] = await tx
      .select()
      .from(songModelsTable)
      .where(eq(songModelsTable.projectId, project.id))
      .orderBy(desc(songModelsTable.version), desc(songModelsTable.createdAt))
      .limit(1);
    if (
      !lockedLatest ||
      lockedLatest.id !== latest.id ||
      lockedLatest.version !== correction.baseVersion
    ) {
      return null;
    }
    const [newModel] = await tx
      .insert(songModelsTable)
      .values({
        id: randomUUID(),
        projectId: project.id,
        sourceId: lockedLatest.sourceId,
        version: lockedLatest.version + 1,
        status: "ready",
        parentModelId: lockedLatest.id,
        correction: {
          correctedBy: req.user.id,
          correctedAt: now.toISOString(),
          fields,
        },
        model: correctedModel,
        providers: lockedLatest.providers,
        confidence: lockedLatest.confidence,
        createdAt: now,
      })
      .returning();
    await tx
      .update(musicProjectsTable)
      .set({
        ownerId: project.ownerId ?? req.user.id,
        ...(correction.bpm === undefined ? {} : { bpm: correction.bpm }),
        ...(correction.key === undefined ? {} : { key: correction.key }),
        ...(correction.meter === undefined ? {} : { meter: correction.meter }),
        ...(correctedModel.sections === latest.model.sections
          ? {}
          : { sections: correctedModel.sections }),
        updatedAt: now,
      })
      .where(eq(musicProjectsTable.id, project.id));
    await tx.insert(studioActivitiesTable).values({
      id: randomUUID(),
      projectId: project.id,
      title: "Song Model corrected",
      detail: `v${newModel.version} · ${fields.join(", ")}`,
      type: "analysis",
      createdAt: now,
    });
    return newModel;
  });
  if (!created) {
    res.status(409).json({
      error: "Song Model changed while corrections were being saved. Review the latest version and try again.",
    });
    return;
  }

  res.json(CorrectProjectSongModelResponse.parse(songModelResponse(created)));
});

router.get("/projects/:projectId/analysis-jobs", async (req, res): Promise<void> => {
  const params = ListAnalysisJobsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const jobs = await db
    .select()
    .from(analysisJobsTable)
    .where(eq(analysisJobsTable.projectId, params.data.projectId))
    .orderBy(desc(analysisJobsTable.createdAt));
  res.json(ListAnalysisJobsResponse.parse(jobs.map(analysisJobResponse)));
});

router.post("/projects/:projectId/sources/:sourceId/retry", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = RetrySourceAnalysisParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [source] = await db
    .select()
    .from(projectSourcesTable)
    .where(and(
      eq(projectSourcesTable.id, params.data.sourceId),
      eq(projectSourcesTable.projectId, params.data.projectId),
    ))
    .limit(1);
  if (!source) {
    res.status(404).json({ error: "Source not found" });
    return;
  }
  if (source.ownerId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [latest] = await db
    .select()
    .from(analysisJobsTable)
    .where(eq(analysisJobsTable.sourceId, source.id))
    .orderBy(desc(analysisJobsTable.createdAt))
    .limit(1);
  if (latest?.status === "queued" || latest?.status === "running") {
    res.status(409).json({ error: "Analysis is already running" });
    return;
  }
  const [job] = await db.insert(analysisJobsTable).values({
    id: randomUUID(),
    projectId: source.projectId,
    sourceId: source.id,
    status: "queued",
    stage: "queued",
    progress: 4,
    attempt: (latest?.attempt ?? 0) + 1,
  }).onConflictDoNothing().returning();
  if (!job) {
    res.status(409).json({ error: "A retry was already queued for this source" });
    return;
  }
  await db.update(projectSourcesTable)
    .set({ status: "queued", progress: 4, error: null })
    .where(eq(projectSourcesTable.id, source.id));
  await db.update(musicProjectsTable)
    .set({ status: "analyzing", updatedAt: new Date() })
    .where(eq(musicProjectsTable.id, source.projectId));
  setImmediate(() => {
    void analyzeProjectSource(source.id);
  });
  res.status(202).json(RetrySourceAnalysisResponse.parse(analysisJobResponse(job)));
});

router.get("/providers", (_req, res): void => {
  res.json(ListMusicProvidersResponse.parse(MUSIC_PROVIDERS));
});

router.get("/projects/:projectId/arrangements", async (req, res): Promise<void> => {
  const params = ListArrangementsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const arrangements = await db.select().from(arrangementsTable).where(eq(arrangementsTable.projectId, params.data.projectId)).orderBy(desc(arrangementsTable.version));
  res.json(ListArrangementsResponse.parse(arrangements.map(arrangementResponse)));
});

router.post("/projects/:projectId/arrangements", async (req, res): Promise<void> => {
  const params = CreateArrangementParams.safeParse(req.params);
  const body = CreateArrangementBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid arrangement request" });
    return;
  }
  const existing = await db.select().from(arrangementsTable).where(eq(arrangementsTable.projectId, params.data.projectId));
  const [arrangement] = await db.insert(arrangementsTable).values({
    id: randomUUID(),
    projectId: params.data.projectId,
    name: body.data.name,
    style: body.data.style,
    mode: body.data.mode,
    version: existing.length + 1,
    harmonyComplexity: body.data.harmonyComplexity,
    sections: [],
  }).returning();
  res.status(201).json(CreateArrangementResponse.parse(arrangementResponse(arrangement)));
});

router.patch("/arrangements/:arrangementId", async (req, res): Promise<void> => {
  const params = UpdateArrangementParams.safeParse(req.params);
  const body = UpdateArrangementBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid arrangement update" });
    return;
  }
  if (body.data.selectedCandidateId) {
    const [existing] = await db
      .select({ candidates: arrangementsTable.candidates })
      .from(arrangementsTable)
      .where(eq(arrangementsTable.id, params.data.arrangementId))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Arrangement not found" });
      return;
    }
    if (!existing.candidates.some((candidate) => candidate.id === body.data.selectedCandidateId)) {
      res.status(400).json({ error: "Selected candidate does not belong to this arrangement" });
      return;
    }
  }
  const [arrangement] = await db.update(arrangementsTable).set(body.data).where(eq(arrangementsTable.id, params.data.arrangementId)).returning();
  if (!arrangement) {
    res.status(404).json({ error: "Arrangement not found" });
    return;
  }
  res.json(UpdateArrangementResponse.parse(arrangementResponse(arrangement)));
});

router.post("/arrangements/:arrangementId/generate", async (req, res): Promise<void> => {
  const params = GenerateArrangementParams.safeParse(req.params);
  const body = GenerateArrangementBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid generation request" });
    return;
  }
  const [existingArrangement] = await db
    .select()
    .from(arrangementsTable)
    .where(eq(arrangementsTable.id, params.data.arrangementId));
  if (!existingArrangement) {
    res.status(404).json({ error: "Arrangement not found" });
    return;
  }
  const [songModel] = await db
    .select()
    .from(songModelsTable)
    .where(eq(songModelsTable.projectId, existingArrangement.projectId))
    .orderBy(desc(songModelsTable.version))
    .limit(1);
  if (!songModel) {
    res.status(409).json({ error: "Analyze a source and review its Song Model before generating" });
    return;
  }
  const [source] = await db
    .select({ sourceType: projectSourcesTable.sourceType })
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.id, songModel.sourceId))
    .limit(1);
  const sourceType = source?.sourceType ?? "FULL_SONG";
  const count = Math.max(1, Math.min(3, Math.round(body.data.candidates ?? 3)));
  let provider;
  try {
    provider = selectArrangementProvider(body.data.provider, sourceType);
    await db.update(arrangementsTable)
      .set({ status: "generating" })
      .where(eq(arrangementsTable.id, existingArrangement.id));
    const output = await runArrangementProvider(provider, {
      projectId: existingArrangement.projectId,
      arrangementId: existingArrangement.id,
      style: existingArrangement.style,
      mode: existingArrangement.mode,
      sourceType,
      harmonyComplexity: existingArrangement.harmonyComplexity,
      energy: existingArrangement.energy,
      density: existingArrangement.density,
      candidateCount: count,
      seed: body.data.seed,
      songModel: songModel.model,
    });
    const validationErrors = validateArrangementProviderOutput(output, count);
    if (validationErrors.length) {
      await db.update(arrangementsTable)
        .set({ status: "draft" })
        .where(eq(arrangementsTable.id, existingArrangement.id));
      res.status(422).json({
        error: "Provider output failed validation",
        details: validationErrors,
      });
      return;
    }
    const [arrangement] = await db.update(arrangementsTable).set({
      status: "ready",
      sections: output.sections,
      generationProvider: provider.id,
      candidates: output.candidates,
      selectedCandidateId: output.candidates[0].id,
    }).where(eq(arrangementsTable.id, existingArrangement.id)).returning();
    await db.insert(musicArtifactsTable).values({
      id: randomUUID(),
      projectId: arrangement.projectId,
      type: "ARRANGEMENT_PLAN",
      label: `${arrangement.name} · v${arrangement.version} · ${provider.id}`,
      version: arrangement.version,
      size: `${Math.max(1, Math.round(JSON.stringify(output).length / 1024))} KB`,
      format: "JSON",
    });
    res.json(GenerateArrangementResponse.parse({
      arrangement: arrangementResponse(arrangement),
      candidates: output.candidates,
      selectedCandidate: output.candidates[0].id,
      provider,
    }));
  } catch (error) {
    await db.update(arrangementsTable)
      .set({ status: "draft" })
      .where(eq(arrangementsTable.id, existingArrangement.id));
    if (error instanceof ProviderUnavailableError) {
      res.status(503).json({
        error: error.message,
        provider: error.providerId,
      });
      return;
    }
    req.log.error({ err: error, provider: provider?.id }, "Arrangement provider failed");
    res.status(502).json({ error: "Arrangement provider failed" });
  }
});

router.post("/arrangements/:arrangementId/export", async (req, res): Promise<void> => {
  const [redirectArrangement] = await db
    .select({ projectId: arrangementsTable.projectId })
    .from(arrangementsTable)
    .where(eq(arrangementsTable.id, req.params.arrangementId));
  if (!redirectArrangement) {
    res.status(404).json({ error: "Arrangement not found" });
    return;
  }
  res.setHeader("Deprecation", "true");
  res.redirect(
    307,
    `/api/projects/${redirectArrangement.projectId}/export?arrangementId=${encodeURIComponent(req.params.arrangementId)}`,
  );
  return;

  /*
   * Retired fixed-duration renderer. Kept in the rebase history only; the live
   * compatibility alias above always forwards to the durable project pipeline.
   *
  const params = ExportArrangementParams.safeParse(req.params);
  const body = ExportArrangementBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid export request" });
    return;
  }

  const [arrangement] = await db
    .select()
    .from(arrangementsTable)
    .where(eq(arrangementsTable.id, params.data.arrangementId));
  if (!arrangement) {
    res.status(404).json({ error: "Arrangement not found" });
    return;
  }
  const [project] = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, arrangement.projectId));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const tracks = await db
    .select()
    .from(tracksTable)
    .where(eq(tracksTable.projectId, project.id));
  if (tracks.length === 0) {
    res.status(400).json({ error: "No tracks are available to export" });
    return;
  }
  if (tracks.length > 24) {
    res.status(400).json({ error: "Exports support up to 24 tracks per arrangement" });
    return;
  }

  const exportId = randomUUID();
  const masterProfile = body.data.masterProfile ?? "STREAMING";
  await db.insert(musicExportsTable).values({
    id: exportId,
    projectId: project.id,
    arrangementId: arrangement.id,
    status: "rendering",
    masterProfile,
  });
  const uploadedUrls: string[] = [];
  try {
  const renderedFiles = renderArrangementExport({
    projectName: project.name,
    bpm: project.bpm,
    key: project.key,
    meter: project.meter,
    arrangementName: arrangement.name,
    arrangementVersion: arrangement.version,
    masterProfile,
    energy: arrangement.energy,
    density: arrangement.density,
    harmonyComplexity: arrangement.harmonyComplexity,
    sections: arrangement.sections,
    tracks,
    includeStems: body.data.includeStems ?? true,
    includeMidi: body.data.includeMidi ?? true,
  });
  const storedFiles: Array<{
    name: string;
    type: typeof renderedFiles[number]["type"];
    size: string;
    format: string;
    url: string;
    data: Buffer;
  }> = [];
  for (const file of renderedFiles) {
    const url = await saveExportObject(
      `${exportId}/${file.name}`,
      file.data,
      file.contentType,
    );
    uploadedUrls.push(url);
    storedFiles.push({
      name: file.name,
      type: file.type,
      size: formatBytes(file.data.length),
      format: file.format,
      url,
      data: file.data,
    });
  }
  const zip = createZip(
    storedFiles.map(({ name, data }) => ({ name, data })),
  );
  const bundleName = `${project.name.replace(/[^\w-]+/g, "_") || "music_project"}_v${arrangement.version}.zip`;
  const bundleUrl = await saveExportObject(
    `${exportId}/${bundleName}`,
    zip,
    "application/zip",
  );
  uploadedUrls.push(bundleUrl);
  const createdAt = new Date();

  const artifactRows = storedFiles.map((file) => ({
    id: randomUUID(),
    projectId: project.id,
    type:
      file.type === "STEM"
        ? "AUDIO_TRACK"
        : file.type === "MIDI"
          ? "MIDI"
          : file.type === "MASTER"
            ? "MASTER"
            : file.type === "PREMASTER" || file.type === "MIX"
              ? "MIX"
              : "EXPORT",
    label: file.name.split("/").pop() || file.name,
    version: arrangement.version,
    size: file.size,
    format: file.format,
    url: file.url,
    createdAt,
  }));
  artifactRows.push({
    id: randomUUID(),
    projectId: project.id,
    type: "EXPORT",
    label: bundleName,
    version: arrangement.version,
    size: formatBytes(zip.length),
    format: "ZIP",
    url: bundleUrl,
    createdAt,
  });
  const resultFiles = [
    ...storedFiles.map(({ data: _data, ...file }) => file),
    {
      name: bundleName,
      type: "BUNDLE" as const,
      size: formatBytes(zip.length),
      format: "ZIP",
      url: bundleUrl,
    },
  ];
  await db.transaction(async (tx) => {
    await tx.insert(musicArtifactsTable).values(artifactRows);
    await tx.insert(studioActivitiesTable).values({
      id: randomUUID(),
      projectId: project.id,
      title: "Export package completed",
      detail: `${storedFiles.length} files · ${masterProfile.toLowerCase()} master`,
      type: "export",
    });
    await tx
      .update(musicExportsTable)
      .set({
        status: "ready",
        bundleUrl,
        files: resultFiles,
        completedAt: createdAt,
      })
      .where(eq(musicExportsTable.id, exportId));
  });

  res.json(ExportArrangementResponse.parse({
    id: exportId,
    status: "ready",
    files: resultFiles,
    bundleUrl,
    createdAt: createdAt.toISOString(),
  }));
  } catch (error) {
    req.log.error({ err: error, exportId }, "Arrangement export failed");
    await db
      .update(musicExportsTable)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown export failure",
        completedAt: new Date(),
      })
      .where(eq(musicExportsTable.id, exportId));
    await Promise.allSettled(
      uploadedUrls.map((url) => deleteExportObject(url)),
    );
    res.status(500).json({ error: "Arrangement export failed" });
  }
  */
});

router.post("/projects/:projectId/export", async (req, res): Promise<void> => {
  await ensureSeeded();
  const params = CreateProjectExportParams.safeParse(req.params);
  const body = CreateProjectExportBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid export request" });
    return;
  }

  const [project] = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, params.data.projectId));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [arrangements, tracks] = await Promise.all([
    db
      .select()
      .from(arrangementsTable)
      .where(eq(arrangementsTable.projectId, project.id))
      .orderBy(desc(arrangementsTable.version)),
    db.select().from(tracksTable).where(eq(tracksTable.projectId, project.id)),
  ]);
  const arrangementId = body.data.arrangementId
    ?? (typeof req.query.arrangementId === "string" ? req.query.arrangementId : null);
  const arrangement = arrangementId
    ? arrangements.find((item) => item.id === arrangementId)
    : arrangements[0];
  if (!arrangement) {
    res.status(404).json({ error: "Arrangement not found" });
    return;
  }

  const hasSoloTrack = tracks.some((track) => track.solo);
  const performanceTracks = tracks.map((track, index) => ({
    ...track,
    performance: createTrackPerformance(
      track,
      project,
      arrangement,
      index,
      hasSoloTrack,
    ),
  }));
  await Promise.all(
    performanceTracks.map((track) => db
      .update(tracksTable)
      .set({ performance: track.performance })
      .where(eq(tracksTable.id, track.id))),
  );

  const allocation = await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`music-export:${project.id}`}))`,
    );
    const exportArtifacts = await transaction
      .select({ version: musicArtifactsTable.version })
      .from(musicArtifactsTable)
      .where(sql`${musicArtifactsTable.projectId} = ${project.id} and ${musicArtifactsTable.type} = 'EXPORT'`);
    const version = Math.max(0, ...exportArtifacts.map((artifact) => artifact.version)) + 1;
    const exportId = `export-${project.id}-${version}-${randomUUID().slice(0, 8)}`;
    await transaction.insert(musicArtifactsTable).values({
      id: exportId,
      projectId: project.id,
      type: "EXPORT",
      label: `${project.name} v${version} export`,
      version,
      size: "Rendering",
      format: "ZIP",
      url: `/api/exports/${exportId}/download`,
      state: "rendering",
    });
    return { exportId, version };
  });

  try {
    const bundle = createExportBundle(
      project,
      arrangement,
      performanceTracks,
      body.data,
      allocation.version,
      "",
      allocation.exportId,
    );
    await persistExportBundle(bundle);
    exportBundles.set(bundle.package.id, bundle);

    const artifactRows: Array<typeof musicArtifactsTable.$inferInsert> =
      bundle.package.files.map((file) => ({
        id: randomUUID(),
        projectId: project.id,
        type: file.type,
        label: file.name,
        version: allocation.version,
        size: file.size,
        format: file.format,
        url: bundle.package.url,
      }));
    await Promise.all([
      db.insert(musicArtifactsTable).values(artifactRows),
      db
        .update(musicArtifactsTable)
        .set({
          label: bundle.package.filename,
          size: bundle.package.size,
          url: bundle.package.url,
          state: "ready",
        })
        .where(eq(musicArtifactsTable.id, allocation.exportId)),
      db
        .update(musicProjectsTable)
        .set({ status: "ready" })
        .where(eq(musicProjectsTable.id, project.id)),
      db.insert(studioActivitiesTable).values({
        id: randomUUID(),
        projectId: project.id,
        title: "Export package ready",
        detail: `${bundle.package.filename} · ${bundle.package.size}`,
        type: "export",
      }),
    ]);

    req.log.info(
      {
        projectId: project.id,
        exportId: bundle.package.id,
        version: allocation.version,
        files: bundle.package.files.length,
        bytes: bundle.zip.length,
      },
      "Project export rendered",
    );
    res.status(201).json(CreateProjectExportResponse.parse(bundle.package));
  } catch (error) {
    await db
      .update(musicArtifactsTable)
      .set({ state: "failed", size: "Failed" })
      .where(eq(musicArtifactsTable.id, allocation.exportId));
    throw error;
  }
});

router.get("/exports/:exportId/download", async (req, res): Promise<void> => {
  const params = DownloadProjectExportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cachedBundle = exportBundles.get(params.data.exportId);
  const [artifact] = await db
    .select()
    .from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.id, params.data.exportId));
  if (!artifact || artifact.type !== "EXPORT") {
    res.status(404).json({ error: "Export package not found or expired" });
    return;
  }
  if (artifact.state !== "ready") {
    res.status(409).json({ error: `Export package is ${artifact.state}` });
    return;
  }
  const zip = cachedBundle?.zip ?? await loadExportZip(params.data.exportId);
  if (!zip) {
    res.status(404).json({ error: "Export package not found or expired" });
    return;
  }
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${artifact.label}"`,
  );
  res.setHeader("Content-Length", zip.length.toString());
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(zip);
});

router.get("/projects/:projectId/tracks", async (req, res): Promise<void> => {
  const params = ListTracksParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const tracks = await db.select().from(tracksTable).where(eq(tracksTable.projectId, params.data.projectId));
  res.json(ListTracksResponse.parse(tracks));
});

router.get("/projects/:projectId/artifacts", async (req, res): Promise<void> => {
  const params = ListArtifactsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const artifacts = await db.select().from(musicArtifactsTable).where(eq(musicArtifactsTable.projectId, params.data.projectId)).orderBy(desc(musicArtifactsTable.createdAt));
  res.json(ListArtifactsResponse.parse(artifacts.map(artifactResponse)));
});

router.post("/projects/:projectId/copilot", async (req, res): Promise<void> => {
  const params = RunCopilotParams.safeParse(req.params);
  const body = RunCopilotBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid copilot command" });
    return;
  }
  const command = body.data.command.toLowerCase();
  const operations: Array<{ type: string; label: string }> = [];
  const affectedSections: string[] = [];
  if (command.includes("drum")) operations.push({ type: "UPDATE_TRACK", label: "Update drums" });
  if (command.includes("piano") || command.includes("guitar")) operations.push({ type: "REPLACE_INSTRUMENT", label: "Replace instrument" });
  if (command.includes("cello") || command.includes("counter")) operations.push({ type: "ADD_COUNTERMELODY", label: "Add cello countermelody" });
  if (command.includes("modulat") || command.includes("tone") || command.includes("טון")) operations.push({ type: "MODULATE", label: "Modulate final chorus" });
  if (command.includes("bridge") || command.includes("גשר")) affectedSections.push("Bridge");
  if (command.includes("chorus") || command.includes("פזמון")) affectedSections.push("Final Chorus");
  if (command.includes("verse") || command.includes("בית")) affectedSections.push("Verse 1");
  if (operations.length === 0) operations.push({ type: "REFINE_ARRANGEMENT", label: "Refine arrangement direction" });
  if (affectedSections.length === 0) affectedSections.push("Full arrangement");
  res.json(RunCopilotResponse.parse({
    reply: `Prepared ${operations.length} focused arrangement ${operations.length === 1 ? "change" : "changes"} without regenerating the full song.`,
    operations,
    affectedSections,
  }));
});

export default router;
