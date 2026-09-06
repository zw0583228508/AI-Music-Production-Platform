import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db, musicArtifactsTable } from "@workspace/db";
import {
  cleanupReviewedExportObjects,
  canonicalExportStorageUri,
  deleteExportObject,
  getPrivateObject,
  reportUnreferencedExportObjects,
  type ExportReconciliationReport,
} from "./objectStorage";
import { logger } from "./logger";

async function deleteArtifactBytes(storageUri: string | null, url: string | null): Promise<void> {
  const location = storageUri ?? url;
  if (!location) return;
  if (location.startsWith("export-object://")) {
    const storageObjectId = location.slice("export-object://".length);
    if (!/^[a-zA-Z0-9._-]+$/.test(storageObjectId)) {
      throw new Error("Invalid legacy export object identifier");
    }
    await deleteExportObject(
      `/api/storage/objects/exports/${storageObjectId}.zip`,
    );
    return;
  }
  if (location.startsWith("/api/storage/objects/exports/")) {
    await deleteExportObject(location);
    return;
  }
  if (location.startsWith("/objects/")) {
    const object = await getPrivateObject(location.slice("/objects/".length));
    if (object) await object.delete({ ignoreNotFound: true });
  }
}

/**
 * Deletes only bytes whose explicit retention deadline has passed. The
 * database row remains as an immutable lineage tombstone.
 */
export async function cleanupExpiredArtifacts(now = new Date()): Promise<number> {
  const expired = await db
    .select()
    .from(musicArtifactsTable)
    .where(and(
      isNotNull(musicArtifactsTable.expiresAt),
      lte(musicArtifactsTable.expiresAt, now),
      eq(musicArtifactsTable.immutable, true),
    ));
  let cleaned = 0;
  for (const artifact of expired) {
    try {
      await deleteArtifactBytes(artifact.storageUri, artifact.url);
      const [updated] = await db
        .update(musicArtifactsTable)
        .set({
          state: "expired",
          url: null,
          storageUri: null,
          technicalMetadata: {
            ...artifact.technicalMetadata,
            retainedLineage: true,
          },
        })
        .where(and(
          eq(musicArtifactsTable.id, artifact.id),
          eq(musicArtifactsTable.state, artifact.state),
        ))
        .returning({ id: musicArtifactsTable.id });
      if (updated) cleaned += 1;
    } catch (error) {
      logger.warn({ err: error, artifactId: artifact.id }, "artifact_retention_cleanup_failed");
    }
  }
  return cleaned;
}

async function readyArtifactStorageUris(): Promise<string[]> {
  return (await db.select({
    storageUri: musicArtifactsTable.storageUri,
    url: musicArtifactsTable.url,
  }).from(musicArtifactsTable).where(eq(musicArtifactsTable.state, "ready")))
    .flatMap(({ storageUri, url }) => [storageUri, url])
    .flatMap((reference) => {
      const canonical = reference ? canonicalExportStorageUri(reference) : null;
      return canonical ? [canonical] : [];
    });
}

export async function reportHistoricalExportLeftovers(
  minimumAgeMs: number,
  now = new Date(),
): Promise<ExportReconciliationReport> {
  return reportUnreferencedExportObjects(
    await readyArtifactStorageUris(),
    minimumAgeMs,
    now,
  );
}

export async function cleanupHistoricalExportLeftovers(options: {
  minimumAgeMs: number;
  reviewedCandidates: readonly string[];
  dryRunReviewed: boolean;
  now?: Date;
}): Promise<string[]> {
  return cleanupReviewedExportObjects({
    ...options,
    readyStorageUris: await readyArtifactStorageUris(),
  });
}

export function startArtifactRetentionScheduler(
  intervalMs = 60 * 60_000,
): () => void {
  const run = () => {
    void cleanupExpiredArtifacts().then((count) => {
      if (count > 0) logger.info({ count }, "artifact_retention_cleanup_complete");
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}