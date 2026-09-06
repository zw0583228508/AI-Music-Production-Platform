import { verify } from "node:crypto";

const GPU_ATTESTED_PROVIDER_IDS = new Set([
  "ACE_STEP",
  "BS_ROFORMER",
  "ALL_IN_ONE",
  "MT3",
  "MR_MT3",
  "YOUR_MT3",
  "SYMPHONYGEN",
  "METEOR",
  "ANYACCOMP",
  "LADA_BAND",
  "HAFM",
  "BEAT_THIS",
]);

const MODAL_PROMOTED_PROVIDER_IDS = new Set([
  "ACE_STEP",
  "BS_ROFORMER",
  "ALL_IN_ONE",
  "MT3",
  "MR_MT3",
  "YOUR_MT3",
  "LADA_BAND",
  "HAFM",
  "BEAT_THIS",
]);

export const GPU_PROMOTION_SCHEMA_VERSION = 1;

export type GpuPromotionRuntimePins = {
  python: string;
  cudaImage: string;
  cuda: string;
  pytorch: string;
  torchvision: string;
  torchaudio: string;
  torchIndexUrl: string;
  transformers: string;
  accelerate: string;
};

export type GpuPromotionRecord = {
  schemaVersion: 1;
  provider: string;
  modalAppId: string;
  modalDeploymentId: string;
  modalFunctionId: string;
  modalImageId: string;
  endpointOrigin: string;
  modelVersion: string;
  checkpointSha256: string;
  checkpointRevision: string;
  sourceRevision: string;
  sourceImageDigest: string;
  runtime: GpuPromotionRuntimePins;
};

type PromotionBundle = {
  record: GpuPromotionRecord;
  signature: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalGpuPromotionJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalGpuPromotionJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalGpuPromotionJson(record[key])}`).join(",")}}`;
}

function promotionEnvKey(providerId: string): string {
  return providerId.replace(/[^A-Z0-9]/g, "_");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.trim().length <= 512;
}

function validOrigin(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.hostname === "127.0.0.1" ||
      url.hostname === "localhost") &&
      url.username === "" && url.password === "" &&
      url.pathname === "/" && url.search === "" && url.hash === "" &&
      value === url.origin;
  } catch {
    return false;
  }
}

function parsePromotionRecord(value: unknown, providerId: string): GpuPromotionRecord | null {
  if (!isRecord(value) || value.schemaVersion !== GPU_PROMOTION_SCHEMA_VERSION ||
      value.provider !== providerId || !nonEmptyString(value.modalAppId) ||
      !nonEmptyString(value.modalDeploymentId) || !nonEmptyString(value.modalFunctionId) ||
      typeof value.modalImageId !== "string" || !/^im-[A-Za-z0-9]+$/.test(value.modalImageId) ||
      !validOrigin(value.endpointOrigin) || !nonEmptyString(value.modelVersion) ||
      typeof value.checkpointSha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(value.checkpointSha256) ||
      !nonEmptyString(value.checkpointRevision) ||
      !nonEmptyString(value.sourceRevision) ||
      typeof value.sourceImageDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/i.test(value.sourceImageDigest) ||
      !isRecord(value.runtime)) {
    return null;
  }
  const runtimeKeys: Array<keyof GpuPromotionRuntimePins> = [
    "python", "cudaImage", "cuda", "pytorch", "torchvision",
    "torchaudio", "torchIndexUrl", "transformers", "accelerate",
  ];
  const runtime = value.runtime as Record<string, unknown>;
  if (runtimeKeys.some((key) => !nonEmptyString(runtime[key]))) return null;
  return {
    schemaVersion: 1,
    provider: providerId,
    modalAppId: value.modalAppId.trim(),
    modalDeploymentId: value.modalDeploymentId.trim(),
    modalFunctionId: value.modalFunctionId.trim(),
    modalImageId: value.modalImageId,
    endpointOrigin: value.endpointOrigin,
    modelVersion: value.modelVersion.trim(),
    checkpointSha256: value.checkpointSha256.toLowerCase(),
    checkpointRevision: value.checkpointRevision.trim(),
    sourceRevision: value.sourceRevision.trim(),
    sourceImageDigest: value.sourceImageDigest.toLowerCase(),
    runtime: Object.fromEntries(runtimeKeys.map((key) =>
      [key, runtime[key] as string])) as GpuPromotionRuntimePins,
  };
}

function promotionBundle(providerId: string): PromotionBundle | null {
  const key = promotionEnvKey(providerId);
  const bundleValue = process.env[`MUSIC_PROVIDER_${key}_PROMOTION_BUNDLE`]?.trim();
  if (!bundleValue) return null;
  try {
    const bundle = JSON.parse(bundleValue) as unknown;
    if (isRecord(bundle)) {
      const record = parsePromotionRecord(bundle.record, providerId);
      if (record && typeof bundle.signature === "string") {
        return { record, signature: bundle.signature.trim() };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function expectedGpuPromotionRecord(providerId: string): GpuPromotionRecord | null {
  return promotionBundle(providerId)?.record ?? null;
}

function promotionPublicKey(providerId: string): string | null {
  const providerKey = promotionEnvKey(providerId);
  const publicKey = (
    process.env[`MUSIC_PROVIDER_${providerKey}_PROMOTION_PUBLIC_KEY`] ??
    process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY ??
    process.env.MUSIC_GPU_PROMOTION_PUBLIC_KEY
  )?.trim();
  return publicKey || null;
}

function validPromotionSignature(record: GpuPromotionRecord, signature: string): boolean {
  const publicKey = promotionPublicKey(record.provider);
  if (!publicKey || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalGpuPromotionJson(record)),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

function originOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

/**
 * Verify the CI-signed deployment envelope and bind the health response to it.
 * A null return means the promotion is valid; the string is safe for health UI.
 */
export function gpuPromotionAttestationFailure(
  providerId: string,
  endpoint: string,
  payload: Record<string, unknown>,
): string | null {
  const bundle = promotionBundle(providerId);
  if (!bundle) return "GPU provider has no complete promoted deployment record.";
  if (!validPromotionSignature(bundle.record, bundle.signature)) {
    return "GPU provider promotion signature is missing or invalid.";
  }
  if (originOf(endpoint) !== bundle.record.endpointOrigin) {
    return "GPU provider endpoint origin does not match the promoted deployment.";
  }
  if (payload["provider"] !== providerId ||
      payload["modalAppId"] !== bundle.record.modalAppId ||
      payload["modalDeploymentId"] !== bundle.record.modalDeploymentId ||
      payload["modalFunctionId"] !== bundle.record.modalFunctionId ||
      payload["modelVersion"] !== bundle.record.modelVersion ||
      String(payload["checkpointSha256"] ?? payload["checksum"] ?? "").toLowerCase() !==
        bundle.record.checkpointSha256 ||
      String(payload["sourceImageDigest"] ?? payload["containerDigest"] ?? "").toLowerCase() !==
        bundle.record.sourceImageDigest ||
      payload["modalImageId"] !== bundle.record.modalImageId ||
      payload["revision"] !== bundle.record.checkpointRevision ||
      payload["sourceRevision"] !== bundle.record.sourceRevision) {
    return "GPU worker runtime identity does not match the promoted deployment record.";
  }
  const runtime = isRecord(payload["runtime"]) ? payload["runtime"] : {};
  const framework = isRecord(payload["framework"]) ? payload["framework"] :
    isRecord(payload["expectedRuntime"]) ? payload["expectedRuntime"] : {};
  const runtimeMatches = [
    ["python", runtime["pythonVersion"] ?? framework["python"], bundle.record.runtime.python],
    ["cudaImage", framework["cuda_image"], bundle.record.runtime.cudaImage],
    ["cuda", framework["cuda"], bundle.record.runtime.cuda],
    ["pytorch", framework["pytorch"], bundle.record.runtime.pytorch],
    ["torchvision", framework["torchvision"], bundle.record.runtime.torchvision],
    ["torchaudio", framework["torchaudio"], bundle.record.runtime.torchaudio],
    ["torchIndexUrl", framework["torch_index_url"], bundle.record.runtime.torchIndexUrl],
    ["transformers", framework["transformers"], bundle.record.runtime.transformers],
    ["accelerate", framework["accelerate"], bundle.record.runtime.accelerate],
  ].every(([, actual, expected]) => actual === expected);
  if (!runtimeMatches) return "GPU worker runtime pins do not match the promoted deployment record.";
  return null;
}

export function isGpuAttestedProvider(providerId: string): boolean {
  return GPU_ATTESTED_PROVIDER_IDS.has(providerId);
}

export function requiresGpuPromotionRecord(providerId: string): boolean {
  return MODAL_PROMOTED_PROVIDER_IDS.has(providerId);
}

export function expectedGpuCheckpointSha256(providerId: string): string | null {
  if (requiresGpuPromotionRecord(providerId)) {
    return expectedGpuPromotionRecord(providerId)?.checkpointSha256 ?? null;
  }
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  const value = (
    process.env[`MUSIC_PROVIDER_${key}_CHECKPOINT_SHA256`] ??
    process.env[`${key}_CHECKPOINT_SHA256`]
  )?.trim();
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

export function expectedGpuModalImageId(providerId: string): string | null {
  if (requiresGpuPromotionRecord(providerId)) {
    return expectedGpuPromotionRecord(providerId)?.modalImageId ?? null;
  }
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  const value = process.env[`MUSIC_PROVIDER_${key}_MODAL_IMAGE_ID`]?.trim();
  return typeof value === "string" && /^im-[A-Za-z0-9]+$/.test(value)
    ? value
    : null;
}

/** The registry version is the deployment pin. An explicit env value may only
 * repeat it; it cannot be used to silently select a different model. */
export function expectedGpuModelVersion(
  providerId: string,
  registryVersion: string,
): string | null {
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  const configured = (
    process.env[`MUSIC_PROVIDER_${key}_MODEL_VERSION`] ??
    process.env[`${key}_MODEL_VERSION`]
  )?.trim();
  return configured && configured !== registryVersion ? null : registryVersion;
}

/** Source-build hash retained as a compatibility check; this is not the
 * deployed Modal/OCI runtime identity. */
export function expectedGpuSourceImageDigest(providerId: string): string | null {
  if (requiresGpuPromotionRecord(providerId)) {
    return expectedGpuPromotionRecord(providerId)?.sourceImageDigest ?? null;
  }
  const key = providerId.replace(/[^A-Z0-9]/g, "_");
  const value = (
    process.env[`MUSIC_PROVIDER_${key}_SOURCE_IMAGE_DIGEST`] ??
    process.env[`MUSIC_PROVIDER_${key}_CONTAINER_DIGEST`] ??
    process.env[`${key}_CONTAINER_DIGEST`]
  )?.trim();
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

/** @deprecated Use expectedGpuSourceImageDigest. Kept for configuration API
 * compatibility with the former container-digest terminology. */
export const expectedGpuContainerDigest = expectedGpuSourceImageDigest;

export function anyAccompCommercialUseAuthorized(): boolean {
  return process.env.MUSIC_PROVIDER_ANYACCOMP_COMMERCIAL_USE_AUTHORIZED === "true" ||
    process.env.ANYACCOMP_COMMERCIAL_USE_AUTHORIZED === "true";
}