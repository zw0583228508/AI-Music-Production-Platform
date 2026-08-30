import type { AnalysisSection, SongModelData } from "@workspace/db";
import { attestAnalysisProviderHealth } from "./analysisProviderManifest";

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
  | "SHEETSAGE"
  | "CHROMA"
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
  providerId: "BASIC_PITCH" | "MT3";
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
  harmonyConfidence: number;
  provenance: ProviderProvenance[];
};

type AnalysisProviderInput = {
  sourceUrl: string | null;
  sourceType: string;
  durationSeconds: number;
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

const MAX_PROVIDER_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const ANALYSIS_HEALTH_TTL_MS = 30_000;
const analysisHealthCache = new Map<string, {
  expiresAt: number;
  error: ProviderRequestError | null;
}>();

export const configuredAnalysisProviderEndpoint = (providerId: AnalysisProviderId): string | null => {
  const aliases = providerId === "BS_ROFORMER"
    ? ["BS_ROFORMER_API_URL", "BS_ROFORMER_SW_API_URL"]
    : providerId === "SHEETSAGE"
      ? ["SHEETSAGE_API_URL", "SHEET_SAGE_API_URL"]
      : [`${providerId}_API_URL`];
  return aliases
    .map((name) => process.env[name]?.trim())
    .find((value): value is string => Boolean(value)) ?? null;
};

const providerToken = (providerId: AnalysisProviderId): string | undefined => {
  if (providerId === "BS_ROFORMER") {
    return process.env.BS_ROFORMER_API_TOKEN ?? process.env.BS_ROFORMER_SW_API_TOKEN;
  }
  if (providerId === "SHEETSAGE") {
    return process.env.SHEETSAGE_API_TOKEN ?? process.env.SHEET_SAGE_API_TOKEN;
  }
  return process.env[`${providerId}_API_TOKEN`] ??
    (["BASIC_PITCH", "DEMUCS"].includes(providerId)
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

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
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
): Promise<void> {
  const cacheKey = `${providerId}:${endpoint}`;
  const cached = analysisHealthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) throw cached.error;
    return;
  }
  try {
    const healthUrl = new URL("/health", endpoint);
    healthUrl.searchParams.set("provider", providerId);
    const response = await fetch(healthUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`);
    const payload = await readProviderJson(providerId, response);
    attestAnalysisProviderHealth(providerId, payload);
    analysisHealthCache.set(cacheKey, {
      expiresAt: Date.now() + ANALYSIS_HEALTH_TTL_MS,
      error: null,
    });
  } catch (error) {
    const attestationError = new ProviderRequestError(
      `${providerId} health attestation failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      "health-attestation-failed",
      false,
      0,
    );
    analysisHealthCache.set(cacheKey, {
      expiresAt: Date.now() + ANALYSIS_HEALTH_TTL_MS,
      error: attestationError,
    });
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
  await attestProviderHealth(providerId, endpoint, token);
  let lastError: ProviderRequestError | null = null;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(
        providerRequestUrl(endpoint, providerAction(providerId)),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            provider: providerId,
            sourceUrl: input.sourceUrl,
            sourceType: input.sourceType,
            durationSeconds: input.durationSeconds,
          }),
          signal: AbortSignal.timeout(10 * 60_000),
        },
      );
      if (!response.ok) {
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
          return {
            payload,
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
  providerId: "BASIC_PITCH" | "MT3",
  payload: unknown,
  durationSeconds: number,
): TranscriptionAnalysisResult {
  if (!isRecord(payload)) throw new Error(`${providerId} response must be an object`);
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
    const velocity = value["velocity"];
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
  return {
    start,
    end,
    symbol: normalizedSymbol,
    roman: typeof roman === "string" ? roman.trim() : "",
    confidence: itemConfidence,
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
    const scores = new Map<string, {
      score: number;
      roman: string;
      strongest: number;
    }>();
    for (const { candidate, result } of active) {
      providersUsed.add(result.providerId);
      const current = scores.get(candidate.symbol) ?? {
        score: 0,
        roman: candidate.roman,
        strongest: 0,
      };
      const directScore = candidate.confidence * result.confidence;
      current.score += directScore;
      if (directScore > current.strongest) {
        current.strongest = directScore;
        current.roman = candidate.roman;
      }

      const pitchClasses = chordPitchClasses(candidate.symbol);
      const root = pitchClasses[0];
      if (root !== undefined) {
        const bassSupport = results.flatMap((item) => item.bass)
          .filter((note) => overlap(note, segment) && note.pitch % 12 === root)
          .reduce((sum, note) => sum + note.confidence, 0);
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
        current.score += Math.min(0.2, bassSupport * 0.08);
        current.score += Math.min(0.25, chromaSupport * 0.12);
        if (bassSupport > 0) {
          for (const provider of supportingBassProviders) providersUsed.add(provider);
        }
        if (chromaSupport > 0) {
          for (const item of overlappingChromaResults) {
            providersUsed.add(item.providerId);
          }
        }
      }
      scores.set(candidate.symbol, current);
    }
    const ranked = [...scores.entries()].sort((left, right) =>
      right[1].score - left[1].score || left[0].localeCompare(right[0]));
    const [symbol, winner] = ranked[0];
    const total = ranked.reduce((sum, item) => sum + item[1].score, 0);
    const fusedConfidence = total > 0
      ? Math.min(1, winner.score / total * 0.65 + winner.strongest * 0.35)
      : 0;
    const previous = segments[segments.length - 1];
    if (
      previous &&
      previous.symbol === symbol &&
      previous.roman === winner.roman &&
      Math.abs(previous.end - segment.start) < 0.001
    ) {
      previous.end = segment.end;
      previous.confidence = Number(
        ((previous.confidence + fusedConfidence) / 2).toFixed(4),
      );
    } else {
      segments.push({
        ...segment,
        symbol,
        roman: winner.roman,
        confidence: Number(fusedConfidence.toFixed(4)),
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
  const ranked = transcriptions
    .flatMap((result) => result.notes.map((note) => ({
      note,
      score: note.confidence * result.confidence,
    })))
    .sort((left, right) =>
      left.note.start - right.note.start ||
      right.score - left.score ||
      left.note.pitch - right.note.pitch);
  const accepted: MelodyNote[] = [];
  for (const candidate of ranked) {
    const duplicate = accepted.some((note) =>
      note.pitch === candidate.note.pitch &&
      Math.abs(note.start - candidate.note.start) <= 0.03 &&
      Math.abs(note.end - candidate.note.end) <= 0.05);
    if (!duplicate) accepted.push(candidate.note);
  }
  return accepted.sort((left, right) =>
    left.start - right.start || left.pitch - right.pitch);
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
    schedule(
      "SHEETSAGE",
      "harmony",
      (payload) => parseHarmony("SHEETSAGE", payload, input.durationSeconds),
      (result) => {
        harmony.push(result);
      },
    );
    schedule(
      "CHROMA",
      "harmony_evidence",
      (payload) => parseHarmony("CHROMA", payload, input.durationSeconds),
      (result) => {
        harmony.push(result);
      },
    );
    schedule(
      "BASS",
      "bass_evidence",
      (payload) => parseHarmony("BASS", payload, input.durationSeconds),
      (result) => {
        harmony.push(result);
      },
    );
  }
  if (wantsBasicPitch) {
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
    harmonyConfidence: fusedHarmony.confidence,
    provenance,
  };
}
