import type { AnalysisSection, SongModelData } from "@workspace/db";
import { attestAnalysisProviderHealth } from "./analysisProviderManifest";
import {
  isAttestedGpuProviderStartup,
  requiresGpuPromotionRecord,
} from "./gpuProviderAttestation";
import { isSheetSageCapacityAdmissionRejection } from "./sheetSageCapacityRate";

type ProviderProvenance = SongModelData["providerProvenance"][number];
type MelodyNote = SongModelData["melody"][number];
type ChordEvent = SongModelData["chords"][number];
type BeatEvent = SongModelData["beats"][number];
type BarEvent = SongModelData["bars"][number];
type TempoEvent = SongModelData["tempoMap"][number];
type MeterEvent = SongModelData["meterMap"][number];

export type AnalysisProviderId =
  | "BS_ROFORMER"
  | "DEMUCS"
  | "ALL_IN_ONE"
  | "BASIC_PITCH"
  | "MT3"
  | "MR_MT3"
  | "YOUR_MT3"
  | "SHEETSAGE"
  | "CHROMA"
  | "MADMOM"
  | "BEAT_THIS"
  | "TORCHCREPE"
  | "ESSENTIA"
  | "PYLOUDNORM"
  | "BASS";

export type ProviderStem = {
  role: string;
  confidence: number;
  contentType: string;
  extension: string;
  contentBase64?: string;
  downloadUrl?: string;
};

export type SeparationAnalysisResult = {
  providerId: "BS_ROFORMER" | "DEMUCS";
  version: string;
  stems: ProviderStem[];
  confidence: number;
};

export type StructureAnalysisResult = {
  providerId: "ALL_IN_ONE";
  version: string;
  bpm: number;
  meter: string;
  tempoMap: TempoEvent[];
  meterMap: MeterEvent[];
  beats: BeatEvent[];
  bars: BarEvent[];
  sections: AnalysisSection[];
  confidence: number;
};

export type TranscriptionAnalysisResult = {
  providerId: "BASIC_PITCH" | "MT3" | "MR_MT3" | "YOUR_MT3" | "SHEETSAGE";
  version: string;
  notes: MelodyNote[];
  confidence: number;
};

type ChromaFrame = {
  start: number;
  end: number;
  values: number[];
  confidence: number;
};

type BassNote = {
  start: number;
  end: number;
  pitch: number;
  confidence: number;
};

export type HarmonyAnalysisResult = {
  providerId: "SHEETSAGE" | "CHROMA" | "BASS";
  version: string;
  candidates: ChordEvent[];
  chroma: ChromaFrame[];
  bass: BassNote[];
  confidence: number;
};

export type AnalysisProviderResults = {
  separation: SeparationAnalysisResult | null;
  structure: StructureAnalysisResult | null;
  transcriptions: TranscriptionAnalysisResult[];
  harmony: HarmonyAnalysisResult[];
  chords: ChordEvent[];
  bassEvidence: Array<{
    start: number;
    end: number;
    pitch: number;
    confidence: number;
    provider?: string;
    sourceStem?: string;
    sourceStemProvider?: string;
    providers?: string[];
  }>;
  harmonyConfidence: number;
  rhythmEvidence: Array<{
    provider: "MADMOM" | "BEAT_THIS";
    version: string;
    beats: number[];
    downbeats: number[];
    tempoBpm: number;
  }>;
  timingEvidence: Array<{
    provider: "SHEETSAGE";
    version: string;
    events: Array<{
      start: number;
      end: number;
      beat: number;
    }>;
  }>;
  pitchEvidence: Array<{
    provider: "TORCHCREPE";
    version: string;
    sourceStem: string;
    frames: Array<{
      time: number;
      frequencyHz: number;
      midiPitch: number | null;
      periodicity: number;
      voiced: boolean;
      confidence: number;
    }>;
  }>;
  keyEvidence: Array<{
    provider: "ESSENTIA";
    version: string;
    key: string;
    scale: string;
    confidence: number;
    hpcp: number[];
  }>;
  loudness: {
    provider: "PYLOUDNORM";
    version: string;
    integratedLUFS: number;
    loudnessRange: number;
    samplePeak: number;
  } | null;
  provenance: ProviderProvenance[];
};

type AnalysisProviderInput = {
  sourceUrl: string | null;
  sourceType: string;
  durationSeconds: number;
  idempotencyKey?: string;
  onSheetSageCapacityRejection?: (analysisKey: string) => Promise<void>;
};

class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly attempts: number,
  ) {
    super(message);
  }
}

class ProviderStartupTimeoutError extends Error {}

const MAX_PROVIDER_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const MAX_HEALTH_STARTUP_ATTEMPTS = 6;
const HEALTH_STARTUP_RETRY_DELAY_MS = 5_000;
const ANALYSIS_HEALTH_TTL_MS = 30_000;
const MIR_PROVIDER_IDS = new Set<AnalysisProviderId>([
  "MADMOM",
  "ESSENTIA",
  "CHROMA",
  "TORCHCREPE",
  "PYLOUDNORM",
]);
const LICENSE_BLOCKED_PROVIDER_IDS = new Set<AnalysisProviderId>([
  "BS_ROFORMER",
]);
const analysisHealthCache = new Map<string, {
  expiresAt: number;
  error: ProviderRequestError | null;
  version?: string;
}>();

export const configuredAnalysisProviderEndpoint = (providerId: AnalysisProviderId): string | null => {
  if (LICENSE_BLOCKED_PROVIDER_IDS.has(providerId)) {
    return null;
  }
  if (
    providerId === "SHEETSAGE" &&
    process.env.SHEETSAGE_LICENSE_AUTHORIZED !== "true"
  ) {
    return null;
  }
  const mirGroup = ["MADMOM", "TORCHCREPE", "PYLOUDNORM"].includes(providerId)
    ? "MUSIC_MIR"
    : ["ESSENTIA", "CHROMA"].includes(providerId)
      ? "MUSIC_MIR_ESSENTIA"
      : null;
  const aliases = providerId === "SHEETSAGE"
    ? ["SHEETSAGE_API_URL", "SHEET_SAGE_API_URL"]
    : [
        `MUSIC_PROVIDER_${providerId}_URL`,
        `${providerId}_API_URL`,
        ...(mirGroup ? [`${mirGroup}_API_URL`] : []),
      ];
  return aliases
    .map((name) => process.env[name]?.trim())
    .find((value): value is string => Boolean(value)) ?? null;
};

const providerToken = (providerId: AnalysisProviderId): string | undefined => {
  if (providerId === "BS_ROFORMER") {
    return undefined;
  }
  if (providerId === "SHEETSAGE") {
    return process.env.SHEETSAGE_API_TOKEN ??
      process.env.SHEET_SAGE_API_TOKEN ??
      process.env.MUSIC_AI_WORKER_TOKEN;
  }
  return process.env[`MUSIC_PROVIDER_${providerId}_TOKEN`] ??
    process.env[`${providerId}_API_TOKEN`] ??
    (["BASIC_PITCH", "DEMUCS", "MADMOM", "TORCHCREPE", "ESSENTIA", "CHROMA", "PYLOUDNORM", "BEAT_THIS"].includes(providerId)
      ? process.env.MUSIC_AI_WORKER_TOKEN
      : undefined);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function confidence(value: unknown, label: string): number {
  if (!finiteNumber(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

const MAX_EVIDENCE_ITEMS = 64;
const MAX_EVIDENCE_TEXT_LENGTH = 512;

function evidenceString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_EVIDENCE_TEXT_LENGTH) {
    throw new Error(`${label} must be between 1 and ${MAX_EVIDENCE_TEXT_LENGTH} characters`);
  }
  return normalized;
}

function providerVersion(payload: Record<string, unknown>, providerId: string): string {
  const version = payload["version"];
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(`${providerId} response is missing its model version`);
  }
  return version.trim();
}

function providerAction(providerId: AnalysisProviderId): string {
  return providerId === "BS_ROFORMER" || providerId === "DEMUCS"
    ? "separate"
    : "analyze";
}

function providerRequestUrl(endpoint: string, action: string): URL {
  const url = new URL(endpoint);
  if (url.pathname === "/" || url.pathname.endsWith("/")) {
    return new URL(action, url);
  }
  return url;
}

function adaptProviderPayload(providerId: AnalysisProviderId, payload: unknown): unknown {
  if (
    ["MADMOM", "BEAT_THIS", "TORCHCREPE", "ESSENTIA", "CHROMA", "PYLOUDNORM"].includes(providerId)
  ) {
    if (!isRecord(payload) || payload["provider"] !== providerId ||
      payload["status"] !== "ok" || !isRecord(payload["result"])) {
      throw new Error(`${providerId} response is missing its executed result envelope`);
    }
    return payload["result"];
  }
  return payload;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function nestedProviderRequestError(error: unknown): ProviderRequestError | null {
  let current = error;
  const visited = new Set<unknown>();
  while (current && !visited.has(current)) {
    if (current instanceof ProviderRequestError) return current;
    visited.add(current);
    current = isRecord(current) ? current["cause"] : null;
  }
  return null;
}

function providerRequestTimeoutMs(providerId: AnalysisProviderId): number {
  if (providerId === "PYLOUDNORM" || providerId === "ESSENTIA") return 2 * 60_000;
  if (providerId === "CHROMA" || providerId === "MADMOM" || providerId === "BEAT_THIS") return 5 * 60_000;
  if (providerId === "TORCHCREPE") return 8 * 60_000;
  return 10 * 60_000;
}

async function readProviderJson(
  providerId: AnalysisProviderId,
  response: Response,
): Promise<unknown> {
  const maxBytes = 32 * 1024 * 1024;
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    throw new ProviderRequestError(
      `${providerId} response exceeds the 32 MB contract limit`,
      "response-too-large",
      false,
      1,
    );
  }
  if (!response.body) {
    throw new ProviderRequestError(
      `${providerId} returned an empty response`,
      "empty-response",
      false,
      1,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new ProviderRequestError(
        `${providerId} response exceeds the 32 MB contract limit`,
        "response-too-large",
        false,
        1,
      );
    }
    json += decoder.decode(value, { stream: true });
  }
  json += decoder.decode();
  try {
    return JSON.parse(json);
  } catch {
    throw new ProviderRequestError(
      `${providerId} returned invalid JSON`,
      "invalid-json",
      false,
      1,
    );
  }
}

const MAX_SHEETSAGE_SOURCE_BYTES = 512 * 1024 * 1024;

async function openSheetSageSource(
  sourceUrl: string,
  signal: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; contentLength: number | null }> {
  const response = await fetch(sourceUrl, {
    signal,
  });
  if (!response.ok || !response.body) {
    throw new ProviderRequestError(
      `SheetSage source download returned HTTP ${response.status}`,
      "source-download-failed",
      retryableStatus(response.status),
      1,
    );
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_SHEETSAGE_SOURCE_BYTES) {
    await response.body.cancel();
    throw new ProviderRequestError(
      "SheetSage source exceeds the 512 MiB contract limit",
      "source-too-large",
      false,
      1,
    );
  }
  let bytes = 0;
  const boundedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_SHEETSAGE_SOURCE_BYTES) {
        controller.error(new ProviderRequestError(
          "SheetSage source exceeds the 512 MiB contract limit",
          "source-too-large",
          false,
          1,
        ));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return {
    body: boundedBody,
    contentType: response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "application/octet-stream",
    contentLength: declaredLength > 0 ? declaredLength : null,
  };
}
async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollProviderJob(
  providerId: AnalysisProviderId,
  endpoint: string,
  jobId: string,
  token: string | undefined,
): Promise<unknown> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await delay(250);
    const response = await fetch(
      new URL(`/jobs/${encodeURIComponent(jobId)}`, endpoint),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      if (retryableStatus(response.status)) continue;
      throw new ProviderRequestError(
        `${providerId} job returned HTTP ${response.status}`,
        `job-http-${response.status}`,
        false,
        1,
      );
    }
    const payload = await readProviderJson(providerId, response);
    if (!isRecord(payload)) {
      throw new ProviderRequestError(
        `${providerId} job response must be an object`,
        "job-contract-invalid",
        false,
        1,
      );
    }
    const status = typeof payload["status"] === "string"
      ? payload["status"].toLowerCase()
      : "";
    if (["completed", "succeeded", "ready"].includes(status)) {
      return payload["result"] ?? payload;
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      const detail = typeof payload["error"] === "string"
        ? `: ${payload["error"]}`
        : "";
      throw new ProviderRequestError(
        `${providerId} job ${status}${detail}`,
        `job-${status}`,
        false,
        1,
      );
    }
  }
  throw new ProviderRequestError(
    `${providerId} job timed out`,
    "job-timeout",
    true,
    1,
  );
}

async function attestProviderHealth(
  providerId: AnalysisProviderId,
  endpoint: string,
  token: string | undefined,
): Promise<string> {
  const promotionKey = providerId.replace(/[^A-Z0-9]/g, "_");
  const promotionIdentity = requiresGpuPromotionRecord(providerId)
    ? [
        process.env[`MUSIC_PROVIDER_${promotionKey}_PROMOTION_BUNDLE`] ?? "",
        process.env.MUSIC_PROVIDER_PROMOTION_PUBLIC_KEY ??
          process.env.MUSIC_GPU_PROMOTION_PUBLIC_KEY ?? "",
      ].join(":")
    : "";
  const cacheKey = `${providerId}:${endpoint}:${promotionIdentity}`;
  // Signed GPU identities can drift independently of this API process.
  // Never let a prior successful attestation authorize a later provider POST.
  const cacheHealth = (
    !MIR_PROVIDER_IDS.has(providerId)
    && !requiresGpuPromotionRecord(providerId)
  );
  if (cacheHealth) {
    const cached = analysisHealthCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.error) throw cached.error;
      return cached.version ?? "attested-runtime";
    }
  }
  try {
    const healthUrl = new URL("/health", endpoint);
    healthUrl.searchParams.set("provider", providerId);
    for (
      let attempt = 1;
      attempt <= MAX_HEALTH_STARTUP_ATTEMPTS;
      attempt += 1
    ) {
      const response = await fetch(healthUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`health check returned HTTP ${response.status}`);
      }
      const payload = await readProviderJson(providerId, response);
      if (
        isRecord(payload) &&
        isAttestedGpuProviderStartup(providerId, endpoint, payload)
      ) {
        if (attempt === MAX_HEALTH_STARTUP_ATTEMPTS) {
          throw new ProviderStartupTimeoutError(
            `${providerId} health remained in startup state`,
          );
        }
        await delay(HEALTH_STARTUP_RETRY_DELAY_MS);
        continue;
      }
      const attestation = attestAnalysisProviderHealth(
        providerId,
        payload,
        endpoint,
      );
      if (cacheHealth) {
        analysisHealthCache.set(cacheKey, {
          expiresAt: Date.now() + ANALYSIS_HEALTH_TTL_MS,
          error: null,
          version: attestation.version,
        });
      }
      return attestation.version;
    }
    throw new ProviderStartupTimeoutError(
      `${providerId} health remained in startup state`,
    );
  } catch (error) {
    const startupTimeout = error instanceof ProviderStartupTimeoutError;
    const attestationError = new ProviderRequestError(
      `${providerId} health attestation failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      startupTimeout
        ? "health-startup-timeout"
        : "health-attestation-failed",
      startupTimeout,
      startupTimeout ? MAX_HEALTH_STARTUP_ATTEMPTS : 0,
    );
    if (!startupTimeout && cacheHealth) {
      analysisHealthCache.set(cacheKey, {
        expiresAt: Date.now() + ANALYSIS_HEALTH_TTL_MS,
        error: attestationError,
      });
    }
    throw attestationError;
  }
}

async function requestProvider(
  providerId: AnalysisProviderId,
  input: AnalysisProviderInput,
): Promise<{ payload: unknown; attempts: number }> {
  const endpoint = configuredAnalysisProviderEndpoint(providerId);
  if (!endpoint) {
    throw new ProviderRequestError(
      `${providerId} is not configured`,
      "not-configured",
      false,
      0,
    );
  }
  if (!input.sourceUrl) {
    throw new ProviderRequestError(
      "A signed source URL could not be created",
      "source-unavailable",
      false,
      0,
    );
  }

  const token = providerToken(providerId);
  const reattestBeforeEveryPost = (
    MIR_PROVIDER_IDS.has(providerId)
    || requiresGpuPromotionRecord(providerId)
  );
  const initiallyAttestedVersion = reattestBeforeEveryPost
    ? null
    : await attestProviderHealth(providerId, endpoint, token);
  let lastError: ProviderRequestError | null = null;
  let sheetSageCapacityRejectionReported = false;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    try {
      const attestedVersion = reattestBeforeEveryPost
        ? await attestProviderHealth(providerId, endpoint, token)
        : initiallyAttestedVersion!;
      const signal = AbortSignal.timeout(providerRequestTimeoutMs(providerId));
      const sheetSageSource = providerId === "SHEETSAGE"
        ? await openSheetSageSource(input.sourceUrl, signal)
        : null;
      const requestBody = sheetSageSource?.body ?? JSON.stringify({
        provider: providerId,
        sourceUrl: input.sourceUrl,
        sourceType: input.sourceType,
        durationSeconds: input.durationSeconds,
      });
      const response = await fetch(
        providerRequestUrl(endpoint, providerAction(providerId)),
        {
          method: "POST",
          headers: {
            "Content-Type": sheetSageSource?.contentType ?? "application/json",
            ...(sheetSageSource?.contentLength
              ? { "Content-Length": String(sheetSageSource.contentLength) }
              : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(input.idempotencyKey
              ? { "Idempotency-Key": `${input.idempotencyKey}:${providerId}` }
              : {}),
          },
          body: requestBody,
          ...(sheetSageSource ? { duplex: "half" } : {}),
          signal,
        },
      );
      if (!response.ok) {
        if (isSheetSageCapacityAdmissionRejection(
          providerId,
          response.status,
          response.headers.get("x-sheetsage-rejection"),
        ) && !sheetSageCapacityRejectionReported && input.idempotencyKey) {
          sheetSageCapacityRejectionReported = true;
          await input.onSheetSageCapacityRejection?.(input.idempotencyKey);
        }
        const canRetry = retryableStatus(response.status);
        const error = new ProviderRequestError(
          `${providerId} returned HTTP ${response.status}`,
          `http-${response.status}`,
          canRetry,
          attempt,
        );
        if (!canRetry || attempt === MAX_PROVIDER_ATTEMPTS) throw error;
        lastError = error;
      } else {
        try {
          let payload = await readProviderJson(providerId, response);
          if (
            isRecord(payload) &&
            typeof payload["jobId"] === "string" &&
            payload["jobId"].trim()
          ) {
            const status = typeof payload["status"] === "string"
              ? payload["status"].toLowerCase()
              : "";
            if (
              response.status === 202 ||
              !["completed", "succeeded", "ready"].includes(status)
            ) {
              payload = await pollProviderJob(
                providerId,
                endpoint,
                payload["jobId"],
                token,
              );
            } else if (payload["result"] !== undefined) {
              payload = payload["result"];
            }
          }
          const adapted = adaptProviderPayload(providerId, payload);
          return {
            payload: isRecord(adapted) && typeof adapted["version"] !== "string"
              ? { ...adapted, version: attestedVersion }
              : adapted,
            attempts: attempt,
          };
        } catch (error) {
          if (error instanceof ProviderRequestError) {
            throw new ProviderRequestError(
              error.message,
              error.code,
              error.retryable,
              attempt,
            );
          }
          throw error;
        }
      }
    } catch (error) {
      const sourceError = nestedProviderRequestError(error);
      if (sourceError && !sourceError.retryable) {
        throw new ProviderRequestError(
          sourceError.message,
          sourceError.code,
          false,
          attempt,
        );
      }
      if (error instanceof ProviderRequestError && !error.retryable) throw error;
      const requestError = error instanceof ProviderRequestError
        ? error
        : new ProviderRequestError(
            `${providerId} request failed: ${error instanceof Error ? error.message : "unknown error"}`,
            error instanceof DOMException && error.name === "TimeoutError"
              ? "timeout"
              : "request-failed",
            true,
            attempt,
          );
      if (attempt === MAX_PROVIDER_ATTEMPTS) throw requestError;
      lastError = requestError;
    }
    await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }
  throw lastError ?? new ProviderRequestError(
    `${providerId} request failed`,
    "request-failed",
    true,
    MAX_PROVIDER_ATTEMPTS,
  );
}

function normalizeStemRole(value: string): string {
  const role = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    vocal: "lead_vocal",
    vocals: "lead_vocal",
    lead: "lead_vocal",
    lead_vocals: "lead_vocal",
    backing: "backing_vocals",
    backing_vocal: "backing_vocals",
    background_vocal: "backing_vocals",
    background_vocals: "backing_vocals",
    accompaniment: "instrumental",
    music: "instrumental",
  };
  const normalized = aliases[role] ?? role;
  if (!/^[a-z0-9_]{1,64}$/.test(normalized)) {
    throw new Error("Separation provider returned an invalid stem role");
  }
  return normalized;
}

function inferExtension(contentType: string): string {
  const extensions: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
  };
  return extensions[contentType.toLowerCase()] ?? "wav";
}

function parseStem(
  value: unknown,
  index: number,
  allowedOrigin: string,
  providerId: string,
  fallbackRole?: string,
): ProviderStem {
  if (!isRecord(value)) {
    throw new Error(`${providerId} stem ${index + 1} must be an object`);
  }
  const rawRole = value["role"] ?? value["name"] ?? fallbackRole;
  const rawConfidence = value["confidence"];
  const contentType = typeof value["contentType"] === "string"
    ? value["contentType"].trim().toLowerCase()
    : "audio/wav";
  const contentBase64 = value["contentBase64"] ?? value["audioBase64"] ?? value["data"];
  const downloadUrl = value["downloadUrl"] ?? value["url"];
  if (
    typeof rawRole !== "string" || !rawRole.trim() ||
    !finiteNumber(rawConfidence) || rawConfidence < 0 || rawConfidence > 1 ||
    !contentType.startsWith("audio/") ||
    (typeof contentBase64 !== "string" && typeof downloadUrl !== "string")
  ) {
    throw new Error(`${providerId} stem ${index + 1} is invalid`);
  }
  if (typeof downloadUrl === "string") {
    const artifactUrl = new URL(downloadUrl);
    if (
      !["https:", "http:"].includes(artifactUrl.protocol) ||
      artifactUrl.origin !== allowedOrigin
    ) {
      throw new Error(
        `${providerId} stem ${index + 1} must use the configured provider origin`,
      );
    }
  }
  return {
    role: normalizeStemRole(rawRole),
    confidence: rawConfidence,
    contentType,
    extension: typeof value["extension"] === "string"
      ? value["extension"].replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
      : inferExtension(contentType),
    ...(typeof contentBase64 === "string" ? { contentBase64 } : {}),
    ...(typeof downloadUrl === "string" ? { downloadUrl } : {}),
  };
}

export function parseSeparation(
  providerId: SeparationAnalysisResult["providerId"],
  payload: unknown,
): SeparationAnalysisResult {
  if (!isRecord(payload)) throw new Error(`${providerId} response must be an object`);
  const endpoint = configuredAnalysisProviderEndpoint(providerId);
  if (!endpoint) throw new Error(`${providerId} is not configured`);
  const allowedOrigin = new URL(endpoint).origin;
  const rawStems = payload["stems"];
  const stems = Array.isArray(rawStems)
    ? rawStems.map((value, index) =>
        parseStem(value, index, allowedOrigin, providerId))
    : isRecord(rawStems)
      ? Object.entries(rawStems).map(([role, value], index) =>
          parseStem(
            isRecord(value) ? value : { data: value, confidence: payload["confidence"] },
            index,
            allowedOrigin,
            providerId,
            role,
          ))
      : [];
  if (stems.length < 2) {
    throw new Error(`${providerId} must return at least two stems`);
  }
  const roles = stems.map((stem) => stem.role);
  if (new Set(roles).size !== roles.length) {
    throw new Error(`${providerId} returned duplicate stem roles`);
  }
  if (!roles.includes("lead_vocal") && !roles.includes("instrumental")) {
    throw new Error(`${providerId} did not return a vocal or instrumental stem`);
  }
  return {
    providerId,
    version: providerVersion(payload, providerId),
    stems,
    confidence: confidence(payload["confidence"], `${providerId} confidence`),
  };
}

function parseTempoMap(
  payload: Record<string, unknown>,
  durationSeconds: number,
  fallbackBpm: unknown,
  fallbackConfidence: number,
): TempoEvent[] {
  const rawTempoMap = payload["tempoMap"];
  const tempoMap = Array.isArray(rawTempoMap)
    ? rawTempoMap.map((value, index): TempoEvent => {
        if (!isRecord(value)) {
          throw new Error(`ALL_IN_ONE tempo event ${index + 1} must be an object`);
        }
        const time = value["time"];
        const bpm = value["bpm"];
        const itemConfidence = value["confidence"];
        if (
          !finiteNumber(time) || time < 0 || time > durationSeconds ||
          !finiteNumber(bpm) || bpm < 20 || bpm > 400 ||
          !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
        ) {
          throw new Error(`ALL_IN_ONE tempo event ${index + 1} is invalid`);
        }
        return { time, bpm, confidence: itemConfidence };
      })
    : finiteNumber(fallbackBpm)
      ? [{ time: 0, bpm: fallbackBpm, confidence: fallbackConfidence }]
      : [];
  if (!tempoMap.length || tempoMap[0].time !== 0) {
    throw new Error("ALL_IN_ONE tempo map must begin at time 0");
  }
  if (tempoMap.some((event, index) =>
    index > 0 && event.time <= tempoMap[index - 1].time
  )) {
    throw new Error("ALL_IN_ONE tempo map must be strictly ordered");
  }
  return tempoMap;
}

function parseMeterMap(
  payload: Record<string, unknown>,
  fallbackMeter: unknown,
  fallbackConfidence: number,
): MeterEvent[] {
  const rawMeterMap = payload["meterMap"];
  const meterMap = Array.isArray(rawMeterMap)
    ? rawMeterMap.map((value, index): MeterEvent => {
        if (!isRecord(value)) {
          throw new Error(`ALL_IN_ONE meter event ${index + 1} must be an object`);
        }
        const bar = value["bar"];
        const meter = value["meter"];
        const itemConfidence = value["confidence"];
        if (
          !integer(bar) || bar < 1 ||
          typeof meter !== "string" || !/^[1-9]\d*\/[1-9]\d*$/.test(meter) ||
          !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
        ) {
          throw new Error(`ALL_IN_ONE meter event ${index + 1} is invalid`);
        }
        return { bar, meter, confidence: itemConfidence };
      })
    : typeof fallbackMeter === "string"
      ? [{ bar: 1, meter: fallbackMeter, confidence: fallbackConfidence }]
      : [];
  if (!meterMap.length || meterMap[0].bar !== 1) {
    throw new Error("ALL_IN_ONE meter map must begin at bar 1");
  }
  if (meterMap.some((event, index) =>
    index > 0 && event.bar <= meterMap[index - 1].bar
  )) {
    throw new Error("ALL_IN_ONE meter map must be strictly ordered");
  }
  return meterMap;
}

function parseStructure(payload: unknown, durationSeconds: number): StructureAnalysisResult {
  if (!isRecord(payload)) throw new Error("ALL_IN_ONE response must be an object");
  const overallConfidence = confidence(
    payload["confidence"],
    "ALL_IN_ONE confidence",
  );
  const tempoMap = parseTempoMap(
    payload,
    durationSeconds,
    payload["bpm"],
    overallConfidence,
  );
  const meterMap = parseMeterMap(
    payload,
    payload["meter"],
    overallConfidence,
  );
  const rawBeats = payload["beats"];
  const rawSections = payload["sections"];
  if (!Array.isArray(rawBeats) || !rawBeats.length) {
    throw new Error("ALL_IN_ONE response must include beats");
  }
  if (!Array.isArray(rawSections) || !rawSections.length) {
    throw new Error("ALL_IN_ONE response must include labeled sections");
  }

  const beats = rawBeats.map((value, index): BeatEvent => {
    if (!isRecord(value)) throw new Error(`ALL_IN_ONE beat ${index + 1} must be an object`);
    const time = value["time"];
    const beat = value["beat"];
    const bar = value["bar"];
    const itemConfidence = value["confidence"];
    if (
      !finiteNumber(time) || time < 0 || time > durationSeconds + 1 ||
      !integer(beat) || beat < 1 ||
      !integer(bar) || bar < 1 ||
      !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
    ) {
      throw new Error(`ALL_IN_ONE beat ${index + 1} is invalid`);
    }
    return { time, beat, bar, confidence: itemConfidence };
  });
  if (beats.some((beat, index) => index > 0 && beat.time <= beats[index - 1].time)) {
    throw new Error("ALL_IN_ONE beats must be strictly ordered");
  }
  for (let index = 0; index < beats.length; index += 1) {
    const beat = beats[index];
    const previous = beats[index - 1];
    const activeMeter = [...meterMap]
      .reverse()
      .find((event) => event.bar <= beat.bar)?.meter ?? meterMap[0].meter;
    const beatsPerBar = Number.parseInt(activeMeter.split("/")[0], 10);
    if (beat.beat > beatsPerBar) {
      throw new Error("ALL_IN_ONE beat ordinals must match the declared meter");
    }
    if (!previous) {
      if (beat.bar !== 1 || beat.beat !== 1) {
        throw new Error("ALL_IN_ONE beats must begin at bar 1, beat 1");
      }
      continue;
    }
    if (beat.bar === previous.bar) {
      if (beat.beat !== previous.beat + 1) {
        throw new Error("ALL_IN_ONE beats must be sequential within each bar");
      }
    } else if (beat.bar !== previous.bar + 1 || beat.beat !== 1) {
      throw new Error("ALL_IN_ONE bars must be sequential");
    }
  }

  const rawDownbeats = payload["downbeats"];
  if (rawDownbeats !== undefined) {
    if (!Array.isArray(rawDownbeats)) {
      throw new Error("ALL_IN_ONE downbeats must be an array");
    }
    const downbeatTimes = rawDownbeats.map((value, index) => {
      const time = isRecord(value) ? value["time"] : value;
      if (!finiteNumber(time) || time < 0 || time > durationSeconds + 1) {
        throw new Error(`ALL_IN_ONE downbeat ${index + 1} is invalid`);
      }
      return time;
    });
    const canonicalDownbeats = beats.filter((beat) => beat.beat === 1);
    if (
      downbeatTimes.length !== canonicalDownbeats.length ||
      downbeatTimes.some((time, index) =>
        Math.abs(time - canonicalDownbeats[index].time) > 0.05
      )
    ) {
      throw new Error("ALL_IN_ONE downbeats do not match its beat grid");
    }
  }

  const finalBarNumber = beats[beats.length - 1].bar;
  const sections = rawSections.map((value, index): AnalysisSection => {
    if (!isRecord(value)) throw new Error(`ALL_IN_ONE section ${index + 1} must be an object`);
    const name = value["name"] ?? value["label"];
    const startBar = value["startBar"];
    const endBar = value["endBar"];
    const energy = value["energy"];
    if (
      typeof name !== "string" || !name.trim() ||
      !integer(startBar) || startBar < 1 ||
      !integer(endBar) || endBar < startBar ||
      !finiteNumber(energy) || energy < 0 || energy > 1
    ) {
      throw new Error(`ALL_IN_ONE section ${index + 1} is invalid`);
    }
    return { name: name.trim(), startBar, endBar, energy };
  });
  if (sections.some((section, index) =>
    index > 0 && section.startBar <= sections[index - 1].endBar
  )) {
    throw new Error("ALL_IN_ONE sections must be ordered and non-overlapping");
  }
  if (sections.some((section) => section.endBar > finalBarNumber)) {
    throw new Error("ALL_IN_ONE sections must stay within returned bar bounds");
  }

  const barsByNumber = new Map<number, BeatEvent[]>();
  for (const beat of beats) {
    const current = barsByNumber.get(beat.bar) ?? [];
    current.push(beat);
    barsByNumber.set(beat.bar, current);
  }
  const barGroups = [...barsByNumber.entries()];
  const bars = barGroups.map(([bar, barBeats], index): BarEvent => {
    const nextBar = barGroups[index + 1]?.[1];
    const start = barBeats[0].time;
    const activeTempo = [...tempoMap]
      .reverse()
      .find((event) => event.time <= start)?.bpm ?? tempoMap[0].bpm;
    const activeMeter = [...meterMap]
      .reverse()
      .find((event) => event.bar <= bar)?.meter ?? meterMap[0].meter;
    const expectedBeats = Number.parseInt(activeMeter.split("/")[0], 10);
    const fallbackEnd = start + (60 / activeTempo) * expectedBeats;
    const end = Math.min(durationSeconds, nextBar?.[0].time ?? fallbackEnd);
    if (end <= start) {
      throw new Error("ALL_IN_ONE bar ranges must have positive duration");
    }
    return {
      bar,
      start,
      end,
      beats: barBeats.length,
      confidence: Math.min(...barBeats.map((beat) => beat.confidence)),
    };
  });

  return {
    providerId: "ALL_IN_ONE",
    version: providerVersion(payload, "ALL_IN_ONE"),
    bpm: tempoMap[0].bpm,
    meter: meterMap[0].meter,
    tempoMap,
    meterMap,
    beats,
    bars,
    sections,
    confidence: overallConfidence,
  };
}

function parseTranscription(
  providerId: TranscriptionAnalysisResult["providerId"],
  payload: unknown,
  durationSeconds: number,
): TranscriptionAnalysisResult {
  if (!isRecord(payload)) throw new Error(`${providerId} response must be an object`);
  if (providerId === "MR_MT3" || providerId === "YOUR_MT3") {
    // Unlike the pre-existing promoted MT3 endpoint, Wave 2 identities are
    // never trusted merely because their health endpoint was reachable.  The
    // executed result must carry the runner identity that the worker fenced to
    // its checked checkpoint before this parser accepts any events.
    const provenance = payload["runtimeProvenance"] ?? payload["provenance"];
    if (
      !isRecord(provenance) ||
      provenance["provider"] !== providerId ||
      provenance["modelVersion"] !== providerVersion(payload, providerId) ||
      typeof provenance["checkpointSha256"] !== "string" ||
      !/^[a-f0-9]{64}$/i.test(provenance["checkpointSha256"]) ||
      typeof provenance["revision"] !== "string" ||
      !provenance["revision"].trim() ||
      typeof provenance["sourceRevision"] !== "string" ||
      !provenance["sourceRevision"].trim()
    ) {
      throw new Error(`${providerId} response is missing verified execution provenance`);
    }
  }
  const rawNotes = payload["notes"] ?? payload["events"];
  const overallConfidence = confidence(
    payload["confidence"],
    `${providerId} confidence`,
  );
  if (!Array.isArray(rawNotes)) {
    throw new Error(`${providerId} response must include notes`);
  }
  const notes = rawNotes.map((value, index): MelodyNote => {
    if (!isRecord(value)) throw new Error(`${providerId} note ${index + 1} must be an object`);
    const start = value["start"] ?? value["onset"];
    const end = value["end"] ?? value["offset"];
    const pitch = value["pitch"] ?? value["midi"];
    const velocity = value["velocity"] ?? (providerId === "SHEETSAGE" ? 100 : undefined);
    const itemConfidence = value["confidence"];
    if (
      !finiteNumber(start) || start < 0 ||
      !finiteNumber(end) || end <= start || end > durationSeconds + 1 ||
      !integer(pitch) || pitch < 0 || pitch > 127 ||
      !integer(velocity) || velocity < 1 || velocity > 127 ||
      !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
    ) {
      throw new Error(`${providerId} note ${index + 1} is invalid`);
    }
    return {
      start,
      end,
      pitch,
      velocity,
      confidence: itemConfidence,
      source: providerId,
    };
  });
  if (notes.some((note, index) => index > 0 && note.start < notes[index - 1].start)) {
    throw new Error(`${providerId} notes must be ordered by onset`);
  }
  return {
    providerId,
    version: providerVersion(payload, providerId),
    notes,
    confidence: overallConfidence,
  };
}
function parseSheetSage(
  payload: unknown,
  durationSeconds: number,
): {
  harmony: HarmonyAnalysisResult;
  transcription: TranscriptionAnalysisResult;
  timingEvidence: AnalysisProviderResults["timingEvidence"][number];
} {
  if (!isRecord(payload)) throw new Error("SHEETSAGE response must be an object");
  const transcription = parseTranscription(
    "SHEETSAGE",
    { ...payload, notes: payload["melody"] },
    durationSeconds,
  );
  const harmony = parseHarmony("SHEETSAGE", payload, durationSeconds);
  const rawTiming = payload["timing"];
  if (!Array.isArray(rawTiming) || !rawTiming.length) {
    throw new Error("SHEETSAGE response must include timing evidence");
  }
  let previousStart = -1;
  const events = rawTiming.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`SHEETSAGE timing event ${index + 1} must be an object`);
    }
    const start = value["start"];
    const end = value["end"];
    const beat = value["beat"];
    if (
      !finiteNumber(start) || start < 0 || start <= previousStart ||
      !finiteNumber(end) || end <= start || end > durationSeconds + 1 ||
      !finiteNumber(beat)
    ) {
      throw new Error(`SHEETSAGE timing event ${index + 1} is invalid`);
    }
    previousStart = start;
    return { start, end, beat };
  });
  return {
    harmony,
    transcription,
    timingEvidence: {
      provider: "SHEETSAGE",
      version: transcription.version,
      events,
    },
  };
}
function parseChordCandidate(
  value: unknown,
  providerId: string,
  index: number,
  durationSeconds: number,
): ChordEvent {
  if (!isRecord(value)) {
    throw new Error(`${providerId} chord ${index + 1} must be an object`);
  }
  const start = value["start"];
  const end = value["end"];
  const symbol = value["symbol"] ?? value["chord"] ?? value["label"];
  const roman = value["roman"];
  const itemConfidence = value["confidence"];
  if (
    !finiteNumber(start) || start < 0 ||
    !finiteNumber(end) || end <= start || end > durationSeconds + 1 ||
    typeof symbol !== "string" || !symbol.trim() ||
    (roman !== undefined && typeof roman !== "string") ||
    !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
  ) {
    throw new Error(`${providerId} chord ${index + 1} is invalid`);
  }
  const normalizedSymbol = symbol.trim();
  const alteration = "(?:[#b](?:5|9|11|13)|add(?:2|4|6|9|11|13)|no(?:3|5)|sus(?:2|4))";
  const chordPattern = new RegExp(
    `^(?:N|N\\.C\\.|[A-G](?:#|b)?:?` +
    `(?:(?:maj|min|dim|aug|sus|add|m|M|Δ|ø|o)?(?:2|4|5|6|7|9|11|13)?)` +
    `(?:\\(${alteration}(?:,${alteration})*\\))?` +
    `(?:\\/[A-G](?:#|b)?)?)$`,
  );
  if (!chordPattern.test(normalizedSymbol)) {
    throw new Error(`${providerId} chord ${index + 1} has an invalid symbol`);
  }
  const stringArray = (field: string): string[] | undefined => {
    const raw = value[field];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
      throw new Error(`${providerId} chord ${index + 1} has invalid ${field}`);
    }
    return raw.map((item) => item.trim()).filter(Boolean);
  };
  const optionalString = (field: string): string | undefined => {
    const raw = value[field];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !raw.trim()) throw new Error(`${providerId} chord ${index + 1} has invalid ${field}`);
    return raw.trim();
  };
  const inversion = value["inversion"];
  if (inversion !== undefined && (!integer(inversion) || inversion < 0)) {
    throw new Error(`${providerId} chord ${index + 1} has invalid inversion`);
  }
  const timing = value["timing"];
  if (timing !== undefined && !isRecord(timing)) throw new Error(`${providerId} chord ${index + 1} has invalid timing`);
  const evidenceLabel = `${providerId} chord ${index + 1}`;
  let parsedTiming: ChordEvent["timing"];
  if (timing) {
    const startBeat = timing["startBeat"];
    const durationBeats = timing["durationBeats"];
    const startSeconds = timing["startSeconds"];
    const endSeconds = timing["endSeconds"];
    const beatPairSupplied = startBeat !== undefined || durationBeats !== undefined;
    const secondsPairSupplied = startSeconds !== undefined || endSeconds !== undefined;
    if (
      (!beatPairSupplied && !secondsPairSupplied) ||
      (beatPairSupplied && (!finiteNumber(startBeat) || startBeat < 0 || !finiteNumber(durationBeats) || durationBeats <= 0)) ||
      (secondsPairSupplied && (!finiteNumber(startSeconds) || startSeconds < 0 || !finiteNumber(endSeconds) || endSeconds <= startSeconds)) ||
      (finiteNumber(startSeconds) && Math.abs(startSeconds - start) > 0.05) ||
      (finiteNumber(endSeconds) && Math.abs(endSeconds - end) > 0.05)
    ) {
      throw new Error(`${evidenceLabel} has invalid timing`);
    }
    parsedTiming = {
      ...(beatPairSupplied ? { startBeat, durationBeats } : {}),
      ...(secondsPairSupplied ? { startSeconds, endSeconds } : {}),
    };
  }
  const melodyConflictEvidence = value["melodyConflictEvidence"];
  if (
    melodyConflictEvidence !== undefined &&
    (!Array.isArray(melodyConflictEvidence) || melodyConflictEvidence.length > MAX_EVIDENCE_ITEMS)
  ) {
    throw new Error(`${evidenceLabel} has invalid melodyConflictEvidence`);
  }
  const parsedMelodyConflictEvidence = melodyConflictEvidence?.map((raw, evidenceIndex) => {
    const label = `${evidenceLabel} melody conflict ${evidenceIndex + 1}`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object`);
    const conflict = raw["conflict"];
    if (!["clash", "avoid_note", "unresolved_tension", "unknown"].includes(String(conflict))) {
      throw new Error(`${label} has invalid conflict`);
    }
    const noteId = raw["noteId"];
    const pitch = raw["pitch"];
    const evidenceStart = raw["start"];
    const evidenceEnd = raw["end"];
    const severity = raw["severity"];
    const explanation = raw["explanation"];
    if (noteId !== undefined) evidenceString(noteId, `${label} noteId`);
    if (pitch !== undefined && (!integer(pitch) || pitch < 0 || pitch > 127)) {
      throw new Error(`${label} has invalid pitch`);
    }
    if (evidenceStart !== undefined && (!finiteNumber(evidenceStart) || evidenceStart < 0)) {
      throw new Error(`${label} has invalid start`);
    }
    if (evidenceEnd !== undefined && (!finiteNumber(evidenceEnd) || evidenceEnd < 0)) {
      throw new Error(`${label} has invalid end`);
    }
    if (
      finiteNumber(evidenceStart) &&
      finiteNumber(evidenceEnd) &&
      evidenceEnd <= evidenceStart
    ) {
      throw new Error(`${label} has invalid timing`);
    }
    if (severity !== undefined && (!finiteNumber(severity) || severity < 0 || severity > 1)) {
      throw new Error(`${label} has invalid severity`);
    }
    if (explanation !== undefined) evidenceString(explanation, `${label} explanation`);
    return {
      ...(noteId !== undefined ? { noteId: evidenceString(noteId, `${label} noteId`) } : {}),
      ...(pitch !== undefined ? { pitch } : {}),
      ...(evidenceStart !== undefined ? { start: evidenceStart } : {}),
      ...(evidenceEnd !== undefined ? { end: evidenceEnd } : {}),
      conflict: conflict as "clash" | "avoid_note" | "unresolved_tension" | "unknown",
      ...(severity !== undefined ? { severity } : {}),
      ...(explanation !== undefined ? { explanation: evidenceString(explanation, `${label} explanation`) } : {}),
    };
  });
  const candidateProvenance = value["candidateProvenance"];
  if (
    candidateProvenance !== undefined &&
    (!Array.isArray(candidateProvenance) || candidateProvenance.length > MAX_EVIDENCE_ITEMS)
  ) {
    throw new Error(`${evidenceLabel} has invalid candidateProvenance`);
  }
  const parsedCandidateProvenance = candidateProvenance?.map((raw, candidateIndex) => {
    const label = `${evidenceLabel} candidate provenance ${candidateIndex + 1}`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object`);
    const candidateId = evidenceString(raw["candidateId"], `${label} candidateId`);
    const provider = evidenceString(raw["provider"], `${label} provider`);
    const modelVersion = raw["modelVersion"];
    const score = raw["score"];
    const selected = raw["selected"];
    const evidence = raw["evidence"];
    if (modelVersion !== undefined) evidenceString(modelVersion, `${label} modelVersion`);
    if (score !== undefined && (!finiteNumber(score) || score < 0 || score > 100)) {
      throw new Error(`${label} has invalid score`);
    }
    if (selected !== undefined && typeof selected !== "boolean") {
      throw new Error(`${label} has invalid selected`);
    }
    if (
      evidence !== undefined &&
      (!Array.isArray(evidence) ||
        evidence.length > MAX_EVIDENCE_ITEMS ||
        !evidence.every((item) => typeof item === "string"))
    ) {
      throw new Error(`${label} has invalid evidence`);
    }
    const parsedEvidence = evidence?.map((item, itemIndex) =>
      evidenceString(item, `${label} evidence ${itemIndex + 1}`));
    return {
      candidateId,
      provider,
      ...(modelVersion !== undefined ? { modelVersion: evidenceString(modelVersion, `${label} modelVersion`) } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(selected !== undefined ? { selected } : {}),
      ...(parsedEvidence !== undefined ? { evidence: parsedEvidence } : {}),
    };
  });
  return {
    start,
    end,
    symbol: normalizedSymbol,
    roman: typeof roman === "string" ? roman.trim() : "",
    confidence: itemConfidence,
    ...(optionalString("root") ? { root: optionalString("root") } : {}),
    ...(optionalString("quality") ? { quality: optionalString("quality") } : {}),
    ...(stringArray("extensions") ? { extensions: stringArray("extensions") } : {}),
    ...(stringArray("alterations") ? { alterations: stringArray("alterations") } : {}),
    ...(inversion !== undefined ? { inversion } : {}),
    ...(optionalString("bass") ? { bass: optionalString("bass") } : {}),
    ...(optionalString("function") ? { function: optionalString("function") } : {}),
    ...(parsedTiming ? { timing: parsedTiming } : {}),
    ...(parsedMelodyConflictEvidence !== undefined ? { melodyConflictEvidence: parsedMelodyConflictEvidence } : {}),
    ...(parsedCandidateProvenance !== undefined ? { candidateProvenance: parsedCandidateProvenance } : {}),
  };
}

export function parseHarmony(
  providerId: "SHEETSAGE" | "CHROMA" | "BASS",
  payload: unknown,
  durationSeconds: number,
): HarmonyAnalysisResult {
  if (!isRecord(payload)) throw new Error(`${providerId} response must be an object`);
  const rawCandidates = payload["chords"] ?? payload["candidates"];
  const candidates = Array.isArray(rawCandidates)
    ? rawCandidates.map((value, index) =>
        parseChordCandidate(value, providerId, index, durationSeconds))
    : [];
  if (candidates.some((item, index) =>
    index > 0 && item.start < candidates[index - 1].start
  )) {
    throw new Error(`${providerId} chord candidates must be ordered`);
  }

  const rawChroma = payload["chroma"];
  const chroma = Array.isArray(rawChroma)
    ? rawChroma.map((value, index): ChromaFrame => {
        if (!isRecord(value)) {
          throw new Error(`${providerId} chroma frame ${index + 1} must be an object`);
        }
        const start = value["start"] ?? value["time"];
        const end = value["end"];
        const values = value["values"];
        const itemConfidence = value["confidence"];
        if (
          !finiteNumber(start) || start < 0 ||
          !finiteNumber(end) || end <= start || end > durationSeconds + 1 ||
          !Array.isArray(values) || values.length !== 12 ||
          !values.every((item) => finiteNumber(item) && item >= 0) ||
          !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
        ) {
          throw new Error(`${providerId} chroma frame ${index + 1} is invalid`);
        }
        const total = values.reduce((sum, item) => sum + item, 0);
        if (total <= 0) throw new Error(`${providerId} chroma frame ${index + 1} is empty`);
        return {
          start,
          end,
          values: values.map((item) => item / total),
          confidence: itemConfidence,
        };
      })
    : [];

  const rawBass = payload["bass"] ?? payload["notes"];
  const bass = Array.isArray(rawBass)
    ? rawBass.map((value, index): BassNote => {
        if (!isRecord(value)) {
          throw new Error(`${providerId} bass note ${index + 1} must be an object`);
        }
        const start = value["start"] ?? value["onset"];
        const end = value["end"] ?? value["offset"];
        const pitch = value["pitch"] ?? value["midi"];
        const itemConfidence = value["confidence"];
        if (
          !finiteNumber(start) || start < 0 ||
          !finiteNumber(end) || end <= start || end > durationSeconds + 1 ||
          !integer(pitch) || pitch < 0 || pitch > 127 ||
          !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
        ) {
          throw new Error(`${providerId} bass note ${index + 1} is invalid`);
        }
        return { start, end, pitch, confidence: itemConfidence };
      })
    : [];

  if (!candidates.length && !chroma.length && !bass.length) {
    throw new Error(`${providerId} returned no harmony evidence`);
  }
  return {
    providerId,
    version: providerVersion(payload, providerId),
    candidates,
    chroma,
    bass,
    confidence: confidence(payload["confidence"], `${providerId} confidence`),
  };
}

const NOTE_NAMES: Record<string, number> = {
  C: 0,
  "B#": 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  "E#": 5,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
  Cb: 11,
};

function chordPitchClasses(symbol: string): number[] {
  const match = /^([A-G](?:#|b)?)(.*)$/.exec(symbol);
  if (!match) return [];
  const root = NOTE_NAMES[match[1]];
  if (root === undefined) return [];
  const quality = match[2].replace(/^:/, "").toLowerCase();
  const third = quality.startsWith("m") && !quality.startsWith("maj") ? 3 : 4;
  const fifth = quality.includes("dim") ? 6 : quality.includes("aug") ? 8 : 7;
  return [root, (root + third) % 12, (root + fifth) % 12];
}

function overlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

export function fuseHarmonyEvidence(
  results: HarmonyAnalysisResult[],
): { chords: ChordEvent[]; confidence: number; providersUsed: string[] } {
  // Scores are normalized per canonical time slice.  A tenth of the available
  // evidence is deliberately required to resolve a disagreement: this keeps a
  // single confident detector from manufacturing certainty in a close split.
  const AMBIGUITY_NORMALIZED_MARGIN = 0.1;
  const directCandidates = results.flatMap((result) =>
    result.candidates.map((candidate) => ({ candidate, result })));
  if (!directCandidates.length) {
    return { chords: [], confidence: 0, providersUsed: [] };
  }
  const boundaries = [...new Set(directCandidates.flatMap(({ candidate }) => [
    candidate.start,
    candidate.end,
  ]))].sort((left, right) => left - right);
  const segments: ChordEvent[] = [];
  const providersUsed = new Set<string>();

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const segment = { start: boundaries[index], end: boundaries[index + 1] };
    if (segment.end <= segment.start) continue;
    const active = directCandidates.filter(({ candidate }) => overlap(candidate, segment));
    if (!active.length) continue;
    type HarmonyScore = {
      score: number;
      directScore: number;
      roman: string;
      strongest: number;
      candidate?: ChordEvent;
      provider?: string;
      directByProvider: Map<string, number>;
      directProviders: Set<string>;
      bassProviders: Set<string>;
      chromaProviders: Set<string>;
      bassSupportEvidence?: NonNullable<ChordEvent["bassSupportEvidence"]>;
    };
    const scores = new Map<string, HarmonyScore>();
    for (const { candidate, result } of active) {
      const current: HarmonyScore = scores.get(candidate.symbol) ?? {
        score: 0,
        directScore: 0,
        roman: candidate.roman,
        strongest: 0,
        directByProvider: new Map(),
        directProviders: new Set(),
        bassProviders: new Set(),
        chromaProviders: new Set(),
      };
      const directScore = candidate.confidence * result.confidence;
      const previousProviderScore = current.directByProvider.get(result.providerId) ?? 0;
      if (directScore > previousProviderScore) {
        current.directByProvider.set(result.providerId, directScore);
        current.directProviders.add(result.providerId);
      }
      if (
        directScore > current.strongest ||
        (directScore === current.strongest &&
          (result.providerId < (current.provider ?? "") ||
            (result.providerId === current.provider &&
              (candidate.roman < current.roman ||
                (candidate.roman === current.roman &&
                  (candidate.start < (current.candidate?.start ?? Infinity) ||
                    (candidate.start === current.candidate?.start &&
                      candidate.end < (current.candidate?.end ?? Infinity))))))))
      ) {
        current.strongest = directScore;
        current.roman = candidate.roman;
        current.candidate = candidate;
        current.provider = result.providerId;
      }
      scores.set(candidate.symbol, current);
    }
    for (const [symbol, current] of scores) {
      current.directScore = [...current.directByProvider.values()]
        .reduce((sum, score) => sum + score, 0);
      current.score = current.directScore;
      const pitchClasses = chordPitchClasses(symbol);
      const root = pitchClasses[0];
      if (root !== undefined) {
        const bassSupportEvidence = results.flatMap((item) => item.bass
          .filter((note) => overlap(note, segment) && note.pitch % 12 === root)
          .map((note) => ({ ...note, provider: item.providerId })))
          .slice(0, 16);
        const bassSupport = bassSupportEvidence
          .reduce((sum, note) => sum + note.confidence, 0);
        current.bassSupportEvidence = bassSupportEvidence;
        const supportingBassProviders = results
          .filter((item) => item.bass.some((note) =>
            overlap(note, segment) && note.pitch % 12 === root))
          .map((item) => item.providerId);
        const overlappingChromaResults = results
          .filter((item) => item.chroma.some((frame) => overlap(frame, segment)));
        const chromaSupport = overlappingChromaResults
          .flatMap((item) => item.chroma)
          .filter((frame) => overlap(frame, segment))
          .reduce((sum, frame) =>
            sum + pitchClasses.reduce(
              (pitchSum, pitchClass) => pitchSum + frame.values[pitchClass],
              0,
            ) * frame.confidence, 0);
        // Auxiliary evidence contributes to an aggregate, but cannot reverse
        // the direct ordering of a multi-provider disagreement below.
        current.score += Math.min(0.2, bassSupport * 0.08);
        current.score += Math.min(0.25, chromaSupport * 0.12);
        if (bassSupport > 0) {
          for (const provider of supportingBassProviders) current.bassProviders.add(provider);
        }
        if (chromaSupport > 0) {
          for (const item of overlappingChromaResults) {
            current.chromaProviders.add(item.providerId);
          }
        }
      }
    }
    const directWinner = [...scores.entries()].sort((left, right) =>
      right[1].directScore - left[1].directScore ||
      right[1].directProviders.size - left[1].directProviders.size ||
      left[0].localeCompare(right[0]))[0];
    if (scores.size > 1 && directWinner[1].directProviders.size > 1) {
      // Bass and chroma evidence may refine a direct tie, never displace
      // independently corroborated direct harmony.
      for (const [candidateSymbol, candidateScore] of scores) {
        if (candidateSymbol !== directWinner[0]) {
          candidateScore.score = Math.min(candidateScore.score, directWinner[1].directScore);
        }
      }
    }
    const ranked = [...scores.entries()].sort((left, right) =>
      right[1].score - left[1].score ||
      right[1].directProviders.size - left[1].directProviders.size ||
      left[0].localeCompare(right[0]));
    const [symbol, winner] = ranked[0];
    const total = ranked.reduce((sum, item) => sum + item[1].score, 0);
    const normalizedWinnerScore = total > 0 ? winner.score / total : 0;
    const runnerUp = ranked[1];
    const normalizedMargin = runnerUp && total > 0
      ? normalizedWinnerScore - runnerUp[1].score / total
      : Infinity;
    const equalSupportTooClose = runnerUp &&
      winner.directProviders.size === runnerUp[1].directProviders.size &&
      normalizedMargin <= AMBIGUITY_NORMALIZED_MARGIN;
    const uncorroboratedTooClose = runnerUp &&
      winner.directProviders.size < 2 &&
      normalizedMargin <= AMBIGUITY_NORMALIZED_MARGIN;
    if (uncorroboratedTooClose || equalSupportTooClose) continue;
    const fusedConfidence = total > 0
      ? Math.min(1, normalizedWinnerScore * 0.65 + winner.strongest * 0.35)
      : 0;
    for (const provider of winner.directProviders) providersUsed.add(provider);
    for (const provider of winner.bassProviders) providersUsed.add(provider);
    for (const provider of winner.chromaProviders) providersUsed.add(provider);
    const previous = segments[segments.length - 1];
    if (
      previous &&
      previous.symbol === symbol &&
      previous.roman === winner.roman &&
      Math.abs(previous.end - segment.start) < 0.001
    ) {
      previous.end = segment.end;
      previous.bassSupportEvidence = [
        ...(previous.bassSupportEvidence ?? []),
        ...(winner.bassSupportEvidence ?? []),
      ].filter((evidence, evidenceIndex, all) =>
        all.findIndex((candidate) =>
          candidate.provider === evidence.provider &&
          candidate.pitch === evidence.pitch &&
          candidate.start === evidence.start &&
          candidate.end === evidence.end) === evidenceIndex)
        .slice(0, 16);
      if (previous.timing) {
        previous.timing = {
          startSeconds: previous.start,
          endSeconds: previous.end,
        };
      }
      previous.confidence = Number(
        ((previous.confidence + fusedConfidence) / 2).toFixed(4),
      );
    } else {
      segments.push({
        ...segment,
        symbol,
        roman: winner.roman,
        confidence: Number(fusedConfidence.toFixed(4)),
        ...(winner.candidate
          ? {
              root: winner.candidate.root,
              quality: winner.candidate.quality,
              extensions: winner.candidate.extensions,
              alterations: winner.candidate.alterations,
              inversion: winner.candidate.inversion,
              bass: winner.candidate.bass,
              function: winner.candidate.function,
              timing: winner.candidate.timing
                ? { startSeconds: segment.start, endSeconds: segment.end }
                : undefined,
              melodyConflictEvidence: winner.candidate.melodyConflictEvidence,
              candidateProvenance: winner.candidate.candidateProvenance ??
                [{ candidateId: `${winner.provider}:${segment.start}-${segment.end}`, provider: winner.provider!, selected: true }],
              bassSupportEvidence: winner.bassSupportEvidence,
            }
          : {}),
      });
    }
  }
  return {
    chords: segments,
    confidence: segments.length
      ? Number(
          (segments.reduce((sum, chord) => sum + chord.confidence, 0) /
            segments.length).toFixed(4),
        )
      : 0,
    providersUsed: [...providersUsed].sort(),
  };
}

export function fuseCanonicalNotes(
  transcriptions: TranscriptionAnalysisResult[],
): MelodyNote[] {
  // These weights intentionally describe transcription capability reliability,
  // rather than a provider's reliability for another analysis capability.
  const transcriptionReliability: Record<TranscriptionAnalysisResult["providerId"], number> = {
    BASIC_PITCH: 1,
    MT3: 0.98,
    MR_MT3: 0.98,
    YOUR_MT3: 0.98,
    SHEETSAGE: 0.92,
  };
  const TIMING_START_TOLERANCE = 0.03;
  const TIMING_END_TOLERANCE = 0.05;
  const AMBIGUITY_NORMALIZED_MARGIN = 0.1;
  const SOLE_PROVIDER_CONFIDENCE = 0.85;
  type NoteVote = {
    note: MelodyNote;
    provider: TranscriptionAnalysisResult["providerId"];
    score: number;
  };
  type TimingCluster = {
    start: number;
    end: number;
    votes: NoteVote[];
  };

  const attestedProviders = new Set(transcriptions.map((result) => result.providerId));
  if (!attestedProviders.size) return [];
  const votes = transcriptions.flatMap((result) =>
    result.notes.map((note): NoteVote => ({
      note,
      provider: result.providerId,
      score: note.confidence * result.confidence *
        transcriptionReliability[result.providerId],
    })))
    .sort((left, right) =>
      left.note.start - right.note.start ||
      left.note.end - right.note.end ||
      left.note.pitch - right.note.pitch ||
      left.provider.localeCompare(right.provider) ||
      right.score - left.score);
  if (!votes.length) return [];

  // Clustering against a deterministic anchor prevents input order from
  // changing whether adjacent timing jitter is considered the same event.
  const timingClusters: TimingCluster[] = [];
  for (const vote of votes) {
    const cluster = timingClusters.find((candidate) =>
      Math.abs(candidate.start - vote.note.start) <= TIMING_START_TOLERANCE &&
      Math.abs(candidate.end - vote.note.end) <= TIMING_END_TOLERANCE);
    if (cluster) cluster.votes.push(vote);
    else timingClusters.push({
      start: vote.note.start,
      end: vote.note.end,
      votes: [vote],
    });
  }

  return timingClusters.flatMap((cluster) => {
    type PitchSupport = {
      score: number;
      votesByProvider: Map<NoteVote["provider"], NoteVote>;
    };
    const voteByProvider = new Map<NoteVote["provider"], NoteVote>();
    for (const vote of cluster.votes) {
      const existing = voteByProvider.get(vote.provider);
      if (
        !existing ||
        vote.score > existing.score ||
        (vote.score === existing.score &&
          (vote.note.pitch < existing.note.pitch ||
            (vote.note.pitch === existing.note.pitch &&
              (vote.note.start < existing.note.start ||
                (vote.note.start === existing.note.start &&
                  vote.note.end < existing.note.end)))))
      ) {
        voteByProvider.set(vote.provider, vote);
      }
    }
    const byPitch = new Map<number, PitchSupport>();
    for (const vote of voteByProvider.values()) {
      const support = byPitch.get(vote.note.pitch) ?? {
        score: 0,
        votesByProvider: new Map(),
      };
      // A provider gets exactly one vote per timing cluster, even if it
      // returned duplicate or polyphonic events at that instant.
      support.votesByProvider.set(vote.provider, vote);
      byPitch.set(vote.note.pitch, support);
    }
    for (const support of byPitch.values()) {
      support.score = [...support.votesByProvider.values()]
        .reduce((sum, vote) => sum + vote.score, 0);
    }
    const ranked = [...byPitch.entries()].sort((left, right) =>
      right[1].score - left[1].score ||
      right[1].votesByProvider.size - left[1].votesByProvider.size ||
      left[0] - right[0]);
    const [pitch, winner] = ranked[0]!;
    const runnerUp = ranked[1];
    const totalScore = ranked.reduce((sum, [, support]) => sum + support.score, 0);
    const normalizedMargin = runnerUp && totalScore > 0
      ? (winner.score - runnerUp[1].score) / totalScore
      : Infinity;
    const hasCloseUnsupportedConflict = runnerUp &&
      winner.votesByProvider.size < 2 &&
      normalizedMargin <= AMBIGUITY_NORMALIZED_MARGIN;
    const hasEquallySupportedCloseConflict = runnerUp &&
      winner.votesByProvider.size === runnerUp[1].votesByProvider.size &&
      normalizedMargin <= AMBIGUITY_NORMALIZED_MARGIN;
    if (hasCloseUnsupportedConflict || hasEquallySupportedCloseConflict) return [];

    // An isolated event can only enter canon when this analysis actually had
    // one attested transcription provider. Empty results from another
    // attested provider therefore cannot be silently treated as agreement.
    if (
      winner.votesByProvider.size === 1 &&
      attestedProviders.size !== 1
    ) return [];
    const representative = [...winner.votesByProvider.values()].sort((left, right) =>
      right.score - left.score ||
      left.provider.localeCompare(right.provider) ||
      left.note.start - right.note.start ||
      left.note.end - right.note.end)[0]!;
    if (
      winner.votesByProvider.size === 1 &&
      representative.score < SOLE_PROVIDER_CONFIDENCE
    ) return [];
    return [{ ...representative.note, pitch }];
  }).sort((left, right) =>
    left.start - right.start || left.pitch - right.pitch || left.end - right.end);
}

export type VerifiedBassStemAnalysisResult = {
  bassEvidence: AnalysisProviderResults["bassEvidence"];
  provenance: ProviderProvenance[];
};

export function fuseVerifiedBassEvidence(
  basic: TranscriptionAnalysisResult,
  torch: AnalysisProviderResults["pitchEvidence"][number],
  lineage: { sourceStem: string; sourceStemProvider: "BS_ROFORMER" },
): AnalysisProviderResults["bassEvidence"] {
  return basic.notes.flatMap((note) => {
    const overlapping = torch.frames.filter((frame) =>
      frame.voiced && frame.midiPitch !== null &&
      frame.time >= note.start && frame.time < note.end);
    if (!overlapping.length) return [];
    const totalWeight = overlapping.reduce(
      (sum, frame) => sum + frame.confidence,
      0,
    );
    if (totalWeight <= 0) return [];
    const torchPitch = Math.round(overlapping.reduce(
      (sum, frame) => sum + frame.midiPitch! * frame.confidence,
      0,
    ) / totalWeight);
    const torchConfidence = totalWeight / overlapping.length;
    const basicConfidence = note.confidence * basic.confidence;
    const pitch = Math.abs(torchPitch - note.pitch) <= 1
      ? note.pitch
      : torchConfidence > basicConfidence
        ? torchPitch
        : note.pitch;
    return [{
      start: note.start,
      end: note.end,
      pitch,
      confidence: Number(Math.min(basicConfidence, torchConfidence).toFixed(6)),
      provider: "BASS_FUSION",
      sourceStem: lineage.sourceStem,
      sourceStemProvider: lineage.sourceStemProvider,
      providers: ["BS_ROFORMER", "TORCHCREPE", "BASIC_PITCH"],
    }];
  });
}

/**
 * Runs only after the caller has persisted and audio-verified a real
 * BS-RoFormer bass artifact. Both independent pitch providers must succeed;
 * partial evidence is never promoted to canonical bass notes.
 */
export async function analyzeVerifiedBassStem(input: {
  sourceUrl: string;
  durationSeconds: number;
  idempotencyKey: string;
  sourceStem: string;
  sourceStemProvider: "BS_ROFORMER";
}): Promise<VerifiedBassStemAnalysisResult> {
  const providerInput: AnalysisProviderInput = {
    sourceUrl: input.sourceUrl,
    sourceType: "SOLO_INSTRUMENT",
    durationSeconds: input.durationSeconds,
    idempotencyKey: `${input.idempotencyKey}:verified-bass`,
  };
  const required = ["TORCHCREPE", "BASIC_PITCH"] as const;
  const missing = required.filter((provider) =>
    !configuredAnalysisProviderEndpoint(provider));
  if (missing.length) {
    return {
      bassEvidence: [],
      provenance: [{
        capability: "bass_evidence",
        provider: "BASS",
        version: "unavailable",
        status: "unavailable",
        attempts: 0,
        errorCode: "required-provider-unavailable",
        errorMessage: `Verified bass analysis requires ${missing.join(" and ")}.`,
      }],
    };
  }

  const outcomes = await Promise.all(required.map(async (provider) => {
    try {
      return {
        provider,
        request: await requestProvider(provider, providerInput),
        error: null,
      };
    } catch (error) {
      return {
        provider,
        request: null,
        error: error instanceof ProviderRequestError
          ? error
          : new ProviderRequestError(
              `${provider} failed during verified bass analysis`,
              "request-failed",
              false,
              1,
            ),
      };
    }
  }));
  const failed = outcomes.filter((outcome) => outcome.error);
  if (failed.length) {
    return {
      bassEvidence: [],
      provenance: [
        ...failed.map(({ provider, error }): ProviderProvenance => ({
          capability: "bass_pitch_evidence",
          provider,
          version: error!.code,
          status: "failed",
          attempts: error!.attempts,
          errorCode: error!.code,
          errorMessage: error!.message,
        })),
        {
          capability: "bass_evidence",
          provider: "BASS",
          version: "unavailable",
          status: "unavailable",
          attempts: 0,
          errorCode: "required-provider-failed",
          errorMessage: "Canonical bass requires both TorchCREPE and Basic Pitch evidence.",
        },
      ],
    };
  }

  try {
    const torchOutcome = outcomes.find((item) => item.provider === "TORCHCREPE")!;
    const basicOutcome = outcomes.find((item) => item.provider === "BASIC_PITCH")!;
    const torch = parseTorchCrepe(
      torchOutcome.request!.payload,
      input.durationSeconds,
      input.sourceStem,
    );
    const basic = parseTranscription(
      "BASIC_PITCH",
      basicOutcome.request!.payload,
      input.durationSeconds,
    );
    const bassEvidence = fuseVerifiedBassEvidence(basic, torch, input);
    return {
      bassEvidence,
      provenance: [
        {
          capability: "bass_pitch_evidence",
          provider: "TORCHCREPE",
          version: torch.version,
          status: "ready",
          attempts: torchOutcome.request!.attempts,
        },
        {
          capability: "bass_transcription_evidence",
          provider: "BASIC_PITCH",
          version: basic.version,
          status: "ready",
          attempts: basicOutcome.request!.attempts,
        },
        {
          capability: "bass_evidence",
          provider: "BASS_FUSION",
          version: "2.0.0",
          status: bassEvidence.length ? "ready" : "unavailable",
          attempts: 1,
          ...(!bassEvidence.length
            ? {
                errorCode: "no-consensus-notes",
                errorMessage: "The verified bass stem produced no overlapping real note and pitch evidence.",
              }
            : {}),
        },
      ],
    };
  } catch (error) {
    return {
      bassEvidence: [],
      provenance: [{
        capability: "bass_evidence",
        provider: "BASS",
        version: "contract-invalid",
        status: "failed",
        attempts: 1,
        errorCode: "contract-invalid",
        errorMessage: error instanceof Error ? error.message : "Bass evidence was invalid.",
      }],
    };
  }
}

function parseMadmom(payload: unknown, durationSeconds: number) {
  if (!isRecord(payload)) throw new Error("MADMOM response must be an object");
  const beats = payload["beats"];
  const downbeats = payload["downbeats"];
  const tempoBpm = payload["tempoBpm"];
  if (
    !Array.isArray(beats) || beats.length < 2 ||
    !beats.every((item) => finiteNumber(item) && item >= 0 && item <= durationSeconds + 1) ||
    beats.some((item, index) => index > 0 && item <= beats[index - 1]) ||
    !Array.isArray(downbeats) ||
    !downbeats.every((item) => finiteNumber(item) && beats.includes(item)) ||
    !finiteNumber(tempoBpm) || tempoBpm < 20 || tempoBpm > 400
  ) {
    throw new Error("MADMOM returned invalid beat, downbeat, or tempo evidence");
  }
  return {
    provider: "MADMOM" as const,
    version: providerVersion(payload, "MADMOM"),
    beats: beats as number[],
    downbeats: downbeats as number[],
    tempoBpm,
  };
}

function parseBeatThis(payload: unknown, durationSeconds: number) {
  if (!isRecord(payload)) throw new Error("BEAT_THIS response must be an object");
  const beats = payload["beats"];
  const downbeats = payload["downbeats"];
  const itemConfidence = payload["confidence"];
  if (
    !Array.isArray(beats) || beats.length < 2 ||
    !beats.every((item) => finiteNumber(item) && item >= 0 && item <= durationSeconds + 1) ||
    beats.some((item, index) => index > 0 && item <= beats[index - 1]) ||
    !Array.isArray(downbeats) ||
    !downbeats.every((item) => finiteNumber(item) && beats.includes(item)) ||
    !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
  ) throw new Error("BEAT_THIS returned invalid beat/downbeat evidence");
  const intervals = beats.slice(1).map((beat, index) => beat - (beats[index] as number));
  const tempoBpm = 60 / (intervals.reduce((sum, value) => sum + value, 0) / intervals.length);
  if (!Number.isFinite(tempoBpm) || tempoBpm < 20 || tempoBpm > 400) {
    throw new Error("BEAT_THIS beat intervals do not produce a valid tempo");
  }
  return { provider: "BEAT_THIS" as const, version: providerVersion(payload, "BEAT_THIS"),
    beats: beats as number[], downbeats: downbeats as number[], tempoBpm };
}

function parseTorchCrepe(payload: unknown, durationSeconds: number, sourceStem: string) {
  if (!isRecord(payload) || payload["model"] !== "full" || !Array.isArray(payload["frames"])) {
    throw new Error("TORCHCREPE response must contain full-model pitch frames");
  }
  const frames = payload["frames"].map((value, index) => {
    if (!isRecord(value)) throw new Error(`TORCHCREPE frame ${index + 1} must be an object`);
    const time = value["time"];
    const frequencyHz = value["frequencyHz"];
    const midiPitch = value["midiPitch"];
    const periodicity = value["periodicity"];
    const voiced = value["voiced"];
    const itemConfidence = value["confidence"];
    if (
      !finiteNumber(time) || time < 0 || time > durationSeconds + 1 ||
      !finiteNumber(frequencyHz) || frequencyHz < 0 ||
      !(midiPitch === null || finiteNumber(midiPitch)) ||
      !finiteNumber(periodicity) || periodicity < 0 || periodicity > 1 ||
      typeof voiced !== "boolean" ||
      !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1 ||
      (voiced && (frequencyHz <= 0 || midiPitch === null)) ||
      (!voiced && midiPitch !== null)
    ) throw new Error(`TORCHCREPE frame ${index + 1} is invalid`);
    return { time, frequencyHz, midiPitch, periodicity, voiced, confidence: itemConfidence };
  });
  if (!frames.length) throw new Error("TORCHCREPE returned no pitch evidence");
  return {
    provider: "TORCHCREPE" as const,
    version: providerVersion(payload, "TORCHCREPE"),
    sourceStem,
    frames,
  };
}

function parseEssentia(payload: unknown) {
  if (!isRecord(payload)) throw new Error("ESSENTIA response must be an object");
  const key = payload["key"];
  const scale = payload["scale"];
  const hpcp = payload["hpcp"];
  const itemConfidence = payload["confidence"];
  if (
    typeof key !== "string" || !key.trim() ||
    typeof scale !== "string" || !scale.trim() ||
    !Array.isArray(hpcp) || hpcp.length !== 12 ||
    !hpcp.every((item) => finiteNumber(item) && item >= 0) ||
    !finiteNumber(itemConfidence) || itemConfidence < 0 || itemConfidence > 1
  ) throw new Error("ESSENTIA returned invalid key or HPCP evidence");
  return {
    provider: "ESSENTIA" as const,
    version: providerVersion(payload, "ESSENTIA"),
    key: key.trim(),
    scale: scale.trim(),
    confidence: itemConfidence,
    hpcp: hpcp as number[],
  };
}

function parseLoudness(payload: unknown) {
  if (!isRecord(payload)) throw new Error("PYLOUDNORM response must be an object");
  const integratedLUFS = payload["integratedLUFS"];
  const loudnessRange = payload["loudnessRange"];
  const samplePeak = payload["samplePeak"];
  if (
    !finiteNumber(integratedLUFS) || integratedLUFS > 10 ||
    !finiteNumber(loudnessRange) || loudnessRange < 0 ||
    !finiteNumber(samplePeak) || samplePeak < 0
  ) throw new Error("PYLOUDNORM returned invalid loudness evidence");
  return {
    provider: "PYLOUDNORM" as const,
    version: providerVersion(payload, "PYLOUDNORM"),
    integratedLUFS,
    loudnessRange,
    samplePeak,
  };
}

function parseMirChroma(payload: unknown, durationSeconds: number): HarmonyAnalysisResult {
  if (!isRecord(payload) || !Array.isArray(payload["frames"])) {
    throw new Error("CHROMA response must contain beat-aligned frames");
  }
  const rawFrames = payload["frames"];
  const frames = rawFrames.map((value, index) => {
    if (!isRecord(value)) throw new Error(`CHROMA frame ${index + 1} must be an object`);
    const start = value["time"];
    const next = rawFrames[index + 1];
    const end = isRecord(next) ? next["time"] : durationSeconds;
    return {
      start,
      end,
      values: value["pitchClassProbabilities"],
      confidence: value["confidence"],
    };
  });
  const chords = rawFrames.flatMap((value, index) => {
    if (!isRecord(value) || !Array.isArray(value["candidateChords"])) return [];
    const start = value["time"];
    const next = rawFrames[index + 1];
    const end = isRecord(next) ? next["time"] : durationSeconds;
    const symbol = value["candidateChords"][0];
    return typeof symbol === "string"
      ? [{ start, end, symbol, roman: "", confidence: value["confidence"] }]
      : [];
  });
  return parseHarmony("CHROMA", {
    version: providerVersion(payload, "CHROMA"),
    confidence: frames.length
      ? frames.reduce((sum, frame) => sum + Number(frame.confidence), 0) / frames.length
      : 0,
    chroma: frames,
    chords,
  }, durationSeconds);
}

function unavailableProvenance(
  providerId: AnalysisProviderId,
  capability: string,
  input: AnalysisProviderInput,
): ProviderProvenance | null {
  const endpoint = configuredAnalysisProviderEndpoint(providerId);
  if (endpoint && input.sourceUrl) return null;
  return {
    capability,
    provider: providerId,
    version: endpoint ? "source-unavailable" : "not-configured",
    status: "unavailable",
    attempts: 0,
    errorCode: endpoint ? "source-unavailable" : "not-configured",
  };
}

export async function runAnalysisProviders(
  input: AnalysisProviderInput,
): Promise<AnalysisProviderResults> {
  const isFullMix = ["FULL_SONG", "INSTRUMENTAL", "VIDEO"].includes(input.sourceType);
  const wantsSeparation = [...(isFullMix ? ["full"] : []), input.sourceType]
    .some((value) => value === "full" || value === "VOCAL_ONLY");
  const wantsBasicPitch = ["VOCAL_ONLY", "SOLO_INSTRUMENT"].includes(input.sourceType);
  const provenance: ProviderProvenance[] = [];
  let separation: SeparationAnalysisResult | null = null;
  let structure: StructureAnalysisResult | null = null;
  const transcriptions: TranscriptionAnalysisResult[] = [];
  const harmony: HarmonyAnalysisResult[] = [];
  const rhythmEvidence: AnalysisProviderResults["rhythmEvidence"] = [];
  const timingEvidence: AnalysisProviderResults["timingEvidence"] = [];
  const pitchEvidence: AnalysisProviderResults["pitchEvidence"] = [];
  const keyEvidence: AnalysisProviderResults["keyEvidence"] = [];
  let loudness: AnalysisProviderResults["loudness"] = null;
  const tasks: Promise<void>[] = [];

  const schedule = <T>(
    providerId: AnalysisProviderId,
    capability: string,
    parse: (payload: unknown) => T,
    accept: (result: T) => void,
  ): void => {
    const unavailable = unavailableProvenance(providerId, capability, input);
    if (unavailable) {
      provenance.push(unavailable);
      return;
    }
    tasks.push(
      requestProvider(providerId, input)
        .then(({ payload, attempts }) => {
          let result: T;
          try {
            result = parse(payload);
          } catch (error) {
            throw new ProviderRequestError(
              error instanceof Error
                ? error.message
                : `${providerId} returned an invalid response`,
              "contract-invalid",
              false,
              attempts,
            );
          }
          accept(result);
          const version = isRecord(payload) && typeof payload["version"] === "string"
            ? payload["version"]
            : "unknown";
          provenance.push({
            capability,
            provider: providerId,
            version,
            status: "ready",
            attempts,
          });
        })
        .catch((error: unknown) => {
          const requestError = error instanceof ProviderRequestError
            ? error
            : new ProviderRequestError(
                error instanceof Error ? error.message : `${providerId} failed`,
                "contract-invalid",
                false,
                1,
              );
          provenance.push({
            capability,
            provider: providerId,
            version: requestError.code,
            status: "failed",
            attempts: requestError.attempts,
            errorCode: requestError.code,
            errorMessage: requestError.message,
          });
        }),
    );
  };

  if (wantsSeparation) {
    const separationProvider = configuredAnalysisProviderEndpoint("DEMUCS")
      ? "DEMUCS"
      : "BS_ROFORMER";
    schedule(
      separationProvider,
      "separation",
      (payload) => parseSeparation(separationProvider, payload),
      (result) => {
        separation = result;
      },
    );
  }
  if (isFullMix) {
    schedule("BEAT_THIS", "primary_beat_tracking",
      (payload) => parseBeatThis(payload, input.durationSeconds),
      (result) => rhythmEvidence.push(result));
    schedule("MADMOM", "rhythm_evidence",
      (payload) => parseMadmom(payload, input.durationSeconds),
      (result) => rhythmEvidence.push(result));
    schedule("ESSENTIA", "key_evidence", parseEssentia,
      (result) => keyEvidence.push(result));
    schedule("PYLOUDNORM", "loudness", parseLoudness,
      (result) => { loudness = result; });
    schedule(
      "ALL_IN_ONE",
      "structure",
      (payload) => parseStructure(payload, input.durationSeconds),
      (result) => {
        structure = result;
      },
    );
    schedule(
      "MT3",
      "transcription",
      (payload) => parseTranscription("MT3", payload, input.durationSeconds),
      (result) => {
        transcriptions.push(result);
      },
    );
    // Wave 2 adapters are independent endpoints and promotion records. They
    // remain unavailable (rather than pretending to be ready) until their
    // private-volume bootstrap and signed deployment evidence are supplied.
    schedule(
      "MR_MT3",
      "transcription",
      (payload) => parseTranscription("MR_MT3", payload, input.durationSeconds),
      (result) => {
        transcriptions.push(result);
      },
    );
    schedule(
      "YOUR_MT3",
      "transcription",
      (payload) => parseTranscription("YOUR_MT3", payload, input.durationSeconds),
      (result) => {
        transcriptions.push(result);
      },
    );
    schedule(
      "SHEETSAGE",
      "harmony",
      (payload) => parseSheetSage(payload, input.durationSeconds),
      (result) => {
        harmony.push(result.harmony);
        transcriptions.push(result.transcription);
        timingEvidence.push(result.timingEvidence);
        provenance.push({
          capability: "melody",
          provider: "SHEETSAGE",
          version: result.transcription.version,
          status: "ready",
          attempts: 1,
        });
        provenance.push({
          capability: "timing",
          provider: "SHEETSAGE",
          version: result.transcription.version,
          status: "ready",
          attempts: 1,
        });
      },
    );
    schedule(
      "CHROMA",
      "harmony_evidence",
      (payload) => parseMirChroma(payload, input.durationSeconds),
      (result) => {
        harmony.push(result);
      },
    );
  }
  if (wantsBasicPitch) {
    schedule("TORCHCREPE", "pitch_evidence",
      (payload) => parseTorchCrepe(payload, input.durationSeconds,
        input.sourceType === "VOCAL_ONLY" ? "lead_vocal" : "solo_instrument"),
      (result) => pitchEvidence.push(result));
    schedule(
      "BASIC_PITCH",
      "transcription",
      (payload) => parseTranscription("BASIC_PITCH", payload, input.durationSeconds),
      (result) => {
        transcriptions.push(result);
      },
    );
  }

  await Promise.all(tasks);
  const fusedHarmony = fuseHarmonyEvidence(harmony);
  if (fusedHarmony.chords.length && fusedHarmony.providersUsed.length >= 2) {
    provenance.push({
      capability: "harmony_fusion",
      provider: "FUSION",
      version: "1.0.0",
      status: "ready",
      attempts: 1,
    });
  }
  return {
    separation,
    structure,
    transcriptions,
    harmony,
    chords: fusedHarmony.chords,
    bassEvidence: harmony.flatMap((result) => result.bass.map((note) => ({
      ...note,
      provider: result.providerId,
    }))),
    harmonyConfidence: fusedHarmony.confidence,
    rhythmEvidence,
    timingEvidence,
    pitchEvidence,
    keyEvidence,
    loudness,
    provenance,
  };
}
