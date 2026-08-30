import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Storage, type File } from "@google-cloud/storage";

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

async function signObjectUrl(
  bucketName: string,
  objectName: string,
  method: "GET" | "PUT",
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
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
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
}> {
  const relativePath = `uploads/${randomUUID()}`;
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDir()}/${relativePath}`,
  );
  return {
    uploadURL: await signObjectUrl(bucketName, objectName, "PUT"),
    objectPath: `/objects/${relativePath}`,
  };
}

export async function createSourceDownloadUrl(objectPath: string): Promise<string> {
  if (!objectPath.startsWith("/objects/uploads/")) {
    throw new Error("Invalid source object path");
  }
  const relativePath = objectPath.slice("/objects/".length);
  const { bucketName, objectName } = parseObjectPath(
    `${privateObjectDir()}/${relativePath}`,
  );
  return signObjectUrl(bucketName, objectName, "GET");
}

export async function getSourceObject(objectPath: string): Promise<File | null> {
  if (!objectPath.startsWith("/objects/uploads/")) return null;
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
