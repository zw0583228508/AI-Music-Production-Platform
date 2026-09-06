import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  arrangementsTable,
  db,
  musicArtifactsTable,
  musicUsageLedgerTable,
  musicProjectsTable,
  productionJobsTable,
  songModelsTable,
  studioActivitiesTable,
  tracksTable,
} from "@workspace/db";
import { createExportBundle, persistExportBundle } from "./export-pipeline";
import {
  type GeneratedExportFile,
  renderArrangementExport,
  rendererEvidenceTechnicalMetadata,
  processingEvidenceTechnicalMetadata,
} from "./exportEngine";
import { processPedalboardBuiltinWav, type PedalboardProcessingEvidence } from "./pedalboardBuiltin";
import { resolveExportSongModel } from "./exportLineage";
import { applyArrangementEditorChanges } from "./musicEngines";
import { validateCanonicalTrackModels } from "./musicProviders";
import { deleteExportObject, getPrivateObject } from "./objectStorage";
import {
  claimProductionJob,
  completeProductionJob,
  acknowledgeProductionJobCancellation,
  failProductionJob,
  heartbeatProductionJob,
  isProductionJobCancellationRequested,
  structuredJobError,
  recoverProductionJobs,
} from "./productionJobs";

type ExportInputSnapshot = {
  exportId: string;
  version: number;
  arrangementId: string;
  includeStems?: boolean;
  includeMidi?: boolean;
  includeMix?: boolean;
  includeMetadata?: boolean;
  masterProfile?: "STREAMING" | "DYNAMIC" | "CLASSICAL" | "POP" | "LOUD" | "FILM";
  processingProvider?: "PEDALBOARD_BUILTIN";
  pedalboardProcessing?: boolean;
};

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function selectedProviderAudioExport(
  arrangement: typeof arrangementsTable.$inferSelect,
  artifacts: Array<typeof musicArtifactsTable.$inferSelect>,
): Promise<GeneratedExportFile[]> {
  const evaluation = arrangement.generationProvenance?.evaluation;
  if (!evaluation || evaluation.status !== "evaluated") return [];
  const audioReference = evaluation.artifacts.find((artifact) =>
    artifact.type === "AUDIO_TRACK" &&
    evaluation.renderArtifactIds.includes(artifact.id)
  );
  if (!audioReference) return [];
  const artifact = artifacts.find((item) => item.id === audioReference.id);
  if (!artifact || artifact.createdBy !== "gpu-provider-output-ingest") return [];
  const prefix = "/api/storage/objects/";
  if (!artifact.storageUri?.startsWith(`${prefix}exports/`)) {
    throw new Error("Selected provider audio has an invalid storage location");
  }
  const object = await getPrivateObject(artifact.storageUri.slice(prefix.length));
  if (!object) throw new Error("Selected provider audio is unavailable");
  const [wav] = await object.download();
  const checksum = sha256(wav);
  if (
    wav.byteLength <= 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE" ||
    checksum !== artifact.checksum ||
    checksum !== artifact.hash
  ) {
    throw new Error("Selected provider audio failed export verification");
  }
  const provider = arrangement.generationProvenance?.provider ?? artifact.provider;
  const modelVersion =
    arrangement.generationProvenance?.modelVersion ?? artifact.modelVersion;
  const candidateId = arrangement.generationProvenance?.candidateId;
  if (!provider || !modelVersion || !candidateId) {
    throw new Error("Selected provider audio is missing required generation lineage");
  }
  return [{
    name: "mix/generated-accompaniment.wav",
    type: "MIX",
    format: "WAV",
    contentType: "audio/wav",
    data: wav,
    provenance: {
      model: provider,
      version: modelVersion,
      parameters: {
        candidateId,
        sourceArtifactId: artifact.id,
        checksum,
      },
      parentIds: [artifact.id],
      createdBy: "export-engine",
    },
  }];
}
const artifactIdFor = (jobId: string, name: string) =>
  `export-file-${jobId}-${sha256(name).slice(0, 16)}`;

function exportInput(snapshot: Record<string, unknown>): ExportInputSnapshot {
  if (
    typeof snapshot.exportId !== "string" ||
    typeof snapshot.version !== "number" ||
    typeof snapshot.arrangementId !== "string"
  ) {
    throw new Error("Invalid export job input snapshot");
  }
  return snapshot as ExportInputSnapshot;
}

/** Process one export using the production-job lease as its fencing token. */
export async function runExportProductionJob(jobId: string): Promise<void> {
  const workerId = `export-worker-${randomUUID()}`;
  const job = await claimProductionJob(jobId, workerId);
  if (!job || job.kind !== "export") return;
  const leaseVersion = job.leaseVersion;
  let exportId: string | null = null;
  let unpublishedObjectPath: string | null = null;
  let leaseLost = false;
  const heartbeatTimer = setInterval(() => {
    void heartbeatProductionJob(
      job.id,
      workerId,
      leaseVersion,
      "rendering",
    ).then((owned) => {
      if (!owned) leaseLost = true;
    }).catch(() => {
      leaseLost = true;
    });
  }, 30_000);
  heartbeatTimer.unref();

  try {
    const input = exportInput(job.inputSnapshot);
    exportId = input.exportId;
    const heartbeat = async (stage: string, progress: number) => {
      if (!await heartbeatProductionJob(job.id, workerId, leaseVersion, stage, progress)) {
        throw new Error("Export job lease was lost");
      }
      if (await isProductionJobCancellationRequested(job.id, workerId, leaseVersion)) {
        throw new Error("Export job was cancelled");
      }
    };
    await heartbeat("loading_export_inputs", 10);

    const [project] = await db.select().from(musicProjectsTable)
      .where(eq(musicProjectsTable.id, job.projectId)).limit(1);
    const [arrangement] = await db.select().from(arrangementsTable)
      .where(and(eq(arrangementsTable.id, input.arrangementId), eq(arrangementsTable.projectId, job.projectId))).limit(1);
    const [tracks, songModels, artifacts] = await Promise.all([
      db.select().from(tracksTable).where(eq(tracksTable.projectId, job.projectId)),
      db.select().from(songModelsTable).where(eq(songModelsTable.projectId, job.projectId)).orderBy(desc(songModelsTable.version)),
      db.select().from(musicArtifactsTable).where(eq(musicArtifactsTable.projectId, job.projectId)),
    ]);
    if (!project || !arrangement) throw new Error("Export project or arrangement is unavailable");
    const [exportArtifact] = artifacts.filter((artifact) => artifact.id === input.exportId);
    if (!exportArtifact) throw new Error("Export artifact allocation is unavailable");
    if (exportArtifact.state === "ready") {
      await completeProductionJob(job.id, workerId, leaseVersion, [input.exportId]);
      return;
    }
    const { songModel, bpm, key, meter } = resolveExportSongModel(
      songModels,
      arrangement.songModelVersion,
    );
    if (!arrangement.plan || !arrangement.styleSpec) {
      throw new Error("The selected arrangement has no persisted Song Model, plan, or style");
    }
    const planArtifact = artifacts.find((artifact) => artifact.type === "ARRANGEMENT_PLAN" &&
      (artifact.storageUri === `db://music_arrangements/${arrangement.id}` || artifact.id === arrangement.sourceCandidateId));
    if (!planArtifact) throw new Error("The selected arrangement plan artifact is unavailable");
    const trackModelArtifactIds = Object.fromEntries(artifacts
      .filter((artifact) => artifact.type === "TRACK_MODEL" &&
        artifact.storageUri?.startsWith(`db://music_arrangements/${arrangement.id}/tracks/`))
      .map((artifact) => [String(artifact.parameters.trackId ?? artifact.storageUri?.split("/").at(-1)), artifact.id]));
    const expectedTrackIds = new Set(arrangement.trackModels.map((model) => model.id));
    if ([...expectedTrackIds].some((id) => !trackModelArtifactIds[id])) {
      throw new Error("One or more selected TrackModel artifacts are unavailable");
    }
    const exportTrackModels = arrangement.trackModels.length > 0
      ? applyArrangementEditorChanges({
          trackModels: arrangement.trackModels,
          sections: arrangement.sections,
          tracks,
          bpm,
          meter,
        })
      : [];
    const playabilityErrors = validateCanonicalTrackModels(
      exportTrackModels,
      [...expectedTrackIds],
    );
    if (playabilityErrors.length) {
      throw new Error("Arrangement editor changes are not playable");
    }

    await heartbeat("rendering", 25);
    const deterministicFiles = exportTrackModels.length > 0
      ? await renderArrangementExport({
          projectName: project.name, bpm, key, meter,
          arrangementName: arrangement.name, arrangementVersion: arrangement.version,
          masterProfile: input.masterProfile ?? "STREAMING", energy: arrangement.energy, density: arrangement.density,
          harmonyComplexity: arrangement.harmonyComplexity, sections: arrangement.sections, tracks, songModel: songModel.model,
          plan: arrangement.plan, trackModels: exportTrackModels, styleSpec: arrangement.styleSpec, seed: arrangement.seed ?? undefined,
          generationProvider: arrangement.generationProvenance?.provider ?? arrangement.generationProvider ?? "ARRANGEMENT_ENGINE",
          generationModelVersion: arrangement.generationProvenance?.modelVersion ?? arrangement.modelVersion ?? undefined,
          generationCheckpointSha256: arrangement.generationProvenance?.checkpointSha256 ?? undefined,
          candidateId: arrangement.generationProvenance?.candidateId ?? arrangement.sourceCandidateId ?? undefined,
          providerRequestId: arrangement.generationProvenance?.providerRequestId ?? undefined,
          parentIds: Object.values(trackModelArtifactIds).length ? Object.values(trackModelArtifactIds) : [planArtifact.id],
          planArtifactId: planArtifact.id, planParentIds: planArtifact.parentIds, trackModelArtifactIds,
          includeStems: input.includeStems ?? true, includeMidi: input.includeMidi ?? true,
        })
      : [];
    const providerAudioFiles = await selectedProviderAudioExport(
      arrangement,
      artifacts,
    );
    if (deterministicFiles.length === 0 && providerAudioFiles.length === 0) {
      throw new Error(
        "The selected arrangement has neither symbolic tracks nor verified provider audio",
      );
    }
    let renderedFiles = [...deterministicFiles, ...providerAudioFiles]
      .filter((file) => (input.includeMix !== false || !["MIX", "PREMASTER", "MASTER"].includes(file.type)) &&
      (input.includeMetadata !== false || file.type !== "METADATA"));
    const pedalboardRequested = input.processingProvider === "PEDALBOARD_BUILTIN" ||
      input.pedalboardProcessing === true ||
      process.env.PEDALBOARD_BUILTIN_EXPORT_PROCESSING === "true";
    const processingEvidence: Record<string, PedalboardProcessingEvidence> = {};
    if (pedalboardRequested) {
      // The product contract applies mastering effects to final mixes only, never
      // to stems (which would make stems unsuitable for remixing).
      renderedFiles = await Promise.all(renderedFiles.map(async (file) => {
        if (!["MIX", "MASTER"].includes(file.type) || file.format !== "WAV") return file;
        const processed = await processPedalboardBuiltinWav(file.data);
        processingEvidence[file.name] = processed.evidence;
        return {
          ...file,
          data: processed.data,
          processingEvidence: processed.evidence,
          provenance: {
            ...file.provenance,
            model: processed.evidence.provider,
            version: processed.evidence.version,
            parameters: {
              ...file.provenance.parameters,
              processingStatus: processed.evidence.status,
              processingInputSha256: processed.evidence.inputSha256,
              processingOutputSha256: processed.evidence.outputSha256,
            },
          },
        };
      }));
      if (!Object.keys(processingEvidence).length) {
        throw new Error("Pedalboard processing was requested but no final WAV was available");
      }
      renderedFiles = renderedFiles.map((file) => {
        if (file.name !== "project/manifest.json") return file;
        const metadata = JSON.parse(file.data.toString()) as Record<string, unknown>;
        return { ...file, data: Buffer.from(JSON.stringify({ ...metadata, processingEvidence }, null, 2)) };
      });
    }
    await heartbeat("packaging", 70);
    const fileArtifactIds = Object.fromEntries(renderedFiles.map((file) => [file.name, artifactIdFor(job.id, file.name)]));
    const artifactGraph = Object.fromEntries(renderedFiles.map((file) => [file.name, {
      artifactId: fileArtifactIds[file.name],
      parentIds: file.provenance.parentIds,
    }]));
    const exportProject = { ...project, bpm, key, meter };
    const bundle = createExportBundle(exportProject, arrangement, tracks, input, input.version, "", input.exportId, renderedFiles, artifactGraph, processingEvidence);
    const storageObjectId = `${input.exportId}-${sha256(bundle.zip)}`;
    const storageObjectPath = `/api/storage/objects/exports/${storageObjectId}.zip`;
    await heartbeat("persisting", 85);
    const artifactRows = bundle.package.files.map((file) => {
      const renderedFile = renderedFiles.find((item) => item.name === file.name);
      const evidence = renderedFile?.rendererEvidence;
        const processing = renderedFile?.processingEvidence;
      return {
        id: fileArtifactIds[file.name], projectId: project.id, type: file.type, label: file.name, version: input.version,
        size: file.size, format: file.format, url: bundle.package.url, hash: sha256(bundle.files.get(file.name) ?? file.name),
        checksum: sha256(bundle.files.get(file.name) ?? file.name), parentIds: renderedFile?.provenance.parentIds ?? [],
        createdBy: "export-engine", modelVersion: "EXPORT_ENGINE@2.0.0",
        parameters: {
          arrangementId: arrangement.id,
          exportId: input.exportId,
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
          exportId: input.exportId,
          ...(evidence ? {
            trackName: evidence.trackName,
            role: evidence.role,
            ...rendererEvidenceTechnicalMetadata(evidence),
          } : {}),
          ...processingEvidenceTechnicalMetadata(processing),
        },
      };
    });
    const renderEvidence = renderedFiles
      .map((file) => file.rendererEvidence)
      .filter((evidence): evidence is NonNullable<typeof evidence> => Boolean(evidence));
    const nativeStemCount = renderEvidence.filter((evidence) =>
      evidence.rendererStatus === "licensed-native").length;
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
      await persistExportBundle(bundle, storageObjectId);
      unpublishedObjectPath = storageObjectPath;
      const now = new Date();
      const [completed] = await transaction.update(productionJobsTable).set({
        status: "succeeded",
        stage: "complete",
        progress: 100,
        outputArtifactIds: [
          input.exportId,
          ...Object.values(fileArtifactIds),
        ],
        actualCostUnits: 100,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      }).where(and(
        eq(productionJobsTable.id, job.id),
        eq(productionJobsTable.workerId, workerId),
        eq(productionJobsTable.leaseVersion, leaseVersion),
        eq(productionJobsTable.status, "running"),
        gt(productionJobsTable.leaseExpiresAt, now),
      )).returning({ id: productionJobsTable.id });
      if (!completed || leaseLost) throw new Error("Export job lease was lost before publication");
      await transaction.insert(musicArtifactsTable).values(artifactRows).onConflictDoNothing();
      await transaction.update(musicArtifactsTable).set({
        label: bundle.package.filename, size: bundle.package.size, url: bundle.package.url, state: "ready",
        hash: sha256(bundle.zip), checksum: sha256(bundle.zip),
        storageUri: storageObjectPath,
        parentIds: Object.values(fileArtifactIds), provider: "EXPORT_PIPELINE", license: "Project-owned output",
        retentionPolicy: "project", immutable: true,
         technicalMetadata: {
           mediaType: "application/zip",
           bytes: bundle.zip.length,
           fileCount: bundle.package.files.length,
           arrangementVersion: arrangement.version,
           renderEvidenceVersion: "1.0.0",
           stemCount: renderEvidence.length,
           nativeStemCount,
           fallbackStemCount: renderEvidence.length - nativeStemCount,
            pedalboardProcessing: pedalboardRequested ? "processed" : "not-requested",
            processingEvidence: JSON.stringify(processingEvidence),
         },
      }).where(eq(musicArtifactsTable.id, input.exportId));
      await transaction.update(musicProjectsTable).set({ status: "ready" }).where(eq(musicProjectsTable.id, project.id));
      await transaction.update(musicUsageLedgerTable).set({
        status: "completed",
        actualCostCents: 100,
      }).where(eq(musicUsageLedgerTable.jobId, job.id));
      await transaction.insert(studioActivitiesTable).values({
        id: randomUUID(), projectId: project.id, title: "Export package ready",
        detail: `${bundle.package.filename} · ${bundle.package.size}`, type: "export",
      });
    });
    unpublishedObjectPath = null;
  } catch (error) {
    if (unpublishedObjectPath) {
      await deleteExportObject(unpublishedObjectPath).catch(() => undefined);
      unpublishedObjectPath = null;
    }
    const cancelled = await isProductionJobCancellationRequested(
      job.id,
      workerId,
      leaseVersion,
    );
    if (cancelled) {
      await acknowledgeProductionJobCancellation(job.id, workerId, leaseVersion);
      if (exportId) {
        await db.update(musicArtifactsTable)
          .set({ state: "failed", size: "Cancelled" })
          .where(eq(musicArtifactsTable.id, exportId));
      }
      return;
    }
    const failed = await failProductionJob(job.id, workerId, leaseVersion, structuredJobError(error, "EXPORT_FAILED"));
    if (failed && exportId) {
      await db.update(musicArtifactsTable)
        .set({ state: "failed", size: "Failed" })
        .where(eq(musicArtifactsTable.id, exportId));
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

/** Claims all queued or expired export jobs; safe to call on an interval or after enqueue. */
export async function recoverExportProductionJobs(): Promise<void> {
  await recoverProductionJobs();
  const { productionJobsTable } = await import("@workspace/db");
  const jobs = await db.select({ id: productionJobsTable.id }).from(productionJobsTable)
    .where(eq(productionJobsTable.kind, "export"));
  await Promise.all(jobs.map(({ id }) => runExportProductionJob(id)));
}