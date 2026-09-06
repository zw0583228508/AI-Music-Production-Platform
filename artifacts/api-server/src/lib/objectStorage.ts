import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { Storage, type File } from "@google-cloud/storage";
import { waitForProjectStorageRaceGate } from "./projectStorageRaceTestHook";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Invalid object storage path");
  }
  return {
    bucketName: parts[0],
    objectName: parts.slice(1).join("/"),
  };
}

function privateObjectDir(): string {
  const value = process.env.PRIVATE_OBJECT_DIR;
  if (!value) {
    throw new Error("PRIVATE_OBJECT_DIR is not configured");
  }
  return value.replace(/\/$/, "");
}

export function isSourceObjectPath(objectPath: string): boolean {
  return /^\/objects\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(objectPath);
}

export function isPrivateExportObjectPath(objectPath: string): boolean {
  const prefix = "/api/storage/objects/exports/";
  if (!objectPath.startsWith(prefix)) return false;
  const relativePath = objectPath.slice(prefix.length);
  return relativePath.length > 0 &&
    relativePath.split("/").every((part) =>
      Boolean(part) &&
      part !== "." &&
      part !== ".." &&
      /^[a-zA-Z0-9._-]+$/.test(part)
    );
}

async function signObjectUrl(
  bucketName: string,
  objectName: string,
  method: "GET" | "PUT",
  expiresAt = new Date(Date.now() + 15 * 60 * 1000),
): Promise<string> {
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method,
        expires_at: expiresAt.toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to create upload URL (${response.status})`);
  }
  const payload = await response.json() as { signed_url?: string };
  if (!payload.signed_url) throw new Error("Upload URL response was invalid");
  return payload.signed_url;
}

export async function createSourceUploadTarget(): Promise<{
  uploadURL: string;
  objectPath: string;
  expiresAt: Date;
}> {
  const relativePath = `uploads/${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const objectId = relativePath.slice("uploads/".length);
  return {
    uploadURL: `/api/storage/uploads/${objectId}`,
    objectPath: `/objects/${relativePath}`,
    expiresAt,
  };
}

export async function saveSourceUploadStream(
  objectPath: string,
  input: Readable,
  contentType: string,
): Promise<void> {
  if (!isSourceObjectPath(objectPath)) throw new Error("Invalid source object path");
  const relativePath = objectPath.slice("/objects/".length);
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDir()}/${relativePath}`,
  );
  const destination = objectStorageClient.bucket(bucketName).file(objectName)
    .createWriteStream({
      resumable: true,
      metadata: { contentType, cacheControl: "private, no-store" },
    });
  await waitForProjectStorageRaceGate("source-upload-write", objectPath);
  await pipeline(input, destination);
}

export async function createSourceDownloadUrl(objectPath: string): Promise<string> {
  if (!isSourceObjectPath(objectPath)) {
    throw new Error("Invalid source object path");
  }
  const relativePath = objectPath.slice("/objects/".length);
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDir()}/${relativePath}`,
  );
  return signObjectUrl(bucketName, objectName, "GET");
}

/** Creates a short-lived read URL only for a persisted private analysis artifact. */
export async function createAnalysisDownloadUrl(objectPath: string): Promise<string> {
  const prefix = "/objects/analysis/";
  if (!objectPath.startsWith(prefix)) {
    throw new Error("Invalid analysis object path");
  }
  const relativePath = objectPath.slice("/objects/".length);
  if (
    !relativePath ||
    !relativePath.split("/").every((part) =>
      Boolean(part) && part !== "." && part !== ".." &&
      /^[a-zA-Z0-9._-]+$/.test(part))
  ) {
    throw new Error("Invalid analysis object path");
  }
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDir()}/${relativePath}`,
  );
  return signObjectUrl(bucketName, objectName, "GET");
}

export async function createPrivateExportDownloadUrl(
  objectPath: string,
): Promise<string> {
  if (!isPrivateExportObjectPath(objectPath)) {
    throw new Error("Invalid private export object path");
  }
  const relativePath = objectPath.slice("/api/storage/objects/".length);
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDir()}/${relativePath}`,
  );
  return signObjectUrl(bucketName, objectName, "GET");
}

export async function getSourceObject(objectPath: string): Promise<File | null> {
  if (!isSourceObjectPath(objectPath)) return null;
  return getPrivateObject(objectPath.slice("/objects/".length));
}

export async function saveSourceProxyObject(
  sourceId: string,
  localPath: string,
  contentType: string,
): Promise<string> {
  const safeSourceId = sourceId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeSourceId) throw new Error("Invalid source id");
  if (contentType !== "audio/flac") {
    throw new Error("Source proxies must be lossless FLAC audio");
  }
  const relativePath = `proxies/${safeSourceId}.flac`;
  const fullPath = `${privateObjectDir()}/${relativePath}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const destination = objectStorageClient.bucket(bucketName).file(objectName)
    .createWriteStream({
      resumable: true,
      metadata: { contentType, cacheControl: "private, max-age=3600" },
    });
  await pipeline(createReadStream(localPath), destination);
  return `/objects/${relativePath}`;
}
export async function saveExportObject(
  relativePath: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const safePath = relativePath
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  const fullPath = `${privateObjectDir()}/exports/${safePath}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  await objectStorageClient.bucket(bucketName).file(objectName).save(data, {
    resumable: false,
    metadata: {
      contentType,
      cacheControl: "private, max-age=3600",
    },
  });
  return `/api/storage/objects/exports/${safePath}`;
}

export async function saveAnalysisObject(
  projectId: string,
  analysisJobId: string,
  fileName: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const safePart = (value: string): string =>
    value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "") || "item";
  const relativePath = [
    "analysis",
    safePart(projectId),
    safePart(analysisJobId),
    safePart(fileName),
  ].join("/");
  const fullPath = `${privateObjectDir()}/${relativePath}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  await objectStorageClient.bucket(bucketName).file(objectName).save(data, {
    resumable: false,
    metadata: {
      contentType,
      cacheControl: "private, no-store",
    },
  });
  return `/objects/${relativePath}`;
}
export async function getPrivateObject(
  wildcardPath: string,
): Promise<File | null> {
  const safePath = wildcardPath
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  const fullPath = `${privateObjectDir()}/${safePath}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  return exists ? file : null;
}

export async function deleteExportObject(downloadUrl: string): Promise<void> {
  const prefix = "/api/storage/objects/";
  if (!downloadUrl.startsWith(`${prefix}exports/`)) return;
  const file = await getPrivateObject(downloadUrl.slice(prefix.length));
  if (file) await file.delete({ ignoreNotFound: true });
}

type ExportObjectStore = Pick<Storage, "bucket">;

export type ExportReconciliationClassification =
  | "ready-reference"
  | "current-unreferenced-package"
  | "historical-download"
  | "provider-generated"
  | "unknown-export-object";

export type ExportObjectReclamationReport = {
  discovered: number;
  reclaimed: number;
  preservedReady: number;
  failedDeletions: number;
  reclaimedStorageUris: string[];
};

/**
 * Remove content-addressed packages left behind before an export artifact was
 * committed. The exact export-id prefix and checksum suffix keep other export
 * assets out of the recovery set, while ready paths are always retained.
 */
export async function reclaimIncompleteExportObjects(
  exportId: string,
  readyStorageUris: readonly string[],
  storage: ExportObjectStore = objectStorageClient,
): Promise<ExportObjectReclamationReport> {
  if (!/^[a-zA-Z0-9._-]+$/.test(exportId)) {
    throw new Error("Invalid export id");
  }
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDir()}/exports/${exportId}-`,
  );
  const [files] = await storage.bucket(bucketName).getFiles({
    prefix: objectName,
  });
  await waitForProjectStorageRaceGate("export-reclaim", exportId);
  const readyPaths = new Set(readyStorageUris);
  const exportsSegment = objectName.lastIndexOf("exports/");
  const objectPrefix = exportsSegment >= 0
    ? objectName.slice(0, exportsSegment)
    : "";
  const candidateName = new RegExp(
    `^${exportId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[a-f0-9]{64}\\.zip$`,
  );
  const report: ExportObjectReclamationReport = {
    discovered: 0,
    reclaimed: 0,
    preservedReady: 0,
    failedDeletions: 0,
    reclaimedStorageUris: [],
  };
  for (const file of files) {
    const relativeName = file.name.startsWith(objectPrefix)
      ? file.name.slice(objectPrefix.length)
      : "";
    const storageUri = `/api/storage/objects/${relativeName}`;
    const basename = relativeName.slice("exports/".length);
    if (!candidateName.test(basename)) continue;
    report.discovered += 1;
    if (readyPaths.has(storageUri)) {
      report.preservedReady += 1;
      continue;
    }
    try {
      await file.delete({ ignoreNotFound: true });
      report.reclaimed += 1;
      report.reclaimedStorageUris.push(storageUri);
    } catch {
      report.failedDeletions += 1;
    }
  }
  return report;
}

function privateObjectWildcard(objectPath: string): string | null {
  let wildcardPath: string | null = null;
  if (objectPath.startsWith("/objects/uploads/")) {
    wildcardPath = objectPath.slice("/objects/".length);
  } else if (objectPath.startsWith("/objects/proxies/")) {
    wildcardPath = objectPath.slice("/objects/".length);
  } else if (objectPath.startsWith("/objects/analysis/")) {
    wildcardPath = objectPath.slice("/objects/".length);
  } else if (objectPath.startsWith("/api/storage/objects/exports/")) {
    wildcardPath = objectPath.slice("/api/storage/objects/".length);
  }
  if (!wildcardPath) return null;
  const segments = wildcardPath.split("/");
  if (
    segments.some((segment) =>
      !segment ||
      segment === "." ||
      segment === ".." ||
      !/^[a-zA-Z0-9._-]+$/.test(segment)
    )
  ) {
    return null;
  }
  return wildcardPath;
}

export async function deletePrivateObject(objectPath: string): Promise<void> {
  const wildcardPath = privateObjectWildcard(objectPath);
  if (!wildcardPath) {
    throw new Error("Invalid private object path");
  }
  const file = await getPrivateObject(wildcardPath);
  if (file) await file.delete({ ignoreNotFound: true });
}

export async function deleteAnalysisObjects(
  projectId: string,
  analysisJobId: string,
): Promise<void> {
  const safePart = (value: string): string =>
    value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "") || "item";
  const relativePrefix = [
    "analysis",
    safePart(projectId),
    safePart(analysisJobId),
    "",
  ].join("/");
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDir()}/${relativePrefix}`,
  );
  await objectStorageClient.bucket(bucketName).deleteFiles({
    prefix: objectName,
    force: true,
  });
}

export type ExportReconciliationEntry = {
  storageUri: string;
  objectName: string;
  createdAt: string | null;
  ageMs: number | null;
  sizeBytes: number | null;
  classification: ExportReconciliationClassification;
  cleanupEligible: boolean;
  reason: string;
};

type ExportReconciliationStore = Pick<Storage, "bucket">;

export function canonicalExportStorageUri(reference: string): string | null {
  if (reference.startsWith("export-object://")) {
    const objectId = reference.slice("export-object://".length);
    return /^[a-zA-Z0-9._-]+$/.test(objectId)
      ? `/api/storage/objects/exports/${objectId}.zip`
      : null;
  }
  let pathname = reference;
  if (/^https?:\/\//.test(reference)) {
    try {
      pathname = new URL(reference).pathname;
    } catch {
      return null;
    }
  }
  return isPrivateExportObjectPath(pathname) ? pathname : null;
}

function exportStorageUri(objectName: string, exportPrefix: string): string | null {
  if (!objectName.startsWith(exportPrefix)) return null;
  const relativeName = objectName.slice(exportPrefix.length);
  return relativeName
    ? `/api/storage/objects/exports/${relativeName}`
    : null;
}

/**
 * Inventory every private export object and classify it without deleting bytes.
 * Only old, current content-addressed packages can enter the cleanup candidate
 * set. Historical downloads, provider outputs, ready references, and unknown
 * formats are preservation-only.
 */
export async function reportUnreferencedExportObjects(
  readyStorageUris: readonly string[],
  minimumAgeMs: number,
  now = new Date(),
  storage: ExportReconciliationStore = objectStorageClient,
): Promise<ExportReconciliationReport> {
  if (!Number.isFinite(minimumAgeMs) || minimumAgeMs <= 0) {
    throw new Error("A positive export reconciliation minimum age is required");
  }
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDir()}/exports/`,
  );
  const exportPrefix = `${objectName}/`;
  const [files] = await storage.bucket(bucketName).getFiles({
    prefix: exportPrefix,
  });
  const readyPaths = new Set(
    readyStorageUris.flatMap((reference) => {
      const canonical = canonicalExportStorageUri(reference);
      return canonical ? [canonical] : [];
    }),
  );
  const entries: ExportReconciliationEntry[] = [];
  for (const file of files) {
    const storageUri = exportStorageUri(file.name, exportPrefix);
    if (!storageUri) continue;
    const [metadata] = await file.getMetadata();
    const createdAtValue = metadata.timeCreated;
    const createdAt = typeof createdAtValue === "string" &&
        Number.isFinite(Date.parse(createdAtValue))
      ? new Date(createdAtValue)
      : null;
    const ageMs = createdAt ? Math.max(0, now.getTime() - createdAt.getTime()) : null;
    const sizeValue = typeof metadata.size === "string"
      ? Number(metadata.size)
      : metadata.size;
    const sizeBytes = typeof sizeValue === "number" && Number.isFinite(sizeValue)
      ? sizeValue
      : null;
    const classified = classifyExportObject(storageUri, readyPaths);
    const cleanupEligible = classified.classification ===
        "current-unreferenced-package" &&
      ageMs !== null &&
      ageMs >= minimumAgeMs;
    entries.push({
      storageUri,
      objectName: file.name,
      createdAt: createdAt?.toISOString() ?? null,
      ageMs,
      sizeBytes,
      ...classified,
      cleanupEligible,
      reason: cleanupEligible
        ? `${classified.reason}; older than the explicit cleanup threshold`
        : classified.classification === "current-unreferenced-package"
          ? `${classified.reason}; too new or missing a trustworthy creation time`
          : classified.reason,
    });
  }
  entries.sort((left, right) => left.storageUri.localeCompare(right.storageUri));
  return {
    generatedAt: now.toISOString(),
    minimumAgeMs,
    dryRun: true,
    entries,
    cleanupCandidates: entries
      .filter((entry) => entry.cleanupEligible)
      .map((entry) => entry.storageUri),
  };
}

function classifyExportObject(
  storageUri: string,
  readyStorageUris: ReadonlySet<string>,
): Pick<ExportReconciliationEntry, "classification" | "reason"> {
  if (readyStorageUris.has(storageUri)) {
    return {
      classification: "ready-reference",
      reason: "Referenced by a ready artifact and must be preserved",
    };
  }
  const relativeName = storageUri.slice("/api/storage/objects/exports/".length);
  if (relativeName.startsWith("generation/")) {
    return {
      classification: "provider-generated",
      reason: "Generation audio, MIDI, and quality evidence are never reconciled as export packages",
    };
  }
  if (/^[a-zA-Z0-9._-]+-[a-f0-9]{64}\.zip$/.test(relativeName)) {
    return {
      classification: "current-unreferenced-package",
      reason: "Current content-addressed export package without a ready artifact reference",
    };
  }
  if (
    /^[a-zA-Z0-9._-]+\.zip$/.test(relativeName) ||
    relativeName.startsWith("export-object://")
  ) {
    return {
      classification: "historical-download",
      reason: "Supported historical export package naming is preserved for existing downloads",
    };
  }
  return {
    classification: "unknown-export-object",
    reason: "Unrecognized or manually produced export object requires manual investigation",
  };
}

export type ExportReconciliationReport = {
  generatedAt: string;
  minimumAgeMs: number;
  dryRun: true;
  entries: ExportReconciliationEntry[];
  cleanupCandidates: string[];
};

/**
 * Delete only the exact candidate set approved from a prior dry-run report.
 * A fresh inventory rechecks references, classification, and age before delete.
 */
export async function cleanupReviewedExportObjects(options: {
  readyStorageUris: readonly string[];
  minimumAgeMs: number;
  reviewedCandidates: readonly string[];
  dryRunReviewed: boolean;
  now?: Date;
  storage?: ExportReconciliationStore;
}): Promise<string[]> {
  if (!options.dryRunReviewed) {
    throw new Error("Export cleanup requires an explicitly reviewed dry-run report");
  }
  const reviewed = new Set(options.reviewedCandidates);
  if (reviewed.size === 0 || reviewed.size !== options.reviewedCandidates.length) {
    throw new Error("Export cleanup requires a non-empty, unique reviewed candidate list");
  }
  const storage = options.storage ?? objectStorageClient;
  const report = await reportUnreferencedExportObjects(
    options.readyStorageUris,
    options.minimumAgeMs,
    options.now,
    storage,
  );
  const eligible = new Map(
    report.entries
      .filter((entry) => entry.cleanupEligible)
      .map((entry) => [entry.storageUri, entry]),
  );
  if (
    reviewed.size !== eligible.size ||
    [...reviewed].some((storageUri) => !eligible.has(storageUri))
  ) {
    throw new Error("Reviewed export candidates no longer match the fresh dry-run report");
  }
  const deleted: string[] = [];
  for (const storageUri of options.reviewedCandidates) {
    const entry = eligible.get(storageUri);
    if (!entry) continue;
    await storage.bucket(parseObjectPath(privateObjectDir()).bucketName)
      .file(entry.objectName)
      .delete({ ignoreNotFound: true });
    deleted.push(storageUri);
  }
  return deleted;
}
