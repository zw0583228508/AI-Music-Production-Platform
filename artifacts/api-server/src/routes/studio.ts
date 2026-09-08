import { createHash, randomUUID } from "node:crypto";
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  AnalyzeProjectBody,
  AnalyzeProjectParams,
  AnalyzeProjectResponse,
  CancelGenerationJobParams,
  CancelGenerationJobResponse,
  CreateArrangementBody,
  CreateArrangementParams,
  CreateArrangementResponse,
  CreateProjectExportBody,
  CreateProjectExportParams,
  CreateProjectExportResponse,
  CreateProjectBody,
  CreateProjectResponse,
  DeleteProjectResponse,
  DownloadProjectExportParams,
  GenerateArrangementBody,
  GenerateArrangementParams,
  GenerateArrangementResponse,
  GetGenerationJobParams,
  GetGenerationJobResponse,
  ListGenerationCandidatesParams,
  ListGenerationCandidatesResponse,
  ListGenerationProvidersResponse,
  ListLicensedInstrumentPacksResponse,
  ReactivateLicensedInstrumentPackParams,
  ReactivateLicensedInstrumentPackResponse,
  SelectGenerationCandidateParams,
  SelectGenerationCandidateResponse,
  StageLicensedInstrumentPackResponse,
  ActivateLicensedInstrumentPackParams,
  ActivateLicensedInstrumentPackResponse,
  GetDashboardResponse,
  GetProjectDeletionParams,
  GetProjectDeletionResponse,
  GetProjectParams,
  GetProjectResponse,
  GetProjectSongModelParams,
  GetProjectSongModelResponse,
  CorrectProjectSongModelBody,
  CorrectProjectSongModelParams,
  CorrectProjectSongModelResponse,
  ListArrangementRevisionsParams,
  ListArrangementRevisionsResponse,
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
  RetryProjectSourceAnalysisParams,
  RetryProjectSourceAnalysisResponse,
  RestoreArrangementRevisionBody,
  RestoreArrangementRevisionParams,
  RestoreArrangementRevisionResponse,
  RetryProjectDeletionParams,
  RetryProjectDeletionResponse,
  RetryGenerationJobParams,
  RetryGenerationJobResponse,
  RepairGenerationCandidateBody,
  RepairGenerationCandidateParams,
  RepairGenerationCandidateResponse,
  UpdateArrangementBody,
  UpdateArrangementParams,
  UpdateArrangementResponse,
  ListMixMasterRevisionsParams,
  ListMixMasterRevisionsResponse,
  CreateMixMasterRevisionParams,
  CreateMixMasterRevisionBody,
  CreateMixMasterRevisionResponse,
  ApproveMixMasterRevisionParams,
  ApproveMixMasterRevisionResponse,
  CreateProducerDecisionBody,
  CreateProducerDecisionResponse,
  GetProducerPreferencesResponse,
  ListProducerDecisionsQueryParams,
  ListProducerDecisionsResponse,
  UpdateProducerPreferencesBody,
  UpdateProducerPreferencesResponse,
  ListProducerCalibrationsResponse,
  PromoteProducerCalibrationBody,
  PromoteProducerCalibrationResponse,
  EvaluateProducerCalibrationBody,
  EvaluateProducerCalibrationResponse,
  RollbackProducerCalibrationParams,
  RollbackProducerCalibrationResponse,
} from "@workspace/api-zod";
import {
  analysisJobsTable,
  arrangementRevisionsTable,
  arrangementsTable,
  analysisAttemptsTable,
  db,
  musicArtifactsTable,
  musicGenerationCandidatesTable,
  musicExportsTable,
  musicAuditEventsTable,
  musicProjectsTable,
  projectCleanupJobsTable,
  projectUploadReservationsTable,
  productionJobsTable,
  projectSourcesTable,
  songModelsTable,
  studioActivitiesTable,
  tracksTable,
  mixMasterRevisionsTable,
  type ArrangementRevisionSnapshot,
  type SongModelData,
  type SongModelField,
  type SongModelFieldStatus,
  type MixMasterControls,
  type MixMasterFinding,
} from "@workspace/db";
import {
  queueProductionJob,
  requestProductionJobCancellation,
  retryProductionJob,
} from "../lib/productionJobs";
import { runExportProductionJob } from "../lib/exportJobs";
import {
  createZip,
  formatBytes,
  renderArrangementExport,
} from "../lib/exportEngine";
import { estimateTruePeak4x } from "../lib/audioMeter";
import {
  deleteAnalysisObjects,
  deleteExportObject,
  deletePrivateObject,
  getPrivateObject,
  isSourceObjectPath,
  saveExportObject,
} from "../lib/objectStorage";
import { logger } from "../lib/logger";
import {
  signalProjectStorageRaceEvent,
  waitForProjectStorageRaceGate,
} from "../lib/projectStorageRaceTestHook";
import { queueProjectSourceAnalysis } from "../lib/sourceAnalyzer";
import { validateSourceFileMetadata } from "../lib/sourceFormats";
import { interpretCopilotCommand } from "../lib/copilotInterpreter";
import {
  verifiedProviderDescriptorCatalog,
  validateCanonicalTrackModels,
} from "../lib/musicProviders";
import {
  createExportBundle,
  loadExportZip,
  persistExportBundle,
  type ExportBundle,
} from "../lib/export-pipeline";
import {
  activateLicensedInstrumentPack as activateLicensedInstrumentPackOnWorker,
  applyArrangementEditorChanges,
  applyPlanModulations,
  buildTrackModels,
  canonicalPerformanceTimelineSha256,
  createArrangementPlan,
  createStyleSpec,
  ensureArrangementPlanHierarchy,
  LicensedInstrumentWorkerError,
  licensedInstrumentWorkerConfig,
  listLicensedInstrumentPacks,
  reactivateLicensedInstrumentPack as reactivateLicensedInstrumentPackOnWorker,
} from "../lib/musicEngines";
import {
  evaluateArrangementEligibility,
  fuseProviderSongModels,
  isLegacySongModel,
  canonicalizeSongModelCoordinates,
  refreshSongModelValidation,
  unavailableVocalIntelligence,
  validateCanonicalSongModel,
} from "../lib/songModelValidation";
import {
  cancelGenerationJob,
  generationCandidateResponse,
  generationJobResponse,
  getGenerationJobForOwner,
  listGenerationCandidatesForOwner,
  listProviderCatalog,
  queueArrangementGeneration,
  queueCandidateRepair,
  retryGenerationJob,
  selectGenerationCandidate,
} from "../lib/arrangementGeneration";
import { deployedCalibrationFeatures, publicCandidateEvaluation } from "../lib/candidateRanking";
import {
  revisionSummary,
  sectionsHavePerformanceChanges,
} from "../lib/arrangementRevisions";
import {
  appendProducerDecision,
  listProducerDecisions,
  preferencesForOwner,
  producerDecisionResponse,
  updatePreferences,
  evaluateCalibration,
  listCalibrations,
  promoteCalibration,
  rollbackCalibration,
  appendProducerDecisionTx,
} from "../lib/producerDecisionLedger";

const router: IRouter = Router();
const exportBundles = new Map<string, ExportBundle>();
const DEFAULT_INSTRUMENT_PACK_UPLOAD_BYTES = 2 * 1024 ** 3 + 32 * 1024 ** 2;
const DEFAULT_INSTRUMENT_PACK_TIMEOUT_MS = 30 * 60_000;

function configuredPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function instrumentPackUploadLimitBytes(): number {
  return configuredPositiveNumber(
    "MUSIC_STUDIO_MAX_INSTRUMENT_PACK_UPLOAD_BYTES",
    DEFAULT_INSTRUMENT_PACK_UPLOAD_BYTES,
  );
}

function instrumentPackTimeoutMs(): number {
  return configuredPositiveNumber(
    "MUSIC_STUDIO_INSTRUMENT_PACK_TIMEOUT_SECONDS",
    DEFAULT_INSTRUMENT_PACK_TIMEOUT_MS / 1000,
  ) * 1000;
}

function formatByteLimit(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

function requireStudioAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function requireStudioAdmin(req: Request, res: Response, next: NextFunction): void {
  const userIds = new Set(
    (process.env.MUSIC_STUDIO_ADMIN_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const emails = new Set(
    (process.env.MUSIC_STUDIO_ADMIN_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    !req.user ||
    (!userIds.has(req.user.id) && !emails.has(req.user.email?.toLowerCase() ?? ""))
  ) {
    res.status(403).json({ error: "Studio administrator access required" });
    return;
  }
  next();
}

function sendLicensedInstrumentWorkerError(
  error: unknown,
  res: Response,
): boolean {
  if (
    !(error instanceof LicensedInstrumentWorkerError)
    || ![404, 409].includes(error.status)
  ) {
    return false;
  }
  let detail = error.responseText.slice(0, 500);
  try {
    const payload = JSON.parse(error.responseText) as { detail?: unknown };
    if (typeof payload.detail === "string") detail = payload.detail;
  } catch {
    // Preserve the bounded worker response as the error detail.
  }
  res.status(error.status).json({ error: detail });
  return true;
}

router.use(requireStudioAuth);
router.use((req, res, next): void => {
  const requestId = String(req.id ?? randomUUID());
  res.on("finish", () => {
    void db.insert(musicAuditEventsTable).values({
      id: randomUUID(),
      actorId: req.user?.id ?? null,
      action: `${req.method.toLowerCase()}:${req.path}`,
      resourceType: "studio_api",
      requestId,
      outcome: res.statusCode >= 400 ? "failure" : "success",
      metadata: {
        statusCode: res.statusCode,
        method: req.method,
      },
    }).catch((error) => {
      req.log.warn({ err: error, requestId }, "music_audit_event_write_failed");
    });
  });
  next();
});

router.get("/instrument-packs", requireStudioAdmin, async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(
    ListLicensedInstrumentPacksResponse.parse(
      await listLicensedInstrumentPacks(),
    ),
  );
});

router.post(
  "/instrument-packs/stage",
  requireStudioAdmin,
  async (req, res): Promise<void> => {
    const contentType = req.headers["content-type"];
    if (!contentType?.startsWith("multipart/form-data")) {
      res.status(415).json({ error: "multipart/form-data is required" });
      return;
    }
    const contentLength = req.headers["content-length"];
    if (!contentLength || !/^\d+$/.test(contentLength)) {
      res.status(411).json({ error: "Content-Length is required" });
      return;
    }
    const declaredLength = Number(contentLength);
    const maximumLength = instrumentPackUploadLimitBytes();
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumLength) {
      res.status(413).json({
        error: `instrument pack upload exceeds the API streaming limit of ${formatByteLimit(maximumLength)}`,
      });
      return;
    }
    const worker = licensedInstrumentWorkerConfig();
    const clientAbort = new AbortController();
    let clientAborted = false;
    const abortForClient = (): void => {
      clientAborted = true;
      clientAbort.abort();
    };
    req.once("aborted", abortForClient);
    const timeoutSignal = AbortSignal.timeout(instrumentPackTimeoutMs());
    let response: globalThis.Response;
    let responseText: string;
    try {
      response = await fetch(new URL("/admin/assets/stage", worker.endpoint), {
        method: "POST",
        headers: {
          ...worker.headers,
          "Content-Type": contentType,
          "Content-Length": contentLength,
        },
        body: req as never,
        duplex: "half",
        signal: AbortSignal.any([clientAbort.signal, timeoutSignal]),
      } as RequestInit & { duplex: "half" });
      responseText = await response.text();
    } catch (error) {
      if (clientAborted || res.destroyed) return;
      if (timeoutSignal.aborted) {
        res.status(504).json({
          error: "instrument pack verification timed out; the active pack was not changed",
        });
        return;
      }
      req.log.error({ err: error }, "licensed_instrument_pack_worker_unavailable");
      res.status(502).json({
        error: "licensed instrument worker could not accept the pack; the active pack was not changed",
      });
      return;
    } finally {
      req.off("aborted", abortForClient);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = { detail: responseText.slice(0, 500) };
    }
    if (!response.ok) {
      res.status(response.status).json(payload);
      return;
    }
    res.status(201).json(StageLicensedInstrumentPackResponse.parse(payload));
  },
);

router.post(
  "/instrument-packs/:candidateId/activate",
  requireStudioAdmin,
  async (req, res): Promise<void> => {
    const params = ActivateLicensedInstrumentPackParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    try {
      res.json(
        ActivateLicensedInstrumentPackResponse.parse(
          await activateLicensedInstrumentPackOnWorker(params.data.candidateId),
        ),
      );
    } catch (error) {
      if (!sendLicensedInstrumentWorkerError(error, res)) throw error;
    }
  },
);

router.post(
  "/instrument-packs/history/:historyId/activate",
  requireStudioAdmin,
  async (req, res): Promise<void> => {
    const params = ReactivateLicensedInstrumentPackParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    try {
      res.json(
        ReactivateLicensedInstrumentPackResponse.parse(
          await reactivateLicensedInstrumentPackOnWorker(params.data.historyId),
        ),
      );
    } catch (error) {
      if (!sendLicensedInstrumentWorkerError(error, res)) throw error;
    }
  },
);

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
const nullableIso = (value: Date | null) => value ? iso(value) : null;
const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");
export function measureWav(buffer: Buffer): { integratedLufs: number; truePeakDbtp: number } {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") throw new Error("Rendered preview is not WAV audio");
  let sum = 0; let peak = 0; const samples = Math.floor((buffer.length - 44) / 2);
  const pcm = new Float64Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const value = buffer.readInt16LE(44 + index * 2) / 32768;
    pcm[index] = value; sum += value * value;
  }
  peak = estimateTruePeak4x(pcm);
  return {
    integratedLufs: 20 * Math.log10(Math.sqrt(sum / Math.max(1, samples)) + 1e-12),
    truePeakDbtp: 20 * Math.log10(peak + 1e-12),
  };
}
const productionJobResponse = (job: typeof productionJobsTable.$inferSelect) => ({
  id: job.id,
  projectId: job.projectId,
  kind: job.kind,
  status: job.status,
  stage: job.stage,
  progress: job.progress,
  attempt: job.attempt,
  maxAttempts: job.maxAttempts,
  retryable: job.retryable,
  error: job.error,
  outputArtifactIds: job.outputArtifactIds,
  createdAt: iso(job.createdAt),
  updatedAt: iso(job.updatedAt),
  completedAt: nullableIso(job.completedAt),
});

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
  plan: arrangement.plan
    ? ensureArrangementPlanHierarchy(arrangement.plan)
    : arrangement.plan,
  generationProvenance: arrangement.generationProvenance
    ? {
        ...arrangement.generationProvenance,
        evaluation: publicCandidateEvaluation(
          arrangement.generationProvenance.evaluation,
        ),
      }
    : arrangement.generationProvenance,
  createdAt: iso(arrangement.createdAt),
});

const arrangementRevisionSnapshot = (
  arrangement: typeof arrangementsTable.$inferSelect,
): ArrangementRevisionSnapshot => ({
  name: arrangement.name,
  harmonyComplexity: arrangement.harmonyComplexity,
  energy: arrangement.energy,
  density: arrangement.density,
  orchestraSize: arrangement.orchestraSize,
  rhythmIntensity: arrangement.rhythmIntensity,
  selectedCandidateId: arrangement.selectedCandidateId,
  sections: arrangement.sections,
});

const arrangementRevisionResponse = (
  revision: typeof arrangementRevisionsTable.$inferSelect,
) => ({
  ...revision,
  snapshot: {
    ...revision.snapshot,
    selectedCandidateId: revision.snapshot.selectedCandidateId ?? null,
  },
  summary: {
    ...revision.summary,
    trackMembershipChanges: revision.summary.trackMembershipChanges ?? 0,
    ccChanges: revision.summary.ccChanges ?? 0,
    candidateSelectionChanged: revision.summary.candidateSelectionChanged ?? false,
  },
  createdAt: iso(revision.createdAt),
});

async function ensureCurrentArrangementRevision(
  arrangement: typeof arrangementsTable.$inferSelect,
): Promise<void> {
  const snapshot = arrangementRevisionSnapshot(arrangement);
  await db
    .insert(arrangementRevisionsTable)
    .values({
      id: randomUUID(),
      arrangementId: arrangement.id,
      version: arrangement.version,
      snapshot,
      summary: revisionSummary(null, snapshot),
    })
    .onConflictDoNothing({
      target: [
        arrangementRevisionsTable.arrangementId,
        arrangementRevisionsTable.version,
      ],
    });
}

const artifactResponse = (
  artifact: typeof musicArtifactsTable.$inferSelect,
) => ({
  ...artifact,
  checksum: artifact.checksum ?? artifact.hash,
  expiresAt: artifact.expiresAt ? iso(artifact.expiresAt) : null,
  createdAt: iso(artifact.createdAt),
});

const mixMasterRevisionResponse = (
  revision: typeof mixMasterRevisionsTable.$inferSelect,
  previewUrl: string,
) => ({
  id: revision.id,
  projectId: revision.projectId,
  arrangementId: revision.arrangementId,
  version: revision.version,
  controls: revision.controls,
  previewUrl,
  variants: revision.evidence.variants,
  evidence: revision.evidence,
  approvedAt: nullableIso(revision.approvedAt),
  approvedBy: revision.approvedBy,
  createdAt: iso(revision.createdAt),
});

type ProjectCleanupPlan = {
  objectPaths: string[];
  analysisJobIds: string[];
};

function collectPrivateObjectPaths(value: unknown, paths: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("export-object://")) {
      const storageObjectId = value.slice("export-object://".length);
      if (/^[a-zA-Z0-9._-]+$/.test(storageObjectId)) {
        paths.add(`/api/storage/objects/exports/${storageObjectId}.zip`);
      }
      return;
    }
    if (
      value.startsWith("/objects/uploads/") ||
      value.startsWith("/objects/proxies/") ||
      value.startsWith("/objects/analysis/") ||
      value.startsWith("/api/storage/objects/exports/")
    ) {
      paths.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPrivateObjectPaths(item, paths);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectPrivateObjectPaths(item, paths);
    }
  }
}

async function runProjectCleanup(jobId: string): Promise<typeof projectCleanupJobsTable.$inferSelect> {
  const now = new Date();
  const leaseId = randomUUID();
  const [job] = await db
    .update(projectCleanupJobsTable)
    .set({
      status: "running",
      attempts: sql<number>`${projectCleanupJobsTable.attempts} + 1`,
      startedAt: now,
      leaseId,
      leaseExpiresAt: new Date(now.getTime() + 2 * 60_000),
      updatedAt: now,
    })
    .where(and(
      eq(projectCleanupJobsTable.id, jobId),
      or(
        inArray(projectCleanupJobsTable.status, ["queued", "partial"]),
        and(
          eq(projectCleanupJobsTable.status, "running"),
          or(
            isNull(projectCleanupJobsTable.leaseExpiresAt),
            lte(projectCleanupJobsTable.leaseExpiresAt, now),
          ),
        ),
      ),
    ))
    .returning();
  if (!job) {
    const [existing] = await db
      .select()
      .from(projectCleanupJobsTable)
      .where(eq(projectCleanupJobsTable.id, jobId))
      .limit(1);
    if (existing) return existing;
    throw new Error("Project cleanup job not found");
  }

  const failures: Array<{ path: string; error: string }> = [];
  await Promise.all([
    ...job.objectPaths.map(async (path) => {
      try {
        await deletePrivateObject(path);
      } catch (error) {
        failures.push({
          path,
          error: error instanceof Error ? error.message : "Unknown object cleanup failure",
        });
      }
    }),
    ...job.analysisJobIds.map(async (analysisJobId) => {
      try {
        await deleteAnalysisObjects(job.projectId, analysisJobId);
      } catch (error) {
        failures.push({
          path: `analysis:${analysisJobId}`,
          error: error instanceof Error ? error.message : "Unknown analysis cleanup failure",
        });
      }
    }),
  ]);

  const failedPaths = new Set(failures.map((failure) => failure.path));
  const remainingObjectPaths = job.objectPaths.filter((path) => failedPaths.has(path));
  const remainingAnalysisJobIds = job.analysisJobIds.filter((analysisJobId) =>
    failedPaths.has(`analysis:${analysisJobId}`),
  );
  const completed = remainingObjectPaths.length === 0 && remainingAnalysisJobIds.length === 0;
  const [updatedJob] = await db
    .update(projectCleanupJobsTable)
    .set({
      status: completed ? "completed" : "partial",
      objectPaths: remainingObjectPaths,
      analysisJobIds: remainingAnalysisJobIds,
      lastError: completed
        ? null
        : failures.map((failure) => `${failure.path}: ${failure.error}`).join("; "),
      leaseId: null,
      leaseExpiresAt: null,
      completedAt: completed ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(projectCleanupJobsTable.id, job.id),
      eq(projectCleanupJobsTable.status, "running"),
      eq(projectCleanupJobsTable.leaseId, leaseId),
    ))
    .returning();
  if (!updatedJob) {
    const [current] = await db
      .select()
      .from(projectCleanupJobsTable)
      .where(eq(projectCleanupJobsTable.id, job.id))
      .limit(1);
    if (!current) throw new Error("Project cleanup job disappeared");
    return current;
  }
  if (!completed) {
    logger.error(
      { cleanupJobId: job.id, projectId: job.projectId, failures },
      "music_project_cleanup_partial",
    );
  }
  return updatedJob;
}

const projectCleanupResponse = (
  job: typeof projectCleanupJobsTable.$inferSelect,
) => ({
  id: job.id,
  projectId: job.projectId,
  status: job.status,
  attempts: job.attempts,
  pendingObjectCount: job.objectPaths.length + job.analysisJobIds.length,
  lastError: job.lastError,
  createdAt: iso(job.createdAt),
  updatedAt: iso(job.updatedAt),
  completedAt: nullableIso(job.completedAt),
});

const sourceResponse = (
  source: typeof projectSourcesTable.$inferSelect,
  attempts: Array<typeof analysisAttemptsTable.$inferSelect> = [],
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
  attempts: attempts.map((attempt) => ({
    id: attempt.id,
    sourceId: attempt.sourceId,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    stage: attempt.stage,
    progress: attempt.progress,
    error: attempt.error,
    startedAt: nullableIso(attempt.startedAt),
    completedAt: nullableIso(attempt.completedAt),
    heartbeatAt: iso(attempt.heartbeatAt),
    createdAt: iso(attempt.createdAt),
  })),
  createdAt: iso(source.createdAt),
});

const songModelFields: SongModelField[] = [
  "tempo",
  "meter",
  "key",
  "melody",
  "bass",
  "harmony",
  "sections",
  "energy",
];

function normalizeSongModelQuality(model: SongModelData): {
  fieldStatus: Record<SongModelField, SongModelFieldStatus>;
  provenance: Record<SongModelField, string[]>;
} {
  const quality = model.fieldStatus ?? {};
  const provenance = !Array.isArray(model.provenance) ? model.provenance ?? {} : {};
  const fieldStatus = Object.fromEntries(songModelFields.map((field) => {
    const existing = quality[field];
    if (existing) return [field, existing];
    return [field, {
      status: "not_available",
      confidence: null,
      providers: [],
      message: "This legacy Song Model has no field-specific evidence. Reanalyze the source to verify it.",
      edited: false,
    }];
  })) as Record<SongModelField, SongModelFieldStatus>;

  return {
    fieldStatus,
    provenance: Object.fromEntries(songModelFields.map((field) => [
      field,
      quality[field] ? provenance[field] ?? fieldStatus[field].providers : [],
    ])) as Record<SongModelField, string[]>,
  };
}

function aggregateSongModelConfidence(
  fieldStatus: Record<SongModelField, SongModelFieldStatus>,
): number {
  const valid = Object.values(fieldStatus)
    .map((field) => field.confidence)
    .filter((value): value is number => value !== null);
  return valid.length
    ? Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(2))
    : 0;
}

const songModelResponse = (
  row: typeof songModelsTable.$inferSelect,
) => {
  const normalized = normalizeSongModel(row.model) as SongModelData;
  // JSONB rows written before v2 coordinates were persisted remain readable,
  // while every v2 API serialization rehydrates its authoritative axes.
  const model = normalized.contractVersion === "2.0"
    ? canonicalizeSongModelCoordinates(normalized)
    : normalized;
  const quality = normalizeSongModelQuality(model);
  const legacyProviderProvenance = Array.isArray(model.provenance)
    ? model.provenance
    : [];
  return {
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    version: row.version,
    status: row.status,
    parentModelId: row.parentModelId,
    correction: row.correction,
    ...model,
    providerProvenance: model.providerProvenance ?? legacyProviderProvenance,
    ...quality,
    providers: row.providers,
    confidence: aggregateSongModelConfidence(quality.fieldStatus),
    createdAt: iso(row.createdAt),
  };
};

/**
 * Completed models live in JSONB and older rows predate newer analysis
 * fields. Fill those fields at the API boundary without losing lineage or
 * any rich model values already persisted on the row.
 */
function normalizeSongModel(model: typeof songModelsTable.$inferSelect["model"]) {
  const legacy = model as Partial<SongModelData> & {
    audio?: Partial<SongModelData["audio"]>;
  };
  const audio: Partial<SongModelData["audio"]> = legacy.audio ?? {
    name: "",
    contentType: "application/octet-stream",
    size: 0,
    durationSeconds: 0,
    sampleRate: 0,
    channels: 0,
  };
  const durationSeconds = audio.durationSeconds ?? 0;
  const sourceStems = legacy.sourceStems ?? [];
  return {
    ...legacy,
    audio: {
      ...audio,
      proxyObjectPath: audio.proxyObjectPath ?? null,
      proxyContentType: audio.proxyContentType ?? null,
      analysisStartSeconds:
        audio.analysisStartSeconds ?? legacy.analysisStartSeconds ?? 0,
      analysisDurationSeconds:
        audio.analysisDurationSeconds ??
        legacy.analysisDurationSeconds ??
        durationSeconds,
      analysisCoverage:
        audio.analysisCoverage ??
        ((legacy.analysisCoverage ?? 1) < 1 ? "representative" : "full"),
    },
    analysisStartSeconds: legacy.analysisStartSeconds ?? 0,
    analysisDurationSeconds: legacy.analysisDurationSeconds ?? durationSeconds,
    analysisCoverage: legacy.analysisCoverage ?? 1,
    waveform: legacy.waveform ?? legacy.energy ?? [],
    stems: legacy.stems ?? sourceStems.map((stem) => ({
      name: stem.role,
      role: stem.role,
      source: stem.objectPath,
      channels: 2,
      confidence: stem.confidence,
    })),
    beats: legacy.beats ?? [],
    bars: legacy.bars ?? [],
    bass: legacy.bass ?? [],
    dynamics: legacy.dynamics ?? legacy.energy ?? [],
    sourceStems,
    vocalEvidence: legacy.vocalEvidence ?? {
      status: "not_available" as const,
      reason: "This historical Song Model has no decoded vocal or voice stem PCM evidence. Reanalyze the source to verify it.",
      provenance: null,
      sampleRate: null,
      channels: null,
      frameSizeSamples: null,
      thresholds: null,
      observedVoicedWindows: [],
      observedSilentWindows: [],
    },
    vocalIntelligence: legacy.vocalIntelligence ?? unavailableVocalIntelligence(),
    lyrics: legacy.lyrics ?? [],
    confidenceByField: legacy.confidenceByField ?? {},
    provenance: legacy.provenance ?? [],
  };
}

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

function durationSeconds(value: string): number {
  const match = /^(\d+):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 1;
}

function projectSongModelCore(
  project: typeof musicProjectsTable.$inferSelect,
  source: typeof projectSourcesTable.$inferSelect,
) {
  return {
    audio: {
      name: source.name,
      contentType: source.contentType,
      size: source.size,
      durationSeconds: source.durationSeconds ?? durationSeconds(project.duration),
      sampleRate: source.sampleRate ?? 44_100,
      channels: source.channels ?? 2,
    },
    tempoMap: [{ time: 0, bpm: project.bpm, confidence: project.confidence }],
    meterMap: [{ bar: 1, meter: project.meter, confidence: project.confidence }],
    keyMap: [{ time: 0, key: project.key, confidence: project.confidence }],
    melody: [],
    chords: [],
    sections: project.sections,
    energy: project.energy,
    beats: [],
    bars: [],
    dynamics: project.energy,
    sourceStems: [],
    lyrics: [],
    confidenceByField: {
      tempo: project.confidence,
      meter: project.confidence,
      key: project.confidence,
      structure: project.confidence,
      melody: 0,
      harmony: 0,
    },
    provenance: [{
      capability: "legacy_compatibility",
      provider: "LEGACY_ANALYZER_V1",
      version: "1.0.0",
      status: "fallback" as const,
    }],
  };
}

async function persistProjectSongModel(
  project: typeof musicProjectsTable.$inferSelect,
): Promise<typeof songModelsTable.$inferSelect> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${project.id}))`,
    );
    const [latest] = await tx
      .select()
      .from(songModelsTable)
      .where(eq(songModelsTable.projectId, project.id))
      .orderBy(desc(songModelsTable.version))
      .limit(1);
    if (latest && validateCanonicalSongModel(latest.model).success) {
      return latest;
    }

    const [existingSource] = await tx
      .select()
      .from(projectSourcesTable)
      .where(eq(projectSourcesTable.projectId, project.id))
      .limit(1);
    const source = existingSource ?? (await tx.insert(projectSourcesTable).values({
      id: randomUUID(),
      projectId: project.id,
      ownerId: project.ownerId ?? "legacy-backfill",
      objectPath: `/objects/legacy/${project.id}`,
      name: project.sourceName ?? `${project.name}.wav`,
      size: 1,
      contentType: "audio/wav",
      sourceType: project.sourceType,
      status: "ready",
      progress: 100,
      durationSeconds: durationSeconds(project.duration),
      sampleRate: 44_100,
      channels: 2,
    }).returning())[0];
    const fusion = fuseProviderSongModels([{
      provider: "LEGACY_ANALYZER_V1",
      output: projectSongModelCore(project, source),
      confidence: project.confidence,
    }]);
    if (!fusion.accepted) {
      throw new Error(
        `Project analysis failed Song Model validation. ${
          fusion.issues.map((item) => item.message).join(" ")
        }`,
      );
    }
    const [songModel] = await tx.insert(songModelsTable).values({
      id: randomUUID(),
      projectId: project.id,
      sourceId: source.id,
      version: (latest?.version ?? 0) + 1,
      status: "ready",
      model: fusion.model,
      providers: fusion.decisions.map((decision) => decision.provider),
      confidence: fusion.model.fusion.confidence,
    }).returning();
    return songModel;
  });
}

async function backfillReadySongModels(): Promise<void> {
  const projects = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.status, "ready"));
  for (const project of projects) {
    const [latest] = await db
      .select()
      .from(songModelsTable)
      .where(eq(songModelsTable.projectId, project.id))
      .orderBy(desc(songModelsTable.version))
      .limit(1);
    if (latest && validateCanonicalSongModel(latest.model).success) continue;
    if (latest && !isLegacySongModel(latest.model)) continue;
    try {
      await persistProjectSongModel(project);
    } catch {
      // Invalid legacy project summaries remain ineligible and are rejected by the generation gate.
    }
  }
}

async function ensureSeededOnce(): Promise<void> {
  const existing = await db.select({ id: musicProjectsTable.id }).from(musicProjectsTable).limit(1);
  if (existing.length === 0) {
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
  await backfillReadySongModels();
}

let ensureSeededInFlight: Promise<void> | null = null;

async function ensureSeeded(): Promise<void> {
  ensureSeededInFlight ??= ensureSeededOnce();
  try {
    await ensureSeededInFlight;
  } finally {
    ensureSeededInFlight = null;
  }
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

router.delete("/projects/:projectId", async (req, res): Promise<void> => {
  await signalProjectStorageRaceEvent(
    "project-delete-requested",
    req.params.projectId,
  );
  const cleanupJob = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${req.params.projectId}))`,
    );
    const [project] = await tx
      .select()
      .from(musicProjectsTable)
      .where(and(
        eq(musicProjectsTable.id, req.params.projectId),
        eq(musicProjectsTable.ownerId, req.user!.id),
      ))
      .limit(1);
    if (!project) return null;
    await waitForProjectStorageRaceGate("project-delete", project.id);

    const sources = await tx
      .select()
      .from(projectSourcesTable)
      .where(eq(projectSourcesTable.projectId, project.id));
    const models = await tx
      .select()
      .from(songModelsTable)
      .where(eq(songModelsTable.projectId, project.id));
    const analysisJobs = await tx
      .select()
      .from(analysisJobsTable)
      .where(eq(analysisJobsTable.projectId, project.id));
    const analysisAttempts = await tx
      .select()
      .from(analysisAttemptsTable)
      .where(eq(analysisAttemptsTable.projectId, project.id));
    const artifacts = await tx
      .select()
      .from(musicArtifactsTable)
      .where(eq(musicArtifactsTable.projectId, project.id));
    const exports = await tx
      .select()
      .from(musicExportsTable)
      .where(eq(musicExportsTable.projectId, project.id));
    const uploadReservations = await tx
      .select()
      .from(projectUploadReservationsTable)
      .where(eq(projectUploadReservationsTable.projectId, project.id));
    const objectPaths = new Set<string>();
    for (const rows of [sources, models, artifacts, exports]) {
      for (const row of rows) collectPrivateObjectPaths(row, objectPaths);
    }
    for (const source of sources) {
      const safeSourceId = source.id.replace(/[^a-zA-Z0-9_-]/g, "");
      if (safeSourceId) objectPaths.add(`/objects/proxies/${safeSourceId}.flac`);
    }
    for (const artifact of artifacts) {
      if (artifact.type === "EXPORT") {
        objectPaths.add(`/api/storage/objects/exports/${artifact.id}.zip`);
      }
    }
    const reservedUploadPaths = uploadReservations.map((reservation) => reservation.objectPath);
    for (const path of reservedUploadPaths) objectPaths.add(path);
    const analysisJobIds = new Set([
      ...analysisJobs.map((job) => job.id),
      ...analysisAttempts.map((attempt) => attempt.id),
    ]);
    const [job] = await tx.insert(projectCleanupJobsTable).values({
      id: randomUUID(),
      projectId: project.id,
      ownerId: req.user!.id,
      objectPaths: [...objectPaths],
      analysisJobIds: [...analysisJobIds],
    }).returning();

    // All project-owned relational records have a cascading project foreign key.
    // Keeping the cleanup job outside that graph lets storage retries survive this delete.
    await tx.delete(musicProjectsTable).where(and(
      eq(musicProjectsTable.id, project.id),
      eq(musicProjectsTable.ownerId, req.user!.id),
    ));
    return job;
  });
  if (!cleanupJob) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const finishedJob = await runProjectCleanup(cleanupJob.id);
  res
    .status(finishedJob.status === "completed" ? 200 : 202)
    .json(DeleteProjectResponse.parse(projectCleanupResponse(finishedJob)));
});

router.get("/project-deletions/:deletionId", async (req, res): Promise<void> => {
  const params = GetProjectDeletionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db
    .select()
    .from(projectCleanupJobsTable)
    .where(and(
      eq(projectCleanupJobsTable.id, params.data.deletionId),
      eq(projectCleanupJobsTable.ownerId, req.user!.id),
    ))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Project deletion not found" });
    return;
  }
  res.json(GetProjectDeletionResponse.parse(projectCleanupResponse(job)));
});

router.post("/project-deletions/:deletionId/retry", async (req, res): Promise<void> => {
  const params = RetryProjectDeletionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db
    .select()
    .from(projectCleanupJobsTable)
    .where(and(
      eq(projectCleanupJobsTable.id, params.data.deletionId),
      eq(projectCleanupJobsTable.ownerId, req.user!.id),
    ))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Project deletion not found" });
    return;
  }
  if (job.status === "completed") {
    res.json(RetryProjectDeletionResponse.parse(projectCleanupResponse(job)));
    return;
  }
  const finishedJob = await runProjectCleanup(job.id);
  if (finishedJob.status === "running") {
    res.status(409).json({ error: "Project cleanup is already in progress" });
    return;
  }
  res
    .status(finishedJob.status === "completed" ? 200 : 202)
    .json(RetryProjectDeletionResponse.parse(projectCleanupResponse(finishedJob)));
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

router.post("/projects/:projectId/analyze", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = AnalyzeProjectParams.safeParse(req.params);
  const body = AnalyzeProjectBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid analysis request" });
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
  if (project.ownerId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [source] = await db
    .select()
    .from(projectSourcesTable)
    .where(and(
      eq(projectSourcesTable.projectId, project.id),
      eq(projectSourcesTable.ownerId, req.user.id),
    ))
    .orderBy(desc(projectSourcesTable.createdAt))
    .limit(1);
  if (!source) {
    res.status(400).json({ error: "Import a source before analyzing the project" });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.update(projectSourcesTable)
      .set({ status: "queued", progress: 4, error: null })
      .where(eq(projectSourcesTable.id, source.id));
    await tx.update(musicProjectsTable)
      .set({ status: "analyzing", updatedAt: new Date() })
      .where(eq(musicProjectsTable.id, project.id));
  });
  const queued = await queueProjectSourceAnalysis(source.id);
  if (!queued) {
    res.status(409).json({ error: "Analysis is already running" });
    return;
  }
  const [updatedProject] = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, project.id))
    .limit(1);
  if (!updatedProject) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(AnalyzeProjectResponse.parse(analysisResponse(updatedProject)));
});

router.get("/projects/:projectId/sources", async (req, res): Promise<void> => {
  const params = ListProjectSourcesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
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
  if (project.ownerId) {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (project.ownerId !== req.user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }
  const sources = await db
    .select()
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.projectId, params.data.projectId))
    .orderBy(desc(projectSourcesTable.createdAt));
  const attempts = sources.length === 0
    ? []
    : await db.select()
      .from(analysisAttemptsTable)
      .where(inArray(
        analysisAttemptsTable.sourceId,
        sources.map((source) => source.id),
      ))
      .orderBy(desc(analysisAttemptsTable.attemptNumber));
  const attemptsBySource = new Map<string, Array<typeof analysisAttemptsTable.$inferSelect>>();
  for (const attempt of attempts) {
    const sourceAttempts = attemptsBySource.get(attempt.sourceId) ?? [];
    sourceAttempts.push(attempt);
    attemptsBySource.set(attempt.sourceId, sourceAttempts);
  }
  res.json(ListProjectSourcesResponse.parse(
    sources.map((source) => sourceResponse(source, attemptsBySource.get(source.id))),
  ));
});

router.get("/projects/:projectId/playback", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [project] = await db
    .select()
    .from(musicProjectsTable)
    .where(and(
      eq(musicProjectsTable.id, req.params.projectId),
      eq(musicProjectsTable.ownerId, req.user.id),
    ))
    .limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [source] = await db
    .select()
    .from(projectSourcesTable)
    .where(and(
      eq(projectSourcesTable.projectId, project.id),
      typeof req.query.sourceId === "string"
        ? eq(projectSourcesTable.id, req.query.sourceId)
        : sql`true`,
    ))
    .orderBy(desc(projectSourcesTable.createdAt))
    .limit(1);
  if (!source || source.status !== "ready") {
    res.status(409).json({
      code: "PLAYBACK_UNAVAILABLE",
      error: source
        ? "The source is still being analyzed. Playback will be available when analysis is ready."
        : "Import and analyze a source before starting playback.",
    });
    return;
  }
  if (source.sourceType === "MIDI" || source.contentType === "audio/midi") {
    res.status(409).json({
      code: "PLAYBACK_UNAVAILABLE",
      error: "MIDI sources do not contain browser-playable audio. Export the arrangement to audition it.",
    });
    return;
  }

  // Proxies are named by source id, so this lookup cannot drift to a different
  // upload when multiple analyses finish out of order.
  const safeSourceId = source.id.replace(/[^a-zA-Z0-9_-]/g, "");
  const proxyPath = safeSourceId ? `proxies/${safeSourceId}.flac` : null;
  const proxyFile = proxyPath ? await getPrivateObject(proxyPath) : null;
  const file = proxyFile
    ?? await getPrivateObject(source.objectPath.slice("/objects/".length));
  if (!file) {
    res.status(404).json({ error: "The source audio is no longer available." });
    return;
  }
  const [metadata] = await file.getMetadata();
  const totalBytes = Number(metadata.size ?? 0);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    res.status(404).json({ error: "The source audio has no playable content." });
    return;
  }
  const contentType = proxyFile ? "audio/flac" : source.contentType;
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = totalBytes - 1;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) {
      res.status(416).setHeader("Content-Range", `bytes */${totalBytes}`).end();
      return;
    }
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : totalBytes - 1;
    } else {
      const suffixLength = Number(match[2]);
      start = Math.max(0, totalBytes - suffixLength);
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= totalBytes
    ) {
      res.status(416).setHeader("Content-Range", `bytes */${totalBytes}`).end();
      return;
    }
    end = Math.min(end, totalBytes - 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${totalBytes}`);
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType || "application/octet-stream");
  res.setHeader("Content-Length", String(end - start + 1));
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, no-store");
  file.createReadStream(rangeHeader ? { start, end } : undefined)
    .on("error", (error) => {
      req.log.error({ err: error, projectId: project.id }, "Failed to stream playback audio");
      if (!res.headersSent) res.status(500).end();
      else res.destroy(error);
    })
    .pipe(res);
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
  const sourceTypeMatchesFormat =
    (sourceFormat.mediaKind === "midi" && body.data.sourceType === "MIDI") ||
    (sourceFormat.mediaKind === "video" && body.data.sourceType === "VIDEO") ||
    (sourceFormat.mediaKind === "audio" &&
      ["FULL_SONG", "VOCAL_ONLY", "SOLO_INSTRUMENT", "INSTRUMENTAL"]
        .includes(body.data.sourceType));
  if (!sourceTypeMatchesFormat) {
    res.status(400).json({
      error: `Source type ${body.data.sourceType} does not match the uploaded ${sourceFormat.mediaKind} file`,
    });
    return;
  }
  if (!isSourceObjectPath(body.data.objectPath)) {
    res.status(400).json({ error: "Invalid uploaded object path" });
    return;
  }
  const [uploadReservation] = await db
    .select({ objectPath: projectUploadReservationsTable.objectPath })
    .from(projectUploadReservationsTable)
    .where(and(
      eq(projectUploadReservationsTable.objectPath, body.data.objectPath),
      eq(projectUploadReservationsTable.projectId, project.id),
      eq(projectUploadReservationsTable.ownerId, req.user.id),
    ))
    .limit(1);
  if (!uploadReservation) {
    res.status(400).json({ error: "Upload reservation not found or expired" });
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
  await db.delete(projectUploadReservationsTable).where(and(
    eq(projectUploadReservationsTable.objectPath, body.data.objectPath),
    eq(projectUploadReservationsTable.projectId, project.id),
    eq(projectUploadReservationsTable.ownerId, req.user.id),
  ));
  await db.update(musicProjectsTable)
    .set({
      ownerId: project.ownerId ?? req.user.id,
      status: "analyzing",
      updatedAt: new Date(),
    })
    .where(eq(musicProjectsTable.id, project.id));
  await queueProjectSourceAnalysis(source.id);
  const [freshSource] = await db
    .select()
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.id, source.id))
    .limit(1);
  const attempts = await db
    .select()
    .from(analysisAttemptsTable)
    .where(eq(analysisAttemptsTable.sourceId, source.id))
    .orderBy(desc(analysisAttemptsTable.attemptNumber));
  res.status(202).json(RegisterProjectSourceResponse.parse(
    sourceResponse(freshSource ?? source, attempts),
  ));
});

router.post("/projects/:projectId/sources/:sourceId/retry", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = RetryProjectSourceAnalysisParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { projectId, sourceId } = params.data;
  const [source] = await db
    .select()
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.id, sourceId))
    .limit(1);
  if (!source || source.projectId !== projectId) {
    res.status(404).json({ error: "Source not found" });
    return;
  }
  const [project] = await db
    .select({ ownerId: musicProjectsTable.ownerId })
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, projectId))
    .limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (source.ownerId !== req.user.id || (project.ownerId && project.ownerId !== req.user.id)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (source.status !== "failed") {
    res.status(409).json({ error: "Source analysis is not failed or is already in progress" });
    return;
  }

  const queued = await db.transaction(async (tx) => {
    const now = new Date();
    const [updatedSource] = await tx.update(projectSourcesTable)
      .set({ status: "queued", progress: 4, error: null, updatedAt: now })
      .where(and(
        eq(projectSourcesTable.id, source.id),
        eq(projectSourcesTable.status, "failed"),
      ))
      .returning({ id: projectSourcesTable.id });
    if (!updatedSource) return false;
    await tx.update(musicProjectsTable)
      .set({ status: "analyzing", updatedAt: now })
      .where(eq(musicProjectsTable.id, projectId));
    return true;
  });
  if (!queued) {
    res.status(409).json({ error: "Source analysis is already in progress" });
    return;
  }
  await queueProjectSourceAnalysis(source.id);
  const [freshSource] = await db
    .select()
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.id, source.id))
    .limit(1);
  const attempts = await db
    .select()
    .from(analysisAttemptsTable)
    .where(eq(analysisAttemptsTable.sourceId, source.id))
    .orderBy(desc(analysisAttemptsTable.attemptNumber));
  res.status(202).json(RetryProjectSourceAnalysisResponse.parse(
    sourceResponse(freshSource ?? source, attempts),
  ));
});

router.get("/projects/:projectId/song-model", async (req, res): Promise<void> => {
  const params = GetProjectSongModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
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
  if (project.ownerId) {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (project.ownerId !== req.user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
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
    const isEstablishingMissingSections = latest.model.sections.length === 0;
    if (
      !isEstablishingMissingSections &&
      correction.sections.length !== latest.model.sections.length
    ) {
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

  const sectionsChanged = correction.sections !== undefined &&
    JSON.stringify(correction.sections.map(({ name, startBar, endBar }) => ({
      name,
      startBar,
      endBar,
    }))) !== JSON.stringify(latest.model.sections.map(({ name, startBar, endBar }) => ({
      name,
      startBar,
      endBar,
    })));
  const hasCorrection = (
    (correction.bpm !== undefined && correction.bpm !== latest.model.tempoMap[0]?.bpm) ||
    (correction.key !== undefined && correction.key !== latest.model.keyMap[0]?.key) ||
    (correction.meter !== undefined && correction.meter !== latest.model.meterMap[0]?.meter) ||
    sectionsChanged
  );
  if (!hasCorrection) {
    res.status(400).json({ error: "Song Model corrections must change at least one value" });
    return;
  }
  const fields = (["bpm", "key", "meter", "sections"] as const)
    .filter((field) =>
      field === "bpm" ? correction.bpm !== undefined && correction.bpm !== latest.model.tempoMap[0]?.bpm :
      field === "key" ? correction.key !== undefined && correction.key !== latest.model.keyMap[0]?.key :
      field === "meter" ? correction.meter !== undefined && correction.meter !== latest.model.meterMap[0]?.meter :
      sectionsChanged,
    );
  const now = new Date();
  const existingTempo = latest.model.tempoMap[0];
  const existingKey = latest.model.keyMap[0];
  const existingMeter = latest.model.meterMap[0];
  const measuredAverageEnergy = latest.model.energy.length
    ? latest.model.energy.reduce((sum, value) => sum + value, 0) /
      latest.model.energy.length
    : 0;
  const editedFieldStatus = {
    ...latest.model.fieldStatus,
    ...(!fields.includes("bpm")
      ? {}
      : {
          tempo: {
            ...latest.model.fieldStatus?.tempo,
            status: "detected" as const,
            confidence: latest.model.fieldStatus?.tempo?.confidence ?? null,
            providers: latest.model.fieldStatus?.tempo?.providers ?? [],
            message: "User-edited value; detected provider output remains in provenance.",
            edited: true,
          },
        }),
    ...(!fields.includes("key")
      ? {}
      : {
          key: {
            ...latest.model.fieldStatus?.key,
            status: "detected" as const,
            confidence: latest.model.fieldStatus?.key?.confidence ?? null,
            providers: latest.model.fieldStatus?.key?.providers ?? [],
            message: "User-edited value; detected provider output remains in provenance.",
            edited: true,
          },
        }),
    ...(!fields.includes("meter")
      ? {}
      : {
          meter: {
            ...latest.model.fieldStatus?.meter,
            status: "detected" as const,
            confidence: latest.model.fieldStatus?.meter?.confidence ?? null,
            providers: latest.model.fieldStatus?.meter?.providers ?? [],
            message: "User-edited value; detected provider output remains in provenance.",
            edited: true,
          },
        }),
    ...(!fields.includes("sections")
      ? {}
      : {
          sections: {
            ...latest.model.fieldStatus?.sections,
            status: "detected" as const,
            confidence: latest.model.fieldStatus?.sections?.confidence ?? null,
            providers: latest.model.fieldStatus?.sections?.providers ?? [],
            message: "User-edited value; detected provider output remains in provenance.",
            edited: true,
          },
        }),
  };
  const correctedModelDraft: SongModelData = {
    ...latest.model,
    fieldStatus: editedFieldStatus,
    ...(!fields.includes("bpm")
      ? {}
      : {
          tempoMap: [
            {
              time: existingTempo?.time ?? 0,
              bpm: correction.bpm!,
              confidence: existingTempo?.confidence
                ?? latest.model.confidenceByField.tempo
                ?? latest.confidence,
            },
            ...latest.model.tempoMap.slice(1),
          ],
        }),
    ...(!fields.includes("key")
      ? {}
      : {
          keyMap: [
            {
              time: existingKey?.time ?? 0,
              key: correction.key!,
              confidence: existingKey?.confidence
                ?? latest.model.confidenceByField.key
                ?? latest.confidence,
            },
            ...latest.model.keyMap.slice(1),
          ],
        }),
    ...(!fields.includes("meter")
      ? {}
      : {
          meterMap: [
            {
              bar: existingMeter?.bar ?? 1,
              meter: correction.meter!,
              confidence: existingMeter?.confidence
                ?? latest.model.confidenceByField.meter
                ?? latest.confidence,
            },
            ...latest.model.meterMap.slice(1),
          ],
        }),
    ...(!fields.includes("sections")
      ? {}
      : {
          sections: correction.sections!.map((section, index) => ({
            ...section,
             energy: latest.model.sections[index]?.energy ?? measuredAverageEnergy,
          })),
        }),
  };
  const correctedModel = refreshSongModelValidation(
    correctedModelDraft.contractVersion === "2.0"
      ? canonicalizeSongModelCoordinates(correctedModelDraft)
      : correctedModelDraft,
  );
  const correctedValidation = validateCanonicalSongModel(correctedModel);
  if (!correctedValidation.success) {
    res.status(400).json({
      error: "The correction produced an invalid Song Model timeline.",
      issues: correctedValidation.issues,
    });
    return;
  }

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
        ...(!fields.includes("bpm") ? {} : { bpm: correction.bpm! }),
        ...(!fields.includes("key") ? {} : { key: correction.key! }),
        ...(!fields.includes("meter") ? {} : { meter: correction.meter! }),
        ...(!fields.includes("sections") ? {} : { sections: correctedModel.sections }),
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
  const [project] = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, params.data.projectId))
    .limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.ownerId) {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (project.ownerId !== req.user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }
  const jobs = await db
    .select()
    .from(analysisJobsTable)
    .where(eq(analysisJobsTable.projectId, params.data.projectId))
    .orderBy(desc(analysisJobsTable.createdAt));
  res.json(ListAnalysisJobsResponse.parse(jobs.map(analysisJobResponse)));
});

router.get("/providers", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(ListMusicProvidersResponse.parse(
    await verifiedProviderDescriptorCatalog(),
  ));
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
  const arrangement = await db.transaction(async (tx) => {
    const [created] = await tx.insert(arrangementsTable).values({
      id: randomUUID(),
      projectId: params.data.projectId,
      name: body.data.name,
      style: body.data.style,
      mode: body.data.mode,
      version: existing.length + 1,
      harmonyComplexity: body.data.harmonyComplexity,
      sections: [],
    }).returning();
    const snapshot = arrangementRevisionSnapshot(created);
    await tx.insert(arrangementRevisionsTable).values({
      id: randomUUID(),
      arrangementId: created.id,
      version: created.version,
      snapshot,
      summary: revisionSummary(null, snapshot),
    });
    return created;
  });
  res.status(201).json(CreateArrangementResponse.parse(arrangementResponse(arrangement)));
});

router.patch("/arrangements/:arrangementId", async (req, res): Promise<void> => {
  const params = UpdateArrangementParams.safeParse(req.params);
  const body = UpdateArrangementBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid arrangement update" });
    return;
  }
  const [ownedArrangement] = await db
    .select({
      projectId: arrangementsTable.projectId,
      meter: musicProjectsTable.meter,
    })
    .from(arrangementsTable)
    .innerJoin(
      musicProjectsTable,
      eq(musicProjectsTable.id, arrangementsTable.projectId),
    )
    .where(and(
      eq(arrangementsTable.id, params.data.arrangementId),
      eq(musicProjectsTable.ownerId, req.user!.id),
    ))
    .limit(1);
  if (!ownedArrangement) {
    res.status(404).json({ error: "Arrangement not found" });
    return;
  }
  if (body.data.selectedCandidateId) {
    const [existing] = await db
      .select({ candidates: arrangementsTable.candidates })
      .from(arrangementsTable)
      .where(and(
        eq(arrangementsTable.id, params.data.arrangementId),
        eq(arrangementsTable.projectId, ownedArrangement.projectId),
      ))
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
  const { expectedVersion, ...updateData } = body.data;
  if (expectedVersion === undefined) {
    res.status(400).json({ error: "expectedVersion is required for arrangement edits" });
    return;
  }
  if (updateData.sections) {
    const beatsPerBar = Number.parseInt(ownedArrangement.meter, 10) || 4;
    let previousEnd = 0;
    for (const section of updateData.sections) {
      if (
        !Number.isInteger(section.startBar) ||
        !Number.isInteger(section.endBar) ||
        section.startBar! < 1 ||
        section.endBar! < section.startBar! ||
        section.startBar! <= previousEnd
      ) {
        res.status(400).json({ error: "Arrangement sections must have ordered, non-overlapping bar ranges" });
        return;
      }
      previousEnd = section.endBar!;
      if (
        section.chords?.some((chord) =>
          !Number.isFinite(chord.startBeat) ||
          chord.startBeat < 0 ||
          !Number.isFinite(chord.durationBeats) ||
          chord.durationBeats <= 0 ||
          chord.startBeat + chord.durationBeats > (section.endBar! - section.startBar! + 1) * beatsPerBar
        )
      ) {
        res.status(400).json({ error: "Chord events must stay inside their section and have a positive duration" });
        return;
      }
      if (
        section.markers?.some((marker) =>
          marker.bar < section.startBar! || marker.bar > section.endBar!
        ) ||
        section.automation?.some((point) =>
          point.bar < section.startBar! || point.bar > section.endBar!
        )
      ) {
        res.status(400).json({ error: "Markers and automation points must stay inside their section" });
        return;
      }
      if (
        section.midiTracks &&
        Object.values(section.midiTracks).some((editor) =>
          editor.notes.some((note) =>
            note.pitch < 0 ||
            note.pitch > 127 ||
            note.start < 0 ||
            note.duration <= 0 ||
            note.start + note.duration > (section.endBar! - section.startBar! + 1) * beatsPerBar ||
            note.velocity < 1 ||
            note.velocity > 127
          ) ||
          editor.cc.some((value) => value < 0 || value > 127)
        )
      ) {
        res.status(400).json({ error: "MIDI notes and CC values are outside supported ranges" });
        return;
      }
    }
  }
  const updates = {
    ...updateData,
    version: sql<number>`${arrangementsTable.version} + 1`,
  };
  const where = and(
    eq(arrangementsTable.id, params.data.arrangementId),
    eq(arrangementsTable.projectId, ownedArrangement.projectId),
    eq(arrangementsTable.version, expectedVersion),
  );
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${params.data.arrangementId}))`,
    );
    const [before] = await tx
      .select()
      .from(arrangementsTable)
      .where(and(
        eq(arrangementsTable.id, params.data.arrangementId),
        eq(arrangementsTable.projectId, ownedArrangement.projectId),
      ))
      .limit(1);
    if (!before) return { kind: "not-found" as const };
    const [arrangement] = await tx
      .update(arrangementsTable)
      .set(updates)
      .where(where)
      .returning();
    if (!arrangement) return { kind: "conflict" as const };
    const snapshot = arrangementRevisionSnapshot(arrangement);
    await tx.insert(arrangementRevisionsTable).values({
      id: randomUUID(),
      arrangementId: arrangement.id,
      version: arrangement.version,
      snapshot,
      summary: revisionSummary(arrangementRevisionSnapshot(before), snapshot),
    });
    const performanceEdit = sectionsHavePerformanceChanges(
      before.sections,
      arrangement.sections,
    );
    await appendProducerDecisionTx(tx, {
      ownerId: req.user!.id,
      projectId: arrangement.projectId,
      domain: performanceEdit ? "performance" : "arrangement",
      kind: "edit",
      source: "inferred_behavior",
      context: {
        subjectId: arrangement.id,
        modelVersion: arrangement.modelVersion,
        evidenceSha256: sha256(`${arrangement.id}:${arrangement.version}`),
      },
    });
    return { kind: "updated" as const, arrangement };
  });
  const arrangement = result.kind === "updated" ? result.arrangement : null;
  if (!arrangement) {
    res.status(result.kind === "conflict" ? 409 : 404).json({
      error: result.kind === "conflict"
        ? "Arrangement changed while this local edit was saving. Reload the latest version and try again."
        : "Arrangement not found",
    });
    return;
  }
  res.json(UpdateArrangementResponse.parse(arrangementResponse(arrangement)));
});

router.get("/arrangements/:arrangementId/revisions", async (req, res): Promise<void> => {
  const params = ListArrangementRevisionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [arrangement] = await db
    .select()
    .from(arrangementsTable)
    .where(eq(arrangementsTable.id, params.data.arrangementId))
    .limit(1);
  if (!arrangement) {
    res.status(404).json({ error: "Arrangement not found" });
    return;
  }
  await ensureCurrentArrangementRevision(arrangement);
  const revisions = await db
    .select()
    .from(arrangementRevisionsTable)
    .where(eq(arrangementRevisionsTable.arrangementId, arrangement.id))
    .orderBy(desc(arrangementRevisionsTable.version));
  res.json(ListArrangementRevisionsResponse.parse(
    revisions.map(arrangementRevisionResponse),
  ));
});

router.post(
  "/arrangements/:arrangementId/revisions/:revisionId/restore",
  async (req, res): Promise<void> => {
    const params = RestoreArrangementRevisionParams.safeParse(req.params);
    const body = RestoreArrangementRevisionBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid arrangement restore request" });
      return;
    }
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${params.data.arrangementId}))`,
      );
      const [revision] = await tx
        .select()
        .from(arrangementRevisionsTable)
        .where(and(
          eq(arrangementRevisionsTable.id, params.data.revisionId),
          eq(arrangementRevisionsTable.arrangementId, params.data.arrangementId),
        ))
        .limit(1);
      if (!revision) return { kind: "not-found" as const };
      const [current] = await tx
        .select()
        .from(arrangementsTable)
        .where(eq(arrangementsTable.id, params.data.arrangementId))
        .limit(1);
      if (!current) return { kind: "not-found" as const };
      const [restored] = await tx
        .update(arrangementsTable)
        .set({
          ...revision.snapshot,
          selectedCandidateId: revision.snapshot.selectedCandidateId ?? null,
          version: sql<number>`${arrangementsTable.version} + 1`,
        })
        .where(and(
          eq(arrangementsTable.id, params.data.arrangementId),
          eq(arrangementsTable.version, body.data.expectedVersion),
        ))
        .returning();
      if (!restored) return { kind: "conflict" as const };
      const snapshot = arrangementRevisionSnapshot(restored);
      await tx.insert(arrangementRevisionsTable).values({
        id: randomUUID(),
        arrangementId: restored.id,
        version: restored.version,
        snapshot,
        summary: revisionSummary(arrangementRevisionSnapshot(current), snapshot),
      });
      await appendProducerDecisionTx(tx, {
        ownerId: req.user!.id, projectId: restored.projectId, domain: "arrangement",
        kind: "restore", source: "inferred_behavior",
        context: { subjectId: restored.id, modelVersion: restored.modelVersion,
          lineageIds: [params.data.revisionId] },
        evidence: { version: restored.version },
      });
      return { kind: "restored" as const, arrangement: restored };
    });
    if (result.kind === "not-found") {
      res.status(404).json({ error: "Arrangement revision not found" });
      return;
    }
    if (result.kind === "conflict") {
      res.status(409).json({
        error: "Arrangement changed while this revision was being restored. Review the latest version and try again.",
      });
      return;
    }
    res.json(RestoreArrangementRevisionResponse.parse(
      arrangementResponse(result.arrangement),
    ));
  },
);

router.post("/arrangements/:arrangementId/generate", async (req, res): Promise<void> => {
  await ensureSeeded();
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
    res.status(422).json({
      error: "Arrangement generation is blocked because this project has no completed Song Model.",
      code: "SONG_MODEL_MISSING",
      action: "Upload a source and wait for analysis to complete before generating an arrangement.",
      issues: [],
    });
    return;
  }
  const eligibility = evaluateArrangementEligibility(
    songModel.model,
    songModel.status,
    songModel.confidence,
  );
  if (!eligibility.eligible) {
    res.status(422).json({
      error: eligibility.message,
      code: eligibility.code,
      action: eligibility.action,
      issues: eligibility.issues,
    });
    return;
  }
  try {
    const job = await queueArrangementGeneration(
      params.data.arrangementId,
      body.data,
      req.user!.id,
    );
    if (!job) {
      res.status(404).json({ error: "Arrangement not found" });
      return;
    }
    res
      .status(202)
      .json(GenerateArrangementResponse.parse(generationJobResponse(job)));
  } catch (error) {
    res.status(503).json({
      error:
        error instanceof Error
          ? error.message
          : "No compatible music provider is available",
    });
  }
});

router.get("/generation-jobs/:jobId", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = GetGenerationJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const job = await getGenerationJobForOwner(params.data.jobId, req.user.id);
  if (!job) {
    res.status(404).json({ error: "Generation job not found" });
    return;
  }
  res.json(GetGenerationJobResponse.parse(generationJobResponse(job)));
});

router.post("/generation-jobs/:jobId/cancel", async (req, res): Promise<void> => {
  const params = CancelGenerationJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const current = await getGenerationJobForOwner(params.data.jobId, req.user!.id);
  if (!current) {
    res.status(404).json({ error: "Generation job not found" });
    return;
  }
  if (["succeeded", "failed", "cancelled"].includes(current.status)) {
    res.status(409).json({
      error: `Generation job is already ${current.status}`,
      code: "JOB_ALREADY_TERMINAL",
      retryable: false,
    });
    return;
  }
  const job = await cancelGenerationJob(params.data.jobId, req.user!.id);
  if (!job) {
    res.status(409).json({ error: "Generation job changed before cancellation" });
    return;
  }
  res.json(CancelGenerationJobResponse.parse(generationJobResponse(job)));
});

router.post("/generation-jobs/:jobId/retry", async (req, res): Promise<void> => {
  const params = RetryGenerationJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const current = await getGenerationJobForOwner(params.data.jobId, req.user!.id);
  if (!current) {
    res.status(404).json({ error: "Generation job not found" });
    return;
  }
  const job = await retryGenerationJob(params.data.jobId, req.user!.id);
  if (!job) {
    res.status(409).json({
      error: "Generation job is not retryable or has exhausted its attempts",
      code: "JOB_NOT_RETRYABLE",
      retryable: false,
    });
    return;
  }
  res.status(202).json(
    RetryGenerationJobResponse.parse(generationJobResponse(job)),
  );
});

router.get(
  "/generation-jobs/:jobId/candidates",
  async (req, res): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = ListGenerationCandidatesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const candidates = await listGenerationCandidatesForOwner(
      params.data.jobId,
      req.user.id,
    );
    if (!candidates) {
      res.status(404).json({ error: "Generation job not found" });
      return;
    }
    res.json(
      ListGenerationCandidatesResponse.parse(
        candidates.map(generationCandidateResponse),
      ),
    );
  },
);

router.post(
  "/generation-candidates/:candidateId/repair",
  async (req, res): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = RepairGenerationCandidateParams.safeParse(req.params);
    const body = RepairGenerationCandidateBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: !params.success ? params.error.message : body.success
          ? "Invalid repair request"
          : body.error.message,
      });
      return;
    }
    try {
      const job = await queueCandidateRepair(
        params.data.candidateId,
        body.data.findingId,
        body.data.finding,
        req.user.id,
        body.data.idempotencyKey,
      );
      if (!job) {
        res.status(404).json({ error: "Validated source candidate not found" });
        return;
      }
      res.status(202).json(
        RepairGenerationCandidateResponse.parse(generationJobResponse(job)),
      );
    } catch (error) {
      res.status(422).json({
        error: error instanceof Error ? error.message : "Repair request is invalid",
      });
    }
  },
);

router.post(
  "/generation-candidates/:candidateId/select",
  async (req, res): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = SelectGenerationCandidateParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const arrangement = await selectGenerationCandidate(
      params.data.candidateId,
      req.user.id,
    );
    if (!arrangement) {
      res.status(404).json({ error: "Validated candidate not found" });
      return;
    }
    res.json(
      SelectGenerationCandidateResponse.parse(
        arrangementResponse(arrangement),
      ),
    );
  },
);

router.get("/producer-decisions", async (req, res): Promise<void> => {
  const query = ListProducerDecisionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.projectId) {
    const [project] = await db.select({ id: musicProjectsTable.id }).from(musicProjectsTable)
      .where(and(eq(musicProjectsTable.id, query.data.projectId), eq(musicProjectsTable.ownerId, req.user!.id))).limit(1);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(ListProducerDecisionsResponse.parse(await listProducerDecisions(req.user!.id, query.data.projectId, query.data.limit)));
});

router.post("/producer-decisions", async (req, res): Promise<void> => {
  const body = CreateProducerDecisionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [project] = await db.select({ id: musicProjectsTable.id }).from(musicProjectsTable)
    .where(and(eq(musicProjectsTable.id, body.data.projectId), eq(musicProjectsTable.ownerId, req.user!.id))).limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  let context: Parameters<typeof appendProducerDecision>[0]["context"] = {
    subjectId: body.data.subjectId ?? null, comparedSubjectId: body.data.comparedSubjectId ?? null,
  };
  if (body.data.subjectId) {
    const subjectId = body.data.subjectId;
    const [candidate] = await db.select().from(musicGenerationCandidatesTable).where(and(
      eq(musicGenerationCandidatesTable.id, subjectId), eq(musicGenerationCandidatesTable.projectId, body.data.projectId),
    )).limit(1);
    if (candidate) {
      const features = deployedCalibrationFeatures(candidate.evaluation);
      context = { ...context, modelVersion: candidate.modelVersion,
        evidenceIds: candidate.evaluation.renderArtifactIds, lineageIds: candidate.parentArtifactIds,
        rankingScore: features.rankingScore, criticScore: features.criticScore,
        evidenceSha256: createHash("sha256").update(JSON.stringify(candidate.evaluation.renderArtifactIds)).digest("hex") };
    } else {
      const [arrangement] = await db.select().from(arrangementsTable).where(and(eq(arrangementsTable.id, subjectId), eq(arrangementsTable.projectId, body.data.projectId))).limit(1);
      const [mix] = arrangement ? [] : await db.select().from(mixMasterRevisionsTable).where(and(eq(mixMasterRevisionsTable.id, subjectId), eq(mixMasterRevisionsTable.projectId, body.data.projectId))).limit(1);
      if (arrangement) context = { ...context, modelVersion: arrangement.modelVersion, lineageIds: arrangement.sourceCandidateId ? [arrangement.sourceCandidateId] : [], evidenceSha256: sha256(`${arrangement.id}:${arrangement.version}`) };
      else if (mix) context = { ...context, evidenceIds: mix.evidence.artifactIds, lineageIds: [mix.arrangementId], evidenceSha256: mix.evidence.timelineSha256 };
      else { res.status(400).json({ error: "subjectId must be a candidate, arrangement, or mix/master revision in this project" }); return; }
    }
  }
  if (body.data.comparedSubjectId) {
    const [compared] = await db.select({ id: musicGenerationCandidatesTable.id })
      .from(musicGenerationCandidatesTable).where(and(
        eq(musicGenerationCandidatesTable.id, body.data.comparedSubjectId),
        eq(musicGenerationCandidatesTable.projectId, body.data.projectId),
      )).limit(1);
    if (!compared) {
      res.status(400).json({ error: "comparedSubjectId must be a candidate in this project" });
      return;
    }
  }
  const decision = await appendProducerDecision({
    ownerId: req.user!.id, projectId: body.data.projectId, domain: body.data.domain,
    kind: body.data.kind, source: "explicit_feedback", rating: body.data.rating ?? null,
    reasons: body.data.reasons ?? [], context,
  });
  if (!decision) {
    res.status(409).json({ error: "Producer learning is disabled" });
    return;
  }
  res.status(201).json(CreateProducerDecisionResponse.parse(producerDecisionResponse(decision)));
});

router.get("/producer-preferences", async (req, res): Promise<void> => {
  const preferences = await preferencesForOwner(req.user!.id);
  res.setHeader("Cache-Control", "no-store");
  res.json(GetProducerPreferencesResponse.parse({
    learningEnabled: preferences.learningEnabled,
    inferredBehaviorEnabled: preferences.inferredBehaviorEnabled,
    updatedAt: preferences.updatedAt.toISOString(),
  }));
});

router.put("/producer-preferences", async (req, res): Promise<void> => {
  const body = UpdateProducerPreferencesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const preferences = await updatePreferences(req.user!.id, body.data);
  res.json(UpdateProducerPreferencesResponse.parse({
    learningEnabled: preferences.learningEnabled,
    inferredBehaviorEnabled: preferences.inferredBehaviorEnabled,
    updatedAt: preferences.updatedAt.toISOString(),
  }));
});

router.get("/producer-calibrations", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(ListProducerCalibrationsResponse.parse((await listCalibrations(req.user!.id)).map((row) => ({
    ...row, createdAt: row.createdAt.toISOString(),
  }))));
});
router.post("/producer-calibrations/evaluate", async (req, res): Promise<void> => {
  const body = EvaluateProducerCalibrationBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  try {
    res.json(EvaluateProducerCalibrationResponse.parse(await evaluateCalibration(req.user!.id, body.data.rankingWeight, body.data.criticWeight)));
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid calibration" }); }
});
router.post("/producer-calibrations", async (req, res): Promise<void> => {
  const body = PromoteProducerCalibrationBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  try {
    const row = await promoteCalibration(req.user!.id, body.data.rankingWeight, body.data.criticWeight);
    res.status(201).json(PromoteProducerCalibrationResponse.parse({ ...row, active: true, createdAt: row.createdAt.toISOString() }));
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Calibration promotion rejected" }); }
});
router.post("/producer-calibrations/:calibrationId/rollback", async (req, res): Promise<void> => {
  const params = RollbackProducerCalibrationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const row = await rollbackCalibration(req.user!.id, params.data.calibrationId);
  if (!row) { res.status(404).json({ error: "Calibration not found" }); return; }
  res.json(RollbackProducerCalibrationResponse.parse({ ...row, active: true, createdAt: row.createdAt.toISOString() }));
});

router.get("/music-providers", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(ListGenerationProvidersResponse.parse(await listProviderCatalog()));
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

router.get("/production-jobs/:jobId", async (req, res): Promise<void> => {
  const [job] = await db.select().from(productionJobsTable).where(and(
    eq(productionJobsTable.id, req.params.jobId),
    eq(productionJobsTable.ownerId, req.user!.id),
  )).limit(1);
  if (!job) {
    res.status(404).json({ error: "Production job not found" });
    return;
  }
  res.json(productionJobResponse(job));
});

router.post("/production-jobs/:jobId/cancel", async (req, res): Promise<void> => {
  const result = await requestProductionJobCancellation(req.params.jobId, req.user!.id);
  if (result === "not_found") {
    res.status(404).json({ error: "Production job not found" });
    return;
  }
  const [job] = await db.select().from(productionJobsTable).where(and(
    eq(productionJobsTable.id, req.params.jobId), eq(productionJobsTable.ownerId, req.user!.id),
  )).limit(1);
  if (!job) {
    res.status(404).json({ error: "Production job not found" });
    return;
  }
  res.status(result === "terminal" ? 409 : 202).json(productionJobResponse(job));
});

router.post("/production-jobs/:jobId/retry", async (req, res): Promise<void> => {
  const job = await retryProductionJob(req.params.jobId, req.user!.id);
  if (!job) {
    const [existing] = await db.select({ id: productionJobsTable.id }).from(productionJobsTable).where(and(
      eq(productionJobsTable.id, req.params.jobId), eq(productionJobsTable.ownerId, req.user!.id),
    )).limit(1);
    res.status(existing ? 409 : 404).json({ error: existing
      ? "Production job is not retryable or has exhausted its attempts"
      : "Production job not found" });
    return;
  }
  if (job.kind === "export") void runExportProductionJob(job.id);
  res.status(202).json(productionJobResponse(job));
});

router.get("/projects/:projectId/mix-master-revisions", async (req, res): Promise<void> => {
  const params = ListMixMasterRevisionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [ownedProject] = await db.select({ id: musicProjectsTable.id })
    .from(musicProjectsTable)
    .where(and(
      eq(musicProjectsTable.id, params.data.projectId),
      eq(musicProjectsTable.ownerId, req.user!.id),
    ))
    .limit(1);
  if (!ownedProject) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const rows = await db.select({
    revision: mixMasterRevisionsTable,
    url: musicArtifactsTable.url,
  }).from(mixMasterRevisionsTable)
    .innerJoin(musicArtifactsTable, eq(musicArtifactsTable.id, mixMasterRevisionsTable.previewArtifactId))
    .where(eq(mixMasterRevisionsTable.projectId, params.data.projectId))
    .orderBy(desc(mixMasterRevisionsTable.version));
  res.json(ListMixMasterRevisionsResponse.parse(rows.map(({ revision, url }) =>
    mixMasterRevisionResponse(revision, url ?? ""))));
});

router.post("/projects/:projectId/mix-master-revisions", async (req, res): Promise<void> => {
  const params = CreateMixMasterRevisionParams.safeParse(req.params);
  const body = CreateMixMasterRevisionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid mix/master revision request" });
    return;
  }
  const [arrangementRows, projectRows, songModelRows, tracks, parentArtifacts] = await Promise.all([
    db.select().from(arrangementsTable).where(and(eq(arrangementsTable.id, body.data.arrangementId), eq(arrangementsTable.projectId, params.data.projectId))).limit(1),
    db.select().from(musicProjectsTable).where(and(
      eq(musicProjectsTable.id, params.data.projectId),
      eq(musicProjectsTable.ownerId, req.user!.id),
    )).limit(1),
    db.select().from(songModelsTable).where(eq(songModelsTable.projectId, params.data.projectId)),
    db.select().from(tracksTable).where(eq(tracksTable.projectId, params.data.projectId)),
    db.select().from(musicArtifactsTable).where(eq(musicArtifactsTable.projectId, params.data.projectId)),
  ]);
  const arrangement = arrangementRows[0];
  const project = projectRows[0];
  const songModel = arrangement
    ? songModelRows.find((model) => model.version === arrangement.songModelVersion)
    : undefined;
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!arrangement || !songModel || !arrangement.plan || !arrangement.styleSpec || !arrangement.trackModels.length) {
    res.status(409).json({ error: "A persisted arrangement, Song Model, plan, style, and TrackModels are required to audition a revision" });
    return;
  }
  const unknownTrack = Object.keys(body.data.tracks).find((id) => !tracks.some((track) => track.id === id));
  if (unknownTrack) {
    res.status(400).json({ error: `Mix controls reference unknown track ${unknownTrack}` });
    return;
  }
  const missingTrack = tracks.find((track) => !body.data.tracks[track.id]);
  if (missingTrack) {
    res.status(400).json({ error: `Mix controls are required for track ${missingTrack.id}` });
    return;
  }
  const controls: MixMasterControls = { tracks: body.data.tracks, master: body.data.master };
  const renderTracks = tracks.map((track) => ({
    ...track,
    volume: controls.tracks[track.id]?.levelDb ?? track.volume,
  }));
  const timelineSha256 = canonicalPerformanceTimelineSha256(songModel.model);
  const parentIds = parentArtifacts.filter((artifact) =>
    (artifact.type === "TRACK_MODEL" && artifact.storageUri?.startsWith(`db://music_arrangements/${arrangement.id}/tracks/`)) ||
    (artifact.type === "ARRANGEMENT_PLAN" && artifact.storageUri === `db://music_arrangements/${arrangement.id}`),
  ).map((artifact) => artifact.id);
  if (!parentIds.length) {
    res.status(409).json({ error: "Arrangement artifact lineage is unavailable" });
    return;
  }
  const files = await renderArrangementExport({
    projectName: project.name, bpm: project.bpm, key: project.key, meter: project.meter,
    arrangementName: arrangement.name, arrangementVersion: arrangement.version,
    masterProfile: "STREAMING", energy: arrangement.energy, density: arrangement.density,
    harmonyComplexity: arrangement.harmonyComplexity, sections: arrangement.sections, tracks: renderTracks,
    songModel: songModel.model, plan: arrangement.plan, trackModels: arrangement.trackModels,
    styleSpec: arrangement.styleSpec, seed: arrangement.seed ?? undefined,
    generationProvider: arrangement.generationProvider ?? "ARRANGEMENT_ENGINE",
    generationModelVersion: arrangement.modelVersion ?? undefined, parentIds,
    includeStems: false, includeMidi: false, mixMasterControls: controls,
  });
  const master = files.find((file) => file.type === "MASTER" && file.format === "WAV");
  const mixed = files.find((file) => file.type === "MIX" && file.format === "WAV");
  if (!master || !mixed) throw new Error("Mix/master renderer did not produce both WAV variants");
  const [source] = await db.select().from(projectSourcesTable).where(and(
    eq(projectSourcesTable.id, songModel.sourceId),
    eq(projectSourcesTable.projectId, project.id),
    eq(projectSourcesTable.status, "ready"),
  )).limit(1);
  const renderedDuration = (master.data.length - 44) / (44_100 * 2 * 2);
  const originalUrl = source && source.sourceType !== "MIDI" &&
    source.durationSeconds !== null &&
    Math.abs(source.durationSeconds - renderedDuration) < .05
    ? `/api/projects/${project.id}/playback?sourceId=${encodeURIComponent(source.id)}`
    : null;
  const evaluation = arrangement.generationProvenance?.evaluation;
  const repairRequested = Boolean((arrangement.generationProvenance?.parameters as Record<string, unknown> | undefined)?.repair);
  const repairReference = repairRequested && evaluation
    ? evaluation.artifacts.find((artifact) => artifact.type === "AUDIO_TRACK" && evaluation.renderArtifactIds.includes(artifact.id))
    : undefined;
  const repairedArtifact = repairReference
    ? parentArtifacts.find((artifact) => artifact.id === repairReference.id && artifact.type === "AUDIO_TRACK" &&
      artifact.state === "ready" && artifact.storageUri?.startsWith("/api/storage/objects/exports/") &&
      artifact.url?.startsWith("/api/storage/objects/exports/") &&
      artifact.technicalMetadata.timelineSha256 === timelineSha256)
    : undefined;
  let repairedVariant: NonNullable<import("@workspace/db").MixMasterRevisionEvidence["variants"]["repaired"]> | null = null;
  if (repairedArtifact?.storageUri && repairedArtifact.checksum) {
    const object = await getPrivateObject(repairedArtifact.storageUri.slice("/api/storage/objects/".length));
    if (object) {
      const [bytes] = await object.download();
      const duration = bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF"
        ? (bytes.length - 44) / (44_100 * 2 * 2) : -1;
      if (sha256(bytes) === repairedArtifact.checksum && Math.abs(duration - renderedDuration) < .05) {
        repairedVariant = { url: repairedArtifact.url!, artifactId: repairedArtifact.id, checksum: repairedArtifact.checksum, timelineSha256, durationSeconds: duration };
      }
    }
  }
  const measured = measureWav(master.data);
  const findings: MixMasterFinding[] = [
    ...(measured.integratedLufs > -9 ? [{
      id: "master-loudness", severity: "warning" as const,
      message: `Measured ${measured.integratedLufs.toFixed(1)} LUFS can reduce transient detail.`,
      control: "master.targetLufs", startSeconds: 0, endSeconds: songModel.model.audio.durationSeconds,
    }] : []),
    ...(measured.truePeakDbtp > -1 ? [{
      id: "master-true-peak", severity: "warning" as const,
      message: "True-peak ceiling above -1 dBTP risks codec overs.",
      control: "master.truePeakDbtp", startSeconds: 0, endSeconds: songModel.model.audio.durationSeconds,
    }] : []),
  ];
  // Object ids do not depend on the allocated version, so byte upload is kept
  // outside the short serializable allocation transaction.
  const mixedArtifactId = `mix-preview-${randomUUID()}`;
  const masteredArtifactId = `master-preview-${randomUUID()}`;
  let mixedUrl: string | null = null;
  let masteredUrl: string | null = null;
  try {
    mixedUrl = await saveExportObject(`mix-master/${mixedArtifactId}.wav`, mixed.data, "audio/wav");
    masteredUrl = await saveExportObject(`mix-master/${masteredArtifactId}.wav`, master.data, "audio/wav");
  } catch (error) {
    await Promise.all([
      ...(mixedUrl ? [deleteExportObject(mixedUrl).catch(() => undefined)] : []),
      ...(masteredUrl ? [deleteExportObject(masteredUrl).catch(() => undefined)] : []),
    ]);
    throw error;
  }
  let revision: { created: typeof mixMasterRevisionsTable.$inferSelect; version: number };
  try {
    revision = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mix-master-revision:${project.id}`}))`);
    const current = await tx.select({ version: mixMasterRevisionsTable.version })
      .from(mixMasterRevisionsTable).where(eq(mixMasterRevisionsTable.projectId, params.data.projectId));
    const version = Math.max(0, ...current.map((row) => row.version)) + 1;
    const evidence = {
      arrangementId: arrangement.id, arrangementVersion: arrangement.version, songModelVersion: arrangement.songModelVersion,
      timelineSha256, artifactIds: [...parentIds, mixedArtifactId, masteredArtifactId],
      variants: {
        original: originalUrl ? { url: originalUrl, sourceId: source!.id, timelineSha256, durationSeconds: renderedDuration } : null,
        repaired: repairedVariant,
        mixed: { url: mixedUrl, artifactId: mixedArtifactId, checksum: sha256(mixed.data), timelineSha256, durationSeconds: renderedDuration },
        mastered: { url: masteredUrl, artifactId: masteredArtifactId, checksum: sha256(master.data), timelineSha256, durationSeconds: renderedDuration },
      },
      renderer: "MUSIC_ENGINE@1.0",
      quality: { integratedLufs: measured.integratedLufs, truePeakDbtp: measured.truePeakDbtp, truePeakMethod: "4x-windowed-sinc-estimate" as const, findings },
    };
    await tx.insert(musicArtifactsTable).values({
      id: mixedArtifactId, projectId: project.id, type: "AUDIO_TRACK", label: `Mixed preview v${version}`,
      version, size: formatBytes(mixed.data.length), format: "WAV", url: mixedUrl, storageUri: mixedUrl,
      state: "ready", hash: sha256(mixed.data), checksum: sha256(mixed.data), parentIds,
      createdBy: "mix-master-renderer", modelVersion: "MUSIC_ENGINE@1.0", immutable: true,
      technicalMetadata: { timelineSha256, revisionVersion: version, variant: "mixed" },
    });
    await tx.insert(musicArtifactsTable).values({
      id: masteredArtifactId, projectId: project.id, type: "AUDIO_TRACK", label: `Mastered preview v${version}`,
      version, size: formatBytes(master.data.length), format: "WAV", url: masteredUrl, storageUri: masteredUrl,
      state: "ready", hash: sha256(master.data), checksum: sha256(master.data), parentIds: [mixedArtifactId],
      createdBy: "mix-master-renderer", modelVersion: "MUSIC_ENGINE@1.0", immutable: true,
      technicalMetadata: { timelineSha256, revisionVersion: version, variant: "mastered" },
    });
    const [created] = await tx.insert(mixMasterRevisionsTable).values({
      id: randomUUID(), projectId: project.id, arrangementId: arrangement.id, version, controls, evidence,
      previewArtifactId: masteredArtifactId, createdBy: req.user!.id,
    }).returning();
    await appendProducerDecisionTx(tx, {
      ownerId: req.user!.id, projectId: created.projectId, domain: "mix",
      kind: "edit", source: "inferred_behavior",
      context: { subjectId: created.id, modelVersion: null, evidenceIds: created.evidence.artifactIds,
        lineageIds: [created.arrangementId], evidenceSha256: created.evidence.timelineSha256 },
    });
    return { created, version };
    });
  } catch (error) {
    await Promise.all([deleteExportObject(mixedUrl).catch(() => undefined), deleteExportObject(masteredUrl).catch(() => undefined)]);
    throw error;
  }
  res.status(201).json(CreateMixMasterRevisionResponse.parse(mixMasterRevisionResponse(
    revision.created,
    masteredUrl,
  )));
});

router.post("/projects/:projectId/mix-master-revisions/:revisionId/approve", async (req, res): Promise<void> => {
  const params = ApproveMixMasterRevisionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [ownedProject] = await db.select({ id: musicProjectsTable.id })
    .from(musicProjectsTable)
    .where(and(
      eq(musicProjectsTable.id, params.data.projectId),
      eq(musicProjectsTable.ownerId, req.user!.id),
    ))
    .limit(1);
  if (!ownedProject) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [existing] = await db.select().from(mixMasterRevisionsTable).where(and(
    eq(mixMasterRevisionsTable.id, params.data.revisionId),
    eq(mixMasterRevisionsTable.projectId, params.data.projectId),
  )).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Mix/master revision not found" });
    return;
  }
  const blocking = existing.evidence.quality.findings.find((finding) => finding.severity === "error");
  if (blocking) {
    res.status(409).json({ error: `Approval blocked: ${blocking.message}` });
    return;
  }
  const [artifact] = await db.select().from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.id, existing.previewArtifactId)).limit(1);
  if (!artifact?.storageUri?.startsWith("/api/storage/objects/exports/") || artifact.state !== "ready" || !artifact.checksum) {
    res.status(409).json({ error: "Preview artifact is not ready for approval" });
    return;
  }
  const stored = await getPrivateObject(artifact.storageUri.slice("/api/storage/objects/".length));
  if (!stored) {
    res.status(409).json({ error: "Preview artifact bytes are unavailable" });
    return;
  }
  const [bytes] = await stored.download();
  if (sha256(bytes) !== artifact.checksum) {
    res.status(409).json({ error: "Preview artifact integrity verification failed" });
    return;
  }
  const revision = existing.approvedAt ? existing : await db.transaction(async (tx) => {
    const [stillOwned] = await tx.select({ id: musicProjectsTable.id })
      .from(musicProjectsTable)
      .where(and(
        eq(musicProjectsTable.id, existing.projectId),
        eq(musicProjectsTable.ownerId, req.user!.id),
      ))
      .limit(1);
    if (!stillOwned) throw new Error("Project ownership changed during mix/master approval");
    await tx.update(mixMasterRevisionsTable).set({ approvedAt: null, approvedBy: null }).where(and(
      eq(mixMasterRevisionsTable.projectId, existing.projectId),
      eq(mixMasterRevisionsTable.arrangementId, existing.arrangementId),
    ));
    const [approved] = await tx.update(mixMasterRevisionsTable).set({
      approvedAt: new Date(), approvedBy: req.user!.id,
    }).where(and(
      eq(mixMasterRevisionsTable.id, existing.id),
      eq(mixMasterRevisionsTable.projectId, existing.projectId),
      eq(mixMasterRevisionsTable.arrangementId, existing.arrangementId),
    )).returning();
    await appendProducerDecisionTx(tx, {
      ownerId: req.user!.id, projectId: approved.projectId, domain: "master",
      kind: "approval", source: "inferred_behavior",
      context: { subjectId: approved.id, modelVersion: null, evidenceIds: approved.evidence.artifactIds,
        lineageIds: [approved.arrangementId], evidenceSha256: approved.evidence.timelineSha256 },
    });
    return approved;
  });
  res.json(ApproveMixMasterRevisionResponse.parse(mixMasterRevisionResponse(revision, artifact.url ?? "")));
});

router.post("/projects/:projectId/export", async (req, res): Promise<void> => {
  await ensureSeeded();
  const params = CreateProjectExportParams.safeParse(req.params);
  const body = CreateProjectExportBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid export request" });
    return;
  }
  const [ownedProject] = await db.select({ id: musicProjectsTable.id })
    .from(musicProjectsTable)
    .where(and(
      eq(musicProjectsTable.id, params.data.projectId),
      eq(musicProjectsTable.ownerId, req.user!.id),
    ))
    .limit(1);
  if (!ownedProject) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  // Export rendering is deliberately outside the request lifecycle.  The job
  // snapshot makes a retry render the exact requested arrangement/options.
  const arrangementCandidates = await db.select().from(arrangementsTable)
    .where(eq(arrangementsTable.projectId, params.data.projectId))
    .orderBy(desc(arrangementsTable.version));
  const requestedArrangement = body.data.arrangementId
    ? arrangementCandidates.find((item) => item.id === body.data.arrangementId)
    : arrangementCandidates[0];
  if (!requestedArrangement) {
    res.status(404).json({ error: "Arrangement not found" });
    return;
  }
  if (!body.data.approvedRevisionId) {
    res.status(409).json({ error: "An approved mix/master revision is required before export" });
    return;
  }
  const [approvedRevision] = await db.select().from(mixMasterRevisionsTable).where(and(
    eq(mixMasterRevisionsTable.id, body.data.approvedRevisionId),
    eq(mixMasterRevisionsTable.projectId, params.data.projectId),
    eq(mixMasterRevisionsTable.arrangementId, requestedArrangement.id),
  )).limit(1);
  if (!approvedRevision?.approvedAt) {
    res.status(409).json({ error: "The requested mix/master revision is not approved for this arrangement" });
    return;
  }
  const [approvedPreview] = await db.select({
    checksum: musicArtifactsTable.checksum,
    state: musicArtifactsTable.state,
  }).from(musicArtifactsTable)
    .where(eq(musicArtifactsTable.id, approvedRevision.previewArtifactId)).limit(1);
  if (!approvedPreview?.checksum || approvedPreview.state !== "ready") {
    res.status(409).json({ error: "Approved preview artifact is no longer ready" });
    return;
  }
  const idempotencyKey = (body.data.idempotencyKey?.trim() ||
    `export:${requestedArrangement.id}:v${requestedArrangement.version}:${sha256(
      JSON.stringify({
        includeStems: body.data.includeStems ?? true,
        includeMidi: body.data.includeMidi ?? true,
        includeMix: body.data.includeMix ?? true,
        includeMetadata: body.data.includeMetadata ?? true,
        masterProfile: body.data.masterProfile ?? "STREAMING",
      }),
    ).slice(0, 24)}`).slice(0, 200);
  const { job, duplicate } = await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`music-export-idempotency:${params.data.projectId}:${idempotencyKey}`}))`,
    );
    const [existingJob] = await transaction.select().from(productionJobsTable)
      .where(and(
        eq(productionJobsTable.projectId, params.data.projectId),
        eq(productionJobsTable.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    if (existingJob) return { job: existingJob, duplicate: true };
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`music-export:${params.data.projectId}`}))`);
    const exportArtifacts = await transaction.select({ version: musicArtifactsTable.version })
      .from(musicArtifactsTable)
      .where(sql`${musicArtifactsTable.projectId} = ${params.data.projectId} and ${musicArtifactsTable.type} = 'EXPORT'`);
    const version = Math.max(0, ...exportArtifacts.map((artifact) => artifact.version)) + 1;
    const exportId = `export-${params.data.projectId}-${version}-${randomUUID().slice(0, 8)}`;
    await transaction.insert(musicArtifactsTable).values({
      id: exportId, projectId: params.data.projectId, type: "EXPORT",
      label: `${requestedArrangement.name} v${version} export`, version, size: "Queued", format: "ZIP",
      url: `/api/exports/${exportId}/download`, state: "rendering", parentIds: [approvedRevision.previewArtifactId],
      createdBy: "export-pipeline", modelVersion: "EXPORT_PIPELINE@1.0.0",
       parameters: { arrangementId: requestedArrangement.id, approvedRevisionId: approvedRevision.id, includeStems: body.data.includeStems ?? true, includeMidi: body.data.includeMidi ?? true },
      storageUri: `db://music_exports/${exportId}`,
      immutable: false,
    });
    const queued = await queueProductionJob({
      projectId: params.data.projectId, ownerId: req.user!.id, kind: "export", idempotencyKey,
      resourcePool: "STUDIO_RENDER", requiredCapabilities: ["export"],
      estimatedCostUnits: 100,
      inputSnapshot: {
        ...body.data,
        arrangementId: requestedArrangement.id,
        exportId,
        version,
         approvedRevisionId: approvedRevision.id,
         approvedPreviewChecksum: approvedPreview.checksum,
         approvedArrangementVersion: approvedRevision.evidence.arrangementVersion,
      },
    }, transaction);
    return { job: queued.job, duplicate: false };
  });
  // Starting immediately is an optimization only: recovery is the durable
  // execution path if this process exits before or during rendering.
  if (!duplicate) void runExportProductionJob(job.id);
  res.status(202).json(productionJobResponse(job));
  return;

  /*
  const [project] = await db
    .select()
    .from(musicProjectsTable)
    .where(eq(musicProjectsTable.id, params.data.projectId));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [arrangements, tracks, songModels, artifacts] = await Promise.all([
    db
      .select()
      .from(arrangementsTable)
      .where(eq(arrangementsTable.projectId, project.id))
      .orderBy(desc(arrangementsTable.version)),
    db.select().from(tracksTable).where(eq(tracksTable.projectId, project.id)),
    db
      .select()
      .from(songModelsTable)
      .where(eq(songModelsTable.projectId, project.id))
      .orderBy(desc(songModelsTable.version)),
    db
      .select()
      .from(musicArtifactsTable)
      .where(eq(musicArtifactsTable.projectId, project.id)),
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
  const songModel = songModels.find((model) =>
    model.version === arrangement.songModelVersion) ?? songModels[0];
  if (!songModel || !arrangement.plan || !arrangement.styleSpec ||
      arrangement.trackModels.length === 0) {
    res.status(409).json({
      error: "The selected arrangement has no persisted Song Model, plan, style, or TrackModels",
    });
    return;
  }
  const planArtifact = artifacts.find((artifact) =>
    artifact.type === "ARRANGEMENT_PLAN" &&
    (artifact.storageUri === `db://music_arrangements/${arrangement.id}` ||
      artifact.id === arrangement.sourceCandidateId));
  if (!planArtifact) {
    res.status(409).json({ error: "The selected arrangement plan artifact is unavailable" });
    return;
  }
  const trackModelArtifactIds = Object.fromEntries(
    artifacts
      .filter((artifact) =>
        artifact.type === "TRACK_MODEL" &&
        artifact.storageUri?.startsWith(`db://music_arrangements/${arrangement.id}/tracks/`))
      .map((artifact) => [
        String(artifact.parameters.trackId ??
          artifact.storageUri?.split("/").at(-1)),
        artifact.id,
      ]),
  );
  const expectedTrackIds = new Set(arrangement.trackModels.map((model) => model.id));
  if ([...expectedTrackIds].some((id) => !trackModelArtifactIds[id])) {
    res.status(409).json({ error: "One or more selected TrackModel artifacts are unavailable" });
    return;
  }
  const exportTrackModels = applyArrangementEditorChanges({
    trackModels: arrangement.trackModels,
    sections: arrangement.sections,
    tracks,
    bpm: project.bpm,
    meter: project.meter,
  });
  const playabilityErrors = validateCanonicalTrackModels(
    exportTrackModels,
    [...expectedTrackIds],
  );
  if (playabilityErrors.length) {
    res.status(409).json({
      error: "Arrangement editor changes are not playable",
      issues: playabilityErrors,
    });
    return;
  }
  const renderParents = Object.values(trackModelArtifactIds);

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
      parentIds: [planArtifact.id],
      createdBy: "export-pipeline",
      modelVersion: "EXPORT_PIPELINE@1.0.0",
      parameters: {
        arrangementId: arrangement.id,
        includeStems: body.data.includeStems ?? true,
        includeMidi: body.data.includeMidi ?? true,
      },
      storageUri: `db://music_exports/${exportId}`,
    });
    return { exportId, version };
  });

  try {
    const renderedFiles = (await renderArrangementExport({
      projectName: project.name,
      bpm: project.bpm,
      key: project.key,
      meter: project.meter,
      arrangementName: arrangement.name,
      arrangementVersion: arrangement.version,
      masterProfile: body.data.masterProfile ?? "STREAMING",
      energy: arrangement.energy,
      density: arrangement.density,
      harmonyComplexity: arrangement.harmonyComplexity,
      sections: arrangement.sections,
      tracks,
      songModel: songModel.model,
      plan: arrangement.plan,
      trackModels: exportTrackModels,
      styleSpec: arrangement.styleSpec,
      seed: arrangement.seed ?? undefined,
      generationProvider: arrangement.generationProvenance?.provider ??
        arrangement.generationProvider ?? "ARRANGEMENT_ENGINE",
      generationModelVersion: arrangement.generationProvenance?.modelVersion ??
        arrangement.modelVersion ?? undefined,
      generationCheckpointSha256:
        arrangement.generationProvenance?.checkpointSha256 ?? undefined,
      candidateId: arrangement.generationProvenance?.candidateId ??
        arrangement.sourceCandidateId ?? undefined,
      providerRequestId: arrangement.generationProvenance?.providerRequestId ??
        undefined,
      parentIds: renderParents.length ? renderParents : [planArtifact.id],
      planArtifactId: planArtifact.id,
      planParentIds: planArtifact.parentIds,
      trackModelArtifactIds,
      includeStems: body.data.includeStems ?? true,
      includeMidi: body.data.includeMidi ?? true,
    })).filter((file) =>
      (body.data.includeMix !== false ||
        !["MIX", "PREMASTER", "MASTER"].includes(file.type)) &&
      (body.data.includeMetadata !== false || file.type !== "METADATA"));
    const fileAllocations = new Map(renderedFiles.map((file) => [
      file.name,
      {
        artifactId: randomUUID(),
        parentIds: file.provenance.parentIds,
      },
    ]));
    const bundle = createExportBundle(
      project,
      arrangement,
      tracks,
      body.data,
      allocation.version,
      "",
      allocation.exportId,
      renderedFiles,
      Object.fromEntries(fileAllocations),
    );
    const artifactRows: Array<typeof musicArtifactsTable.$inferInsert> =
      bundle.package.files.map((file) => ({
        id: fileAllocations.get(file.name)!.artifactId,
        projectId: project.id,
        type: file.type,
        label: file.name,
        version: allocation.version,
        size: file.size,
        format: file.format,
        url: bundle.package.url,
        hash: sha256(bundle.files.get(file.name) ?? file.name),
        checksum: sha256(bundle.files.get(file.name) ?? file.name),
        parentIds: fileAllocations.get(file.name)!.parentIds,
        createdBy: "export-engine",
        modelVersion: "EXPORT_ENGINE@2.0.0",
        parameters: {
          arrangementId: arrangement.id,
          exportId: allocation.exportId,
          generationProvider: arrangement.generationProvenance?.provider ??
            arrangement.generationProvider ?? "ARRANGEMENT_ENGINE",
          generationModelVersion: arrangement.generationProvenance?.modelVersion ??
            arrangement.modelVersion ?? "unknown",
          generationCheckpointSha256:
            arrangement.generationProvenance?.checkpointSha256 ?? "none",
          generationCandidateId: arrangement.generationProvenance?.candidateId ??
            arrangement.sourceCandidateId ?? "none",
          seed: arrangement.seed ?? 0,
        },
        storageUri: bundle.package.url,
        provider: arrangement.generationProvenance?.provider ??
          arrangement.generationProvider ?? "ARRANGEMENT_ENGINE",
        license: "Project-owned output",
        retentionPolicy: "project",
        technicalMetadata: {
          mediaType: file.format,
          bytes: bundle.files.get(file.name)?.length ?? 0,
          arrangementVersion: arrangement.version,
        },
      }));
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${project.id}))`,
      );
      const [activeProject] = await transaction
        .select({ id: musicProjectsTable.id })
        .from(musicProjectsTable)
        .where(eq(musicProjectsTable.id, project.id))
        .limit(1);
      if (!activeProject) {
        throw new Error("Project was deleted before the export could be stored");
      }
      await persistExportBundle(bundle);
      await transaction.insert(musicArtifactsTable).values(artifactRows);
      await transaction
        .update(musicArtifactsTable)
        .set({
          label: bundle.package.filename,
          size: bundle.package.size,
          url: bundle.package.url,
          state: "ready",
          hash: sha256(bundle.zip),
          checksum: sha256(bundle.zip),
          storageUri: bundle.package.url,
          parentIds: [...fileAllocations.values()].map((file) => file.artifactId),
          provider: "EXPORT_PIPELINE",
          license: "Project-owned output",
          retentionPolicy: "project",
          technicalMetadata: {
            mediaType: "application/zip",
            bytes: bundle.zip.length,
            fileCount: bundle.package.files.length,
            arrangementVersion: arrangement.version,
          },
        })
        .where(eq(musicArtifactsTable.id, allocation.exportId));
      await transaction
        .update(musicProjectsTable)
        .set({ status: "ready" })
        .where(eq(musicProjectsTable.id, project.id));
      await transaction.insert(studioActivitiesTable).values({
        id: randomUUID(),
        projectId: project.id,
        title: "Export package ready",
        detail: `${bundle.package.filename} · ${bundle.package.size}`,
        type: "export",
      });
    });
    exportBundles.set(bundle.package.id, bundle);

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
    await deleteExportObject(
      `/api/storage/objects/exports/${allocation.exportId}.zip`,
    ).catch(() => undefined);
    await db
      .update(musicArtifactsTable)
      .set({ state: "failed", size: "Failed" })
      .where(eq(musicArtifactsTable.id, allocation.exportId));
    throw error;
  }
  */
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
  const [ownedProject] = await db
    .select({ id: musicProjectsTable.id })
    .from(musicProjectsTable)
    .where(and(
      eq(musicProjectsTable.id, artifact.projectId),
      eq(musicProjectsTable.ownerId, req.user!.id),
    ))
    .limit(1);
  if (!ownedProject) {
    res.status(404).json({ error: "Export package not found or expired" });
    return;
  }
  if (artifact.state !== "ready") {
    res.status(409).json({ error: `Export package is ${artifact.state}` });
    return;
  }
  const storageObjectId = artifact.storageUri?.startsWith("export-object://")
    ? artifact.storageUri.slice("export-object://".length)
    : artifact.storageUri?.startsWith("/api/storage/objects/exports/")
      ? artifact.storageUri
          .slice("/api/storage/objects/exports/".length)
          .replace(/\.zip$/, "")
      : params.data.exportId;
  const zip = cachedBundle?.zip ?? await loadExportZip(storageObjectId);
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
  if ((body.data.startBar === undefined) !== (body.data.endBar === undefined)) {
    res.status(400).json({ error: "Copilot bar targets require both startBar and endBar" });
    return;
  }
  if (
    body.data.startBar !== undefined &&
    body.data.endBar !== undefined &&
    body.data.endBar < body.data.startBar
  ) {
    res.status(400).json({ error: "Copilot target endBar must not precede startBar" });
    return;
  }
  const [scopedArrangement] = body.data.arrangementId
    ? await db
        .select()
        .from(arrangementsTable)
        .where(and(
          eq(arrangementsTable.id, body.data.arrangementId),
          eq(arrangementsTable.projectId, params.data.projectId),
        ))
        .limit(1)
    : [];
  if (body.data.arrangementId && !scopedArrangement) {
    res.status(404).json({ error: "Arrangement not found in this project" });
    return;
  }
  if (
    body.data.targetSection &&
    scopedArrangement &&
    !scopedArrangement.sections.some((section) => section.name === body.data.targetSection)
  ) {
    res.status(400).json({ error: "Target section is not part of this arrangement" });
    return;
  }
  if (body.data.targetTrack) {
    const trackRows = await db
      .select({ name: tracksTable.name })
      .from(tracksTable)
      .where(eq(tracksTable.projectId, params.data.projectId));
    if (!trackRows.some((track) => track.name === body.data.targetTrack)) {
      res.status(400).json({ error: "Target track is not part of this project" });
      return;
    }
  }
  if (body.data.targetSection && scopedArrangement) {
    const targetSection = scopedArrangement.sections.find((section) => section.name === body.data.targetSection);
    if (
      targetSection?.startBar !== undefined &&
      targetSection.endBar !== undefined &&
      (
        (body.data.startBar !== undefined && body.data.startBar < targetSection.startBar) ||
        (body.data.endBar !== undefined && body.data.endBar > targetSection.endBar)
      )
    ) {
      res.status(400).json({ error: "Copilot target bars must stay inside the selected section" });
      return;
    }
  }
  const interpretation = await interpretCopilotCommand(body.data.command, {
    targetSection: body.data.targetSection,
    targetTrack: body.data.targetTrack,
    startBar: body.data.startBar,
    endBar: body.data.endBar,
    sectionNames: scopedArrangement?.sections.map((section) => section.name) ?? [],
    trackNames: (await db
      .select({ name: tracksTable.name })
      .from(tracksTable)
      .where(eq(tracksTable.projectId, params.data.projectId))).map((track) => track.name),
  });
  res.json(RunCopilotResponse.parse({
    reply: interpretation.interpreter === "openai"
      ? `${interpretation.reply} (Copilot interpretation)`
      : interpretation.reply,
    operations: interpretation.operations,
    affectedSections: interpretation.affectedSections,
    interpreter: interpretation.interpreter,
  }));
});

export default router;
