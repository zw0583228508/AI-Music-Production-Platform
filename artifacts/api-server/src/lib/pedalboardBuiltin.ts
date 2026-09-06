import { createHash } from "node:crypto";

const PROVIDER = "PEDALBOARD_BUILTIN";
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_WAV_BYTES = 25 * 1024 * 1024;

export type PedalboardProcessingEvidence = {
  provider: "PEDALBOARD_BUILTIN";
  version: string;
  parameters: { gainDb: number; thresholdDb: number };
  inputSha256: string;
  outputSha256: string;
  status: "processed";
};

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireWav(value: Buffer, label: string): void {
  if (value.length < 44 || value.length > MAX_WAV_BYTES || value.toString("ascii", 0, 4) !== "RIFF" ||
    value.toString("ascii", 8, 12) !== "WAVE" || value.readUInt32LE(4) + 8 !== value.length) {
    throw new Error(`Pedalboard ${label} is not a complete RIFF/WAV payload`);
  }
  let offset = 12;
  let format: { channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number } | undefined;
  let dataLength: number | undefined;
  while (offset + 8 <= value.length) {
    const size = value.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > value.length) throw new Error(`Pedalboard ${label} has a truncated WAV chunk`);
    const chunk = value.toString("ascii", offset, offset + 4);
    if (chunk === "fmt ") {
      if (size !== 16 || value.readUInt16LE(start) !== 1) {
        throw new Error(`Pedalboard ${label} must be PCM WAV`);
      }
      format = {
        channels: value.readUInt16LE(start + 2),
        sampleRate: value.readUInt32LE(start + 4),
        byteRate: value.readUInt32LE(start + 8),
        blockAlign: value.readUInt16LE(start + 12),
        bits: value.readUInt16LE(start + 14),
      };
    } else if (chunk === "data") {
      if (dataLength !== undefined) throw new Error(`Pedalboard ${label} has multiple data chunks`);
      dataLength = size;
    }
    offset = end + (size % 2);
  }
  if (offset !== value.length || !format || dataLength === undefined || !dataLength ||
    ![1, 2].includes(format.channels) || !format.sampleRate || format.bits !== 16 ||
    format.blockAlign !== format.channels * 2 ||
    format.byteRate !== format.sampleRate * format.blockAlign || dataLength % format.blockAlign !== 0) {
    throw new Error(`Pedalboard ${label} failed strict PCM WAV validation`);
  }
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !value.length || value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new Error("Pedalboard process returned invalid base64 audio");
  }
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value) {
    throw new Error("Pedalboard process returned non-canonical base64 audio");
  }
  return decoded;
}

function config(): { endpoint: string; headers: Record<string, string> } {
  const endpoint = process.env.MUSIC_AI_WORKER_URL ?? process.env.PEDALBOARD_BUILTIN_API_URL;
  if (!endpoint?.trim()) throw new Error("Pedalboard built-in worker is not configured");
  const token = process.env.MUSIC_AI_WORKER_TOKEN ?? process.env.PEDALBOARD_BUILTIN_API_TOKEN;
  if (!token?.trim()) {
    throw new Error("Pedalboard built-in worker authentication token is not configured");
  }
  return { endpoint, headers: { Authorization: `Bearer ${token}` } };
}

/** Applies the worker's built-in Pedalboard chain and verifies its complete evidence chain. */
export async function processPedalboardBuiltinWav(
  input: Buffer,
  parameters: { gainDb?: number; thresholdDb?: number } = {},
): Promise<{ data: Buffer; evidence: PedalboardProcessingEvidence }> {
  requireWav(input, "input");
  const worker = config();
  const gainDb = parameters.gainDb ?? 0;
  const thresholdDb = parameters.thresholdDb ?? -12;
  if (!Number.isFinite(gainDb) || gainDb < -36 || gainDb > 36 ||
    !Number.isFinite(thresholdDb) || thresholdDb < -60 || thresholdDb > 0) {
    throw new Error("Pedalboard processing parameters are outside permitted bounds");
  }
  const healthResponse = await fetch(
    new URL(`/health?provider=${PROVIDER}`, worker.endpoint),
    { headers: worker.headers, cache: "no-store", signal: AbortSignal.timeout(15_000) },
  );
  if (!healthResponse.ok) throw new Error(`Pedalboard health returned HTTP ${healthResponse.status}`);
  const health = await healthResponse.json() as Record<string, unknown>;
  if (health.status !== "ok" || health.healthy !== true || health.runtimeReady !== true ||
    health.packageReady !== true || health.checkpointReady !== true || health.smokeTested !== true ||
    health.provider !== PROVIDER || typeof health.modelVersion !== "string" || !health.modelVersion.trim()) {
    throw new Error("Pedalboard health response failed provider/version validation");
  }
  const response = await fetch(new URL("/process", worker.endpoint), {
    method: "POST",
    headers: { ...worker.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: PROVIDER, audio_base64: input.toString("base64"), gain_db: gainDb, threshold_db: thresholdDb }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Pedalboard process returned HTTP ${response.status}`);
  const result = await response.json() as Record<string, unknown>;
  if (result.provider !== PROVIDER || result.version !== health.modelVersion ||
    result.format !== "wav" || result.encoding !== "pcm_s16le") {
    throw new Error("Pedalboard process response failed provider/version validation");
  }
  const output = decodeBase64(result.audio_base64);
  requireWav(output, "output");
  const evidence: PedalboardProcessingEvidence = {
    provider: PROVIDER,
    version: health.modelVersion,
    parameters: { gainDb, thresholdDb },
    inputSha256: digest(input),
    outputSha256: digest(output),
    status: "processed",
  };
  if (!SHA256.test(evidence.inputSha256) || !SHA256.test(evidence.outputSha256)) {
    throw new Error("Pedalboard processing evidence hash is invalid");
  }
  return { data: output, evidence };
}