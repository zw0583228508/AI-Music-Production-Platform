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
