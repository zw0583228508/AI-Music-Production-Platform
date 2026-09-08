import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  analysisAttemptsTable,
  analysisJobsTable,
  db,
  musicArtifactsTable,
  musicProjectsTable,
  projectSourcesTable,
  songModelsTable,
  studioActivitiesTable,
  type AnalysisSection,
  type SongModelData,
  type SongModelField,
  type SongModelFieldStatus,
} from "@workspace/db";
import {
  fuseCanonicalNotes,
  runAnalysisProviders,
  analyzeVerifiedBassStem,
  configuredAnalysisProviderEndpoint,
  type SeparationAnalysisResult,
} from "./analysisProviders";
import { fuseProviderSongModels } from "./songModelValidation";
import { reconcileAnalysisField } from "./analysisReconciliation";
import {
  createSourceDownloadUrl,
  createAnalysisDownloadUrl,
  deleteAnalysisObjects,
  getSourceObject,
  saveAnalysisObject,
  saveSourceProxyObject,
} from "./objectStorage";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { logger } from "./logger";
import { deriveVocalPhrasing, detectVocalActivity, isEffectivelySilent } from "./audioSignal";
import { recordSheetSageCapacityRejection } from "./sheetSageCapacityAlerts";
import { buildMeterAwareEvidence, createCanonicalTimeline } from "./canonicalTimeline";
import { formatHostErrorMessage } from "./hostErrorDiagnostics";

export { isEffectivelySilent };

const execFileAsync = promisify(execFile);
const activeSourceJobs = new Set<string>();
const WORKER_ID = randomUUID();
const LEASE_MS = 2 * 60_000;
const ANALYSIS_HEARTBEAT_MS = 20_000;
const leaseDeadline = (now = new Date()): Date => new Date(now.getTime() + LEASE_MS);

class AnalysisLeaseLostError extends Error {
  constructor() {
    super("Analysis lease was lost to another worker");
  }
}

async function withProjectStorageWrite<T>(
  projectId: string,
  write: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}))`);
    const [project] = await tx
      .select({ id: musicProjectsTable.id })
      .from(musicProjectsTable)
      .where(eq(musicProjectsTable.id, projectId))
      .limit(1);
    if (!project) throw new AnalysisLeaseLostError();
    return write();
  });
}

async function claimAnalysisAttempt(sourceId: string) {
  const [existing] = await db
    .select()
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.id, sourceId))
    .limit(1);
  if (
    !existing
    || !["queued", "preprocessing", "analyzing"].includes(existing.status)
    || (existing.analysisLeaseExpiresAt && existing.analysisLeaseExpiresAt > new Date())
  ) {
    return null;
  }
  const now = new Date();
  const attemptId = randomUUID();
  return db.transaction(async (tx) => {
    const leaseMatches = existing.analysisLeaseId
      ? eq(projectSourcesTable.analysisLeaseId, existing.analysisLeaseId)
      : isNull(projectSourcesTable.analysisLeaseId);
    const [source] = await tx.update(projectSourcesTable)
      .set({
        analysisLeaseId: attemptId,
        analysisLeaseExpiresAt: leaseDeadline(now),
        updatedAt: now,
      })
      .where(and(
        eq(projectSourcesTable.id, sourceId),
        inArray(projectSourcesTable.status, ["queued", "preprocessing", "analyzing"]),
        leaseMatches,
        or(
          isNull(projectSourcesTable.analysisLeaseExpiresAt),
          lte(projectSourcesTable.analysisLeaseExpiresAt, now),
        ),
      ))
      .returning();
    if (!source) return null;
    const interruptionMessage =
      "The previous worker stopped heartbeating before this attempt finished.";
    const interrupted = await tx.update(analysisAttemptsTable)
      .set({
        status: "interrupted",
        error: interruptionMessage,
        completedAt: now,
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(analysisAttemptsTable.sourceId, source.id),
        inArray(analysisAttemptsTable.status, ["queued", "running"]),
      ))
      .returning({ id: analysisAttemptsTable.id });
    await tx.update(analysisJobsTable)
      .set({
        status: "failed",
        error: interruptionMessage,
        leaseExpiresAt: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(analysisJobsTable.sourceId, source.id),
        inArray(analysisJobsTable.status, ["queued", "running"]),
      ));
    const [latest] = await tx
      .select({ attemptNumber: analysisAttemptsTable.attemptNumber })
      .from(analysisAttemptsTable)
      .where(eq(analysisAttemptsTable.sourceId, source.id))
      .orderBy(desc(analysisAttemptsTable.attemptNumber))
      .limit(1);
    const [latestJob] = await tx
      .select({ attemptNumber: analysisJobsTable.attempt })
      .from(analysisJobsTable)
      .where(eq(analysisJobsTable.sourceId, source.id))
      .orderBy(desc(analysisJobsTable.attempt))
      .limit(1);
    const attemptNumber = Math.max(
      latest?.attemptNumber ?? 0,
      latestJob?.attemptNumber ?? 0,
    ) + 1;
    const [attempt] = await tx.insert(analysisAttemptsTable).values({
      id: attemptId,
      projectId: source.projectId,
      sourceId: source.id,
      attemptNumber,
      status: "queued",
      stage: "queued",
      progress: 0,
      heartbeatAt: now,
    }).returning();
    await tx.insert(analysisJobsTable).values({
      id: attemptId,
      projectId: source.projectId,
      sourceId: source.id,
      status: "queued",
      stage: "queued",
      progress: 0,
      attempt: attemptNumber,
      workerId: attemptId,
      leaseVersion: 1,
      leaseExpiresAt: leaseDeadline(now),
    });
    return { source, attempt, resumed: interrupted.length > 0 };
  });
}

async function heartbeatAnalysisLease(
  sourceId: string,
  attemptId: string,
): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [source] = await tx.update(projectSourcesTable)
      .set({ analysisLeaseExpiresAt: leaseDeadline(now), updatedAt: now })
      .where(and(
        eq(projectSourcesTable.id, sourceId),
        eq(projectSourcesTable.analysisLeaseId, attemptId),
        gt(projectSourcesTable.analysisLeaseExpiresAt, now),
      ))
      .returning({ id: projectSourcesTable.id });
    if (!source) return false;
    await tx.update(analysisAttemptsTable)
      .set({ heartbeatAt: now, updatedAt: now })
      .where(eq(analysisAttemptsTable.id, attemptId));
    await tx.update(analysisJobsTable)
      .set({ leaseExpiresAt: leaseDeadline(now), updatedAt: now })
      .where(eq(analysisJobsTable.id, attemptId));
    return true;
  });
}

async function interruptAttempt(attemptId: string, message: string): Promise<void> {
  const now = new Date();
  await db.update(analysisAttemptsTable)
    .set({
      status: "interrupted",
      error: message,
      completedAt: now,
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(analysisAttemptsTable.id, attemptId),
      inArray(analysisAttemptsTable.status, ["queued", "running"]),
    ));
  await db.update(analysisJobsTable)
    .set({
      status: "failed",
      error: message,
      leaseExpiresAt: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(analysisJobsTable.id, attemptId),
      inArray(analysisJobsTable.status, ["queued", "running"]),
    ));
}

type Probe = {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    sample_rate?: string;
    channels?: number;
  }>;
};

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

async function fingerprintFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function energyCurve(samples: Float32Array, bins = 24): number[] {
  if (!samples.length) return Array.from({ length: bins }, () => 0.3);
  const values = Array.from({ length: bins }, (_, index) => {
    const start = Math.floor((index / bins) * samples.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / bins) * samples.length));
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (end - start));
  });
  const max = Math.max(...values, 0.0001);
  return values.map((value) => Number(Math.min(1, value / max).toFixed(3)));
}

function estimateBpm(samples: Float32Array, sampleRate: number): number {
  const hop = 512;
  const frame = 1024;
  const envelope: number[] = [];
  let previous = 0;
  for (let start = 0; start + frame < samples.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + frame; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / frame);
    envelope.push(Math.max(0, rms - previous));
    previous = rms;
  }
  if (envelope.length < 16) return 120;
  let bestBpm = 120;
  let bestScore = -Infinity;
  for (let bpm = 60; bpm <= 180; bpm += 1) {
    const lag = Math.round((60 * sampleRate) / (bpm * hop));
    let score = 0;
    for (let i = lag; i < envelope.length; i += 1) {
      score += envelope[i] * envelope[i - lag];
    }
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return bestBpm;
}

function detectEnergyEvidence(
  samples: Float32Array,
): { values: number[]; confidence: number } | null {
  if (!samples.length) return null;
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= samples.length;
  let centeredEnergy = 0;
  let active = 0;
  for (const sample of samples) {
    const centered = sample - mean;
    centeredEnergy += centered * centered;
    if (Math.abs(centered) > 0.002) active += 1;
  }
  const rms = Math.sqrt(centeredEnergy / samples.length);
  const activeRatio = active / samples.length;
  if (rms < 0.001 || activeRatio < 0.005) return null;
  return {
    values: energyCurve(samples),
    confidence: Number(Math.min(0.82, 0.35 + rms * 8 + activeRatio).toFixed(2)),
  };
}
async function providerStemData(
  stem: SeparationAnalysisResult["stems"][number],
  providerId: SeparationAnalysisResult["providerId"],
): Promise<Buffer> {
  const maxBytes = 512 * 1024 * 1024;
  if (stem.contentBase64) {
    const normalized = stem.contentBase64.replace(/^data:[^;]+;base64,/, "");
    if (!normalized || !/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) {
      throw new Error(`${providerId} returned invalid base64 for ${stem.role}`);
    }
    if (normalized.length * 0.75 > maxBytes) {
      throw new Error(`${providerId} ${stem.role} stem is too large`);
    }
    const data = Buffer.from(normalized, "base64");
    if (!data.length) throw new Error(`${providerId} returned an empty ${stem.role} stem`);
    return data;
  }
  if (!stem.downloadUrl) {
    throw new Error(`${providerId} did not provide audio for ${stem.role}`);
  }
  const response = await fetch(stem.downloadUrl, {
    signal: AbortSignal.timeout(10 * 60_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`${providerId} ${stem.role} download returned HTTP ${response.status}`);
  }
  const providerEndpoint = configuredAnalysisProviderEndpoint(providerId);
  if (
    !providerEndpoint ||
    new URL(response.url).origin !== new URL(providerEndpoint).origin
  ) {
    throw new Error(`${providerId} ${stem.role} download left the provider origin`);
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) {
    throw new Error(`${providerId} ${stem.role} stem is too large`);
  }
  if (!response.body) {
    throw new Error(`${providerId} returned an empty ${stem.role} response`);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${providerId} ${stem.role} stem is too large`);
    }
    chunks.push(Buffer.from(value));
  }
  const data = Buffer.concat(chunks, total);
  if (!data.length) throw new Error(`${providerId} returned an empty ${stem.role} stem`);
  return data;
}

async function validateStemAudio(
  data: Buffer,
  path: string,
  role: string,
  providerId: SeparationAnalysisResult["providerId"],
  sourceDurationSeconds: number,
): Promise<void> {
  await writeFile(path, data);
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json",
    path,
  ], { maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(stdout) as Probe;
  const duration = Number(probe.format?.duration || 0);
  const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio");
  const minimumDuration = Math.max(0.25, sourceDurationSeconds * 0.7);
  const maximumDuration = sourceDurationSeconds +
    Math.max(5, sourceDurationSeconds * 0.1);
  if (
    !hasAudio ||
    !Number.isFinite(duration) ||
    duration < minimumDuration ||
    duration > maximumDuration
  ) {
    throw new Error(`${providerId} ${role} stem failed audio validation`);
  }
}

async function persistSeparationStems(
  result: SeparationAnalysisResult,
  projectId: string,
  analysisJobId: string,
  directory: string,
  sourceDurationSeconds: number,
): Promise<SongModelData["sourceStems"]> {
  return Promise.all(result.stems.map(async (stem) => {
    const data = await providerStemData(stem, result.providerId);
    await validateStemAudio(
      data,
      join(directory, `verified-${stem.role}.${stem.extension}`),
      stem.role,
      result.providerId,
      sourceDurationSeconds,
    );
    const objectPath = await withProjectStorageWrite(
      projectId,
      () => saveAnalysisObject(
        projectId,
        analysisJobId,
        `${stem.role}.${stem.extension}`,
        data,
        stem.contentType,
      ),
    );
    return {
      role: stem.role,
      objectPath,
      provider: result.providerId,
      confidence: stem.confidence,
      checksum: createHash("sha256").update(data).digest("hex"),
    };
  }));
}

const isVocalStemRole = (role: string): boolean =>
  /^(vocal|vocals|voice)$/i.test(role.trim());

async function deriveVocalEvidence(
  separation: SeparationAnalysisResult | null,
  sourceStems: SongModelData["sourceStems"],
  directory: string,
  durationSeconds: number,
): Promise<NonNullable<SongModelData["vocalEvidence"]>> {
  const sourceStem = sourceStems.find((stem) => isVocalStemRole(stem.role));
  const providerStem = separation?.stems.find((stem) =>
    sourceStem?.provider === separation.providerId && stem.role === sourceStem.role
  );
  if (!sourceStem || !providerStem) {
    return {
      status: "not_available",
      reason: "No verified vocal or voice stem bytes are available; full-mix and inferred evidence are forbidden.",
      provenance: null,
      sampleRate: null,
      channels: null,
      frameSizeSamples: null,
      thresholds: null,
      observedVoicedWindows: [],
      observedSilentWindows: [],
    };
  }
  try {
    const stemPath = join(directory, `verified-${providerStem.role}.${providerStem.extension}`);
    const sampleRate = 8_000;
    const { stdout: pcm } = await execFileAsync("ffmpeg", [
      "-v", "error", "-i", stemPath, "-ac", "1", "-ar", String(sampleRate),
      "-f", "f32le", "pipe:1",
    ], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
    if (!samples.length) throw new Error("The verified vocal stem decoded to no PCM frames.");
    const activity = detectVocalActivity(samples, sampleRate);
    const bounded = (windows: Array<{ start: number; end: number }>) => windows.map((window) => ({
      start: window.start,
      end: Math.min(durationSeconds, window.end),
    })).filter((window) => window.end > window.start);
    return {
      status: activity.status,
      reason: activity.status === "detected"
        ? null
        : "Verified vocal stem PCM contains no frames above the configured voiced-activity thresholds.",
      provenance: {
        sourceStemRole: sourceStem.role,
        objectPath: sourceStem.objectPath,
        provider: sourceStem.provider,
        ...(sourceStem.checksum ? { contentChecksum: sourceStem.checksum } : {}),
      },
      sampleRate,
      channels: 1,
      frameSizeSamples: activity.frameSizeSamples,
      thresholds: activity.thresholds,
      observedVoicedWindows: bounded(activity.observedVoicedWindows),
      observedSilentWindows: bounded(activity.observedSilentWindows),
    };
  } catch {
    return {
      status: "failed",
      reason: "Verified vocal stem PCM could not be decoded.",
      provenance: {
        sourceStemRole: sourceStem.role,
        objectPath: sourceStem.objectPath,
        provider: sourceStem.provider,
        ...(sourceStem.checksum ? { contentChecksum: sourceStem.checksum } : {}),
      },
      sampleRate: null,
      channels: null,
      frameSizeSamples: null,
      thresholds: null,
      observedVoicedWindows: [],
      observedSilentWindows: [],
    };
  }
}

function derivePhraseLevelVocalIntelligence(
  vocalEvidence: NonNullable<SongModelData["vocalEvidence"]>,
  melody: SongModelData["melody"],
  lyrics: SongModelData["lyrics"],
  sections: AnalysisSection[],
  tempoMap: SongModelData["tempoMap"],
  meterMap: SongModelData["meterMap"],
  durationSeconds: number,
): NonNullable<SongModelData["vocalIntelligence"]> {
  const unavailable = (reason: string): NonNullable<SongModelData["vocalIntelligence"]> => ({
    version: "1.0",
    provenance: vocalEvidence.provenance,
    phrases: { status: "not_available", reason, events: [] },
    breaths: { status: "not_available", reason, events: [] },
    lyricAlignment: { status: "not_available", reason: "No accepted vocal phrases and timed lyrics are both available.", alignments: [] },
    melodyAlignment: { status: "not_available", reason: "No accepted vocal phrases and compatible melody notes are both available.", alignments: [] },
    arrangementSpace: { status: "not_available", reason, windows: [] },
  });
  if (vocalEvidence.status !== "detected" || !vocalEvidence.provenance) {
    return unavailable(vocalEvidence.reason || "Verified vocal activity was not detected.");
  }
  const phrasing = deriveVocalPhrasing({
    status: "detected",
    frameSizeSamples: vocalEvidence.frameSizeSamples!,
    thresholds: vocalEvidence.thresholds!,
    observedVoicedWindows: vocalEvidence.observedVoicedWindows,
    observedSilentWindows: vocalEvidence.observedSilentWindows,
  });
  const phrases = phrasing.phrases.map((event, index) => ({ ...event, id: `phrase-${index + 1}` }));
  if (!phrases.length) return unavailable("Verified vocal activity did not contain a bounded phrase.");
  const overlaps = (start: number, end: number, itemStart: number, itemEnd: number) =>
    Math.min(end, itemEnd) - Math.max(start, itemStart) > 0;
  const alignment = <T extends { start: number; end: number }>(items: T[]) =>
    phrases.map((phrase) => items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => overlaps(phrase.start, phrase.end, item.start, item.end))
      .map(({ index }) => index));
  const lyricMatches = alignment(lyrics);
  const melodyMatches = alignment(melody);
  const hasLyricMatches = lyricMatches.some((matches) => matches.length > 0);
  const hasMelodyMatches = melodyMatches.some((matches) => matches.length > 0);
  const hasConflictingOverlap = <T extends { start: number; end: number }>(items: T[]) =>
    items.some((item, index) => items.some((other, otherIndex) =>
      otherIndex > index && overlaps(item.start, item.end, other.start, other.end)));
  const timeline = createCanonicalTimeline(tempoMap, meterMap);
  const spaces = vocalEvidence.observedSilentWindows
    .filter((window) => window.end - window.start >= .5)
    .map((window, index) => {
      const before = [...phrases].reverse().find((phrase) => phrase.end <= window.start);
      const after = phrases.find((phrase) => phrase.start >= window.end);
      const startBar = timeline.coordinateAtSeconds(window.start).bar;
      const endBar = timeline.coordinateAtSeconds(Math.min(durationSeconds, window.end)).bar;
      return {
        ...window,
        id: `space-${index + 1}`,
        confidence: .8,
        phraseBeforeId: before?.id ?? null,
        phraseAfterId: after?.id ?? null,
        bars: Array.from({ length: endBar - startBar + 1 }, (_, offset) => startBar + offset),
        sections: sections
          .filter((section) => section.endBar >= startBar && section.startBar <= endBar)
          .map((section) => section.name),
      };
    });
  const lyricConflict = hasConflictingOverlap(lyrics);
  const melodyConflict = hasConflictingOverlap(melody);
  return {
    version: "1.0",
    provenance: vocalEvidence.provenance,
    phrases: { status: "detected", reason: null, events: phrases },
    breaths: {
      status: phrasing.breaths.length ? "detected" : "not_available",
      reason: phrasing.breaths.length ? null : "No bounded inter-phrase pause met the breath thresholds.",
      events: phrasing.breaths.map((event, index) => ({ ...event, id: `breath-${index + 1}` })),
    },
    lyricAlignment: {
      status: !lyrics.length || !hasLyricMatches ? "not_available" : lyricConflict ? "conflicting" : "aligned",
      reason: !lyrics.length ? "No timed lyric evidence is available." : !hasLyricMatches ? "Timed lyrics do not overlap an accepted vocal phrase." : lyricConflict ? "Timed lyric evidence overlaps and cannot be aligned deterministically." : null,
      alignments: !hasLyricMatches || lyricConflict ? [] : phrases.map((phrase, index) => ({
        phraseId: phrase.id, lyricIndexes: lyricMatches[index], confidence: .8,
      })).filter((item) => item.lyricIndexes.length),
    },
    melodyAlignment: {
      status: !melody.length || !hasMelodyMatches ? "not_available" : melodyConflict ? "conflicting" : "aligned",
      reason: !melody.length ? "No compatible melody evidence is available." : !hasMelodyMatches ? "Melody notes do not overlap an accepted vocal phrase." : melodyConflict ? "Melody evidence overlaps and cannot be aligned deterministically." : null,
      alignments: !hasMelodyMatches || melodyConflict ? [] : phrases.map((phrase, index) => ({
        phraseId: phrase.id, melodyIndexes: melodyMatches[index], confidence: .8,
      })).filter((item) => item.melodyIndexes.length),
    },
    arrangementSpace: {
      status: spaces.length ? "detected" : "not_available",
      reason: spaces.length ? null : "No verified silent window long enough for arrangement space was detected.",
      windows: spaces,
    },
  };
}

type MidiEvent = {
  tick: number;
  type: "tempo" | "meter" | "key" | "note";
  data: number[];
  channel?: number;
  track?: number;
};
/*
async function retiredAnalysisPath(sourceId: string): Promise<void> {
  if (activeSourceJobs.has(sourceId)) return;
  activeSourceJobs.add(sourceId);
  const [source] = await db
    .select()
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.id, sourceId))
    .limit(1);
  if (!source) {
    activeSourceJobs.delete(sourceId);
    return;
  }
  const [existingJob] = await db
    .select()
    .from(analysisJobsTable)
    .where(eq(analysisJobsTable.sourceId, source.id))
    .orderBy(desc(analysisJobsTable.createdAt))
    .limit(1);
  const queuedJob = existingJob ?? (await db.insert(analysisJobsTable).values({
    id: randomUUID(),
    projectId: source.projectId,
    sourceId: source.id,
    status: "queued",
    stage: "queued",
    progress: source.progress,
  }).returning())[0];
  if (!queuedJob) {
    activeSourceJobs.delete(sourceId);
    return;
  }
  const [job] = await db.update(analysisJobsTable)
    .set({
      status: "running",
      stage: "downloading",
      progress: 8,
      error: null,
      workerId: WORKER_ID,
      leaseVersion: sql`${analysisJobsTable.leaseVersion} + 1`,
      leaseExpiresAt: leaseDeadline(),
      startedAt: queuedJob.startedAt ?? new Date(),
      finishedAt: null,
    })
    .where(and(
      eq(analysisJobsTable.id, queuedJob.id),
      or(
        eq(analysisJobsTable.status, "queued"),
        and(
          eq(analysisJobsTable.status, "running"),
          or(
            isNull(analysisJobsTable.leaseExpiresAt),
            lte(analysisJobsTable.leaseExpiresAt, new Date()),
          ),
        ),
      ),
    ))
    .returning();
  if (!job) {
    activeSourceJobs.delete(sourceId);
    return;
  }
  class LeaseLostError extends Error {}
  const ownedLease = () => and(
    eq(analysisJobsTable.id, job.id),
    eq(analysisJobsTable.workerId, WORKER_ID),
    eq(analysisJobsTable.leaseVersion, job.leaseVersion),
    eq(analysisJobsTable.status, "running"),
    gt(analysisJobsTable.leaseExpiresAt, new Date()),
  );
  const updateOwnedStage = async (
    stage: string,
    progress: number,
    sourceValues?: Partial<typeof projectSourcesTable.$inferInsert>,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      const [owned] = await tx.update(analysisJobsTable)
        .set({ stage, progress, leaseExpiresAt: leaseDeadline() })
        .where(ownedLease())
        .returning({ id: analysisJobsTable.id });
      if (!owned) throw new LeaseLostError("Analysis lease was transferred to another worker");
      if (sourceValues) {
        await tx.update(projectSourcesTable)
          .set(sourceValues)
          .where(eq(projectSourcesTable.id, source.id));
      }
    });
  };

  const heartbeat = setInterval(() => {
    void db.update(analysisJobsTable)
      .set({ leaseExpiresAt: leaseDeadline() })
      .where(and(
        eq(analysisJobsTable.id, job.id),
        eq(analysisJobsTable.workerId, WORKER_ID),
        eq(analysisJobsTable.leaseVersion, job.leaseVersion),
        eq(analysisJobsTable.status, "running"),
      ))
      .catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  let directory: string | null = null;
  let hasUncommittedAnalysisObjects = false;
  const suffix = extname(source.name).replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
  try {
    directory = await mkdtemp(join(tmpdir(), "studio-source-"));
    const inputPath = join(directory, `source${suffix}`);
    await updateOwnedStage("downloading", 8, {
      status: "preprocessing",
      progress: 15,
      error: null,
    });

    const object = await getSourceObject(source.objectPath);
    if (!object) throw new Error("Uploaded object was not found");
    const objectStream = object.createReadStream();
    objectStream.setMaxListeners(20);
    await pipeline(objectStream, createWriteStream(inputPath));
    await updateOwnedStage("probing", 24);

    const { stdout: probeStdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,sample_rate,channels",
      "-of", "json",
      inputPath,
    ], { maxBuffer: 4 * 1024 * 1024 });
    const probe = JSON.parse(probeStdout) as Probe;
    const audioStream = probe.streams?.find((stream) => stream.codec_type === "audio");
    const durationSeconds = Math.max(1, Number(probe.format?.duration || 0));
    const sourceSampleRate = Number(audioStream?.sample_rate || 44_100);
    const channels = audioStream?.channels || 2;

    await updateOwnedStage("signal_analysis", 48, {
        status: "analyzing",
        progress: 48,
        durationSeconds,
        sampleRate: sourceSampleRate,
        channels,
      });

    const decodeRate = 8_000;
    const { stdout: pcmBuffer } = await execFileAsync("ffmpeg", [
      "-v", "error",
      "-i", inputPath,
      "-t", "900",
      "-ac", "1",
      "-ar", String(decodeRate),
      "-f", "f32le",
      "pipe:1",
    ], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
    const floatLength = Math.floor(pcmBuffer.byteLength / 4);
    const samples = new Float32Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      floatLength,
    );
    await updateOwnedStage("validating_audio", 56);
    if (isEffectivelySilent(samples)) {
      throw new Error(
        "No audible audio was detected in this upload. Please upload a recording with audible sound.",
      );
    }
    const fingerprint = await fingerprintFile(inputPath);
    const energy = energyCurve(samples);
    let bpm = estimateBpm(samples, decodeRate);
    let key = estimateKey(samples, decodeRate, fingerprint);
    let meter = "4/4";
    let sections = makeSections(durationSeconds, bpm, energy);
    let secondsPerBeat = 60 / bpm;
    const beatCount = Math.max(1, Math.floor(durationSeconds / secondsPerBeat));
    let beats = Array.from({ length: beatCount }, (_, index) => ({
      time: Number((index * secondsPerBeat).toFixed(4)),
      beat: (index % 4) + 1,
      bar: Math.floor(index / 4) + 1,
      confidence: 0.68,
    }));
    let bars = Array.from(
      { length: Math.max(1, Math.ceil(beatCount / 4)) },
      (_, index) => ({
        bar: index + 1,
        start: Number((index * secondsPerBeat * 4).toFixed(4)),
        end: Number(Math.min(durationSeconds, (index + 1) * secondsPerBeat * 4).toFixed(4)),
        beats: 4,
        confidence: 0.68,
      }),
    );
    const confidence = Number(
      Math.min(0.94, 0.62 + Math.log10(Math.max(10, samples.length)) / 30).toFixed(2),
    );
    await updateOwnedStage("provider_analysis", 68);
    const providerEndpointKeys = ["FULL_SONG", "INSTRUMENTAL", "VIDEO"].includes(
      source.sourceType,
    )
      ? [
          "ALL_IN_ONE_API_URL",
          "MT3_API_URL",
           "DEMUCS_API_URL",
          "BS_ROFORMER_API_URL",
          "SHEET_SAGE_API_URL",
        ]
      : ["BASIC_PITCH_API_URL", "SHEET_SAGE_API_URL"];
    const needsProviderSource = providerEndpointKeys.some((key) => Boolean(process.env[key]));
    let sourceUrl: string | null = null;
    if (needsProviderSource) {
      try {
        sourceUrl = await createSourceDownloadUrl(source.objectPath);
      } catch {
        sourceUrl = null;
      }
    }
    const providerResults = await runAnalysisProviders({
      sourceUrl,
      sourceType: source.sourceType,
      durationSeconds,
      idempotencyKey: job.id,
      onSheetSageCapacityRejection: recordSheetSageCapacityRejection,
    });
    const primaryTranscription = providerResults.transcriptions[0] ?? null;
    if (providerResults.structure) {
      bpm = providerResults.structure.bpm;
      meter = providerResults.structure.meter;
      beats = providerResults.structure.beats;
      bars = providerResults.structure.bars;
      sections = providerResults.structure.sections;
    }
    const successfulAnalysisProviders: string[] = [];
    if (providerResults.structure) {
      successfulAnalysisProviders.push(providerResults.structure.providerId);
    }
    if (primaryTranscription) {
      successfulAnalysisProviders.push(primaryTranscription.providerId);
    }
    if (providerResults.separation) {
      successfulAnalysisProviders.push(providerResults.separation.providerId);
    }
    successfulAnalysisProviders.push(
      ...providerResults.harmony.map((item) => item.providerId),
    );
    const providerConfidences = [
      providerResults.structure?.confidence,
      primaryTranscription?.confidence,
      providerResults.separation?.confidence,
      providerResults.harmonyConfidence,
    ].filter((value): value is number => value !== undefined);
    const candidateConfidence = providerConfidences.length
      ? Number(
          (
            (confidence + providerConfidences.reduce((sum, value) => sum + value, 0)) /
            (providerConfidences.length + 1)
          ).toFixed(3),
        )
      : confidence;
    const candidate = {
      audio: {
        name: source.name,
        contentType: source.contentType,
        size: source.size,
        durationSeconds,
        sampleRate: sourceSampleRate,
        channels,
      },
      tempoMap: [{ time: 0, bpm, confidence }],
      meterMap: [{
        bar: 1,
        meter,
        confidence: providerResults.structure?.confidence ?? 0.74,
      }],
      keyMap: [{ time: 0, key, confidence: Math.max(0.5, confidence - 0.12) }],
      beats,
      bars,
      melody: fuseCanonicalNotes(providerResults.transcriptions),
      bass: providerResults.bassEvidence,
      chords: providerResults.chords,
      sections,
      energy,
      dynamics: energy,
      sourceStems: [],
      lyrics: [],
      confidenceByField: {
        tempo: providerResults.structure?.confidence ?? confidence,
        meter: providerResults.structure?.confidence ?? 0.74,
        key: Math.max(0.5, confidence - 0.12),
        structure: providerResults.structure?.confidence ?? 0.58,
        melody: primaryTranscription?.confidence ?? 0,
        harmony: providerResults.harmonyConfidence,
      },
      provenance: [
        {
          capability: "preprocessing",
          provider: "FFMPEG",
          version: "system",
          status: "ready",
        },
        {
          capability: providerResults.structure ? "key_analysis" : "structure",
          provider: "LOCAL_SIGNAL_ANALYZER_V1",
          version: "1.0.0",
          status: "fallback",
        },
        ...providerResults.provenance,
      ],
    };
    const fusion = fuseProviderSongModels([{
      provider: successfulAnalysisProviders.join("+") || "LOCAL_SIGNAL_ANALYZER_V1",
      output: candidate,
      confidence: candidateConfidence,
    }]);
    if (!fusion.accepted) {
      throw new Error(
        `Analysis providers returned an invalid Song Model. ${
          fusion.issues.map((item) => item.message).join(" ")
        }`,
      );
    }
    const model = fusion.model;
    bpm = model.tempoMap[0].bpm;
    meter = model.meterMap[0].meter;
    key = model.keyMap[0].key;
    sections = model.sections;
    const persistedProviders = fusion.decisions.map((decision) => decision.provider);
    const fusedConfidence = model.fusion.confidence;
    await updateOwnedStage("persisting_song_model", 88);
    const songModelId = randomUUID();
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${source.projectId}))`,
      );
      const [claimedSource] = await tx.update(projectSourcesTable)
        .set({
          status: "ready",
          progress: 100,
          error: null,
          analysisLeaseId: null,
          analysisLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(projectSourcesTable.id, source.id),
          eq(projectSourcesTable.analysisLeaseId, job.id),
          gt(projectSourcesTable.analysisLeaseExpiresAt, now),
        ))
        .returning({ id: projectSourcesTable.id });
      if (!claimedSource) {
        throw new LeaseLostError("Analysis lease was transferred before commit");
      }
      const [previous] = await tx
        .select({ version: songModelsTable.version })
        .from(songModelsTable)
        .where(eq(songModelsTable.projectId, source.projectId))
        .orderBy(desc(songModelsTable.version))
        .limit(1);
      const version = (previous?.version ?? 0) + 1;
      await tx.insert(songModelsTable).values({
        id: songModelId,
        projectId: source.projectId,
        sourceId: source.id,
        analysisJobId: job.id,
        version,
        model,
        providers: persistedProviders,
        confidence: fusedConfidence,
      });
      await tx.update(musicProjectsTable)
        .set({
          sourceName: source.name,
          sourceType: source.sourceType,
          status: "ready",
          duration: formatDuration(durationSeconds),
          bpm,
          key,
          meter,
          confidence: fusedConfidence,
          sections,
          energy,
          providers: persistedProviders,
          updatedAt: now,
        })
        .where(eq(musicProjectsTable.id, source.projectId));
      await tx.insert(musicArtifactsTable).values([
        {
          id: randomUUID(),
          projectId: source.projectId,
          type: "SOURCE",
          label: source.name,
          version,
          size: `${(source.size / 1024 / 1024).toFixed(1)} MB`,
          format: suffix.slice(1).toUpperCase(),
        },
        {
          id: randomUUID(),
          projectId: source.projectId,
          type: "SONG_MODEL",
          label: "Canonical Song Model",
          version,
          size: `${Math.max(1, Math.round(JSON.stringify(model).length / 1024))} KB`,
          format: "JSON",
        },
      ]);
      await tx.insert(studioActivitiesTable).values({
        id: randomUUID(),
        projectId: source.projectId,
        title: "Song Model ready",
        detail: `${source.name} · ${bpm} BPM · ${key}`,
        type: "analysis",
      });
    });
  } catch (error) {
    if (error instanceof LeaseLostError) return;
    const message = formatHostErrorMessage(error, "Source analysis failed");
    await db.transaction(async (tx) => {
      const [failed] = await tx.update(analysisJobsTable)
        .set({
          status: "failed",
          stage: "failed",
          progress: 100,
          error: message,
          leaseExpiresAt: null,
          finishedAt: new Date(),
        })
        .where(ownedLease())
        .returning({ id: analysisJobsTable.id });
      if (!failed) return;
      await tx.update(projectSourcesTable)
        .set({ status: "failed", error: message, progress: 100 })
        .where(eq(projectSourcesTable.id, source.id));
      await tx.update(musicProjectsTable)
        .set({ status: "draft", updatedAt: new Date() })
        .where(eq(musicProjectsTable.id, source.projectId));
    });
  } finally {
    clearInterval(heartbeat);
    if (directory) await rm(directory, { recursive: true, force: true });
    activeSourceJobs.delete(sourceId);
  }
}
*/
export async function analyzeProjectSource(
  sourceId: string,
  attemptId?: string,
): Promise<void> {
  if (!attemptId) {
    await queueProjectSourceAnalysis(sourceId);
    return;
  }
  if (activeSourceJobs.has(sourceId)) return;
  activeSourceJobs.add(sourceId);
  const [source] = await db
    .select()
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.id, sourceId))
    .limit(1);
  if (!source) {
    activeSourceJobs.delete(sourceId);
    return;
  }
  const [attempt] = await db
    .select()
    .from(analysisAttemptsTable)
    .where(eq(analysisAttemptsTable.id, attemptId))
    .limit(1);
  if (!attempt || source.analysisLeaseId !== attempt.id) {
    activeSourceJobs.delete(sourceId);
    return;
  }
  const attemptStartedAt = attempt.startedAt ?? new Date();
  // Claim both records atomically.  The source lease is authoritative for an
  // analysis attempt; without this fence a stale process that read the source
  // just before recovery could still start its old analysis job and publish a
  // competing Song Model.
  const job = await db.transaction(async (tx) => {
    const now = new Date();
    const [ownedSource] = await tx.update(projectSourcesTable)
      .set({ analysisLeaseExpiresAt: leaseDeadline(now), updatedAt: now })
      .where(and(
        eq(projectSourcesTable.id, source.id),
        eq(projectSourcesTable.analysisLeaseId, attempt.id),
        gt(projectSourcesTable.analysisLeaseExpiresAt, now),
      ))
      .returning({ id: projectSourcesTable.id });
    if (!ownedSource) return null;
    const [claimedJob] = await tx.update(analysisJobsTable)
      .set({
        status: "running",
        stage: "downloading",
        progress: 8,
        error: null,
        workerId: attempt.id,
        leaseExpiresAt: leaseDeadline(now),
        startedAt: attemptStartedAt,
        finishedAt: null,
      })
      .where(and(
        eq(analysisJobsTable.id, attempt.id),
        eq(analysisJobsTable.workerId, attempt.id),
        eq(analysisJobsTable.status, "queued"),
      ))
      .returning();
    return claimedJob ?? null;
  });
  if (!job) {
    activeSourceJobs.delete(sourceId);
    return;
  }
  class LeaseLostError extends Error {}
  const ownedLease = () => and(
    eq(analysisJobsTable.id, attempt.id),
    eq(analysisJobsTable.workerId, attempt.id),
    eq(analysisJobsTable.leaseVersion, job.leaseVersion),
    eq(analysisJobsTable.status, "running"),
    gt(analysisJobsTable.leaseExpiresAt, new Date()),
  );
  let currentStage = "queued";
  let currentProgress = 0;
  const updateOwnedStage = async (
    stage: string,
    progress: number,
    sourceValues?: Partial<typeof projectSourcesTable.$inferInsert>,
  ): Promise<void> => {
    const canonicalStage = stage === "downloading"
      ? "preprocessing"
      : stage === "probing"
        ? "probing"
        : stage === "persisting_song_model"
          ? "persisting"
          : "analyzing";
    currentStage = canonicalStage;
    currentProgress = progress;
    const now = new Date();
    await db.transaction(async (tx) => {
      const [ownedSource] = await tx.update(projectSourcesTable)
        .set({
          ...sourceValues,
          analysisLeaseExpiresAt: leaseDeadline(now),
          updatedAt: now,
        })
        .where(and(
          eq(projectSourcesTable.id, source.id),
          eq(projectSourcesTable.analysisLeaseId, attempt.id),
          gt(projectSourcesTable.analysisLeaseExpiresAt, now),
        ))
        .returning({ id: projectSourcesTable.id });
      if (!ownedSource) {
        throw new LeaseLostError("Analysis lease was transferred to another worker");
      }
      await tx.update(analysisAttemptsTable)
        .set({
          status: "running",
          stage: canonicalStage,
          progress,
          heartbeatAt: now,
          startedAt: attemptStartedAt,
          updatedAt: now,
        })
        .where(eq(analysisAttemptsTable.id, attempt.id));
      await tx.update(analysisJobsTable)
        .set({ stage, progress, leaseExpiresAt: leaseDeadline(now), updatedAt: now })
        .where(ownedLease());
    });
    logger.info({
      sourceId: source.id,
      attemptId: attempt.id,
      stage: canonicalStage,
      progress,
    }, "music_analysis_stage_updated");
  };

  const heartbeat = setInterval(() => {
    void heartbeatAnalysisLease(source.id, attempt.id).catch((error) => {
      logger.error({
        errorMessage: formatHostErrorMessage(error, "Analysis heartbeat failed"),
        sourceId: source.id,
        attemptId: attempt.id,
      }, "music_analysis_heartbeat_failed");
    });
  }, ANALYSIS_HEARTBEAT_MS);
  heartbeat.unref();
  let directory: string | null = null;
  let hasUncommittedAnalysisObjects = false;
  const suffix = extname(source.name).replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
  try {
    directory = await mkdtemp(join(tmpdir(), "studio-source-"));
    const inputPath = join(directory, `source${suffix}`);
    await updateOwnedStage("downloading", 8, {
      status: "preprocessing",
      progress: 15,
      error: null,
    });

    const object = await getSourceObject(source.objectPath);
    if (!object) throw new Error("Uploaded object was not found");
    const objectStream = object.createReadStream();
    objectStream.setMaxListeners(20);
    await pipeline(objectStream, createWriteStream(inputPath));
    const sourceChecksum = await fingerprintFile(inputPath);
    await updateOwnedStage("probing", 24);

    const isMidi = /\.(mid|midi)$/i.test(source.name) ||
      ["audio/midi", "audio/x-midi", "audio/mid"].includes(source.contentType.toLowerCase());
    const midi = isMidi ? await parseMidi(inputPath) : null;
    let durationSeconds: number;
    let sourceSampleRate: number;
    let channels: number;
    if (midi) {
      ({ durationSeconds, sampleRate: sourceSampleRate, channels } = midi);
    } else {
      const { stdout: probeStdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration:stream=codec_type,sample_rate,channels",
        "-of", "json", inputPath,
      ], { maxBuffer: 4 * 1024 * 1024 });
      const probe = JSON.parse(probeStdout) as Probe;
      const audioStream = probe.streams?.find((stream) => stream.codec_type === "audio");
      if (!audioStream) throw new Error("The upload does not contain an audio stream");
      durationSeconds = Math.max(1, Number(probe.format?.duration || 0));
      sourceSampleRate = Number(audioStream.sample_rate || 44_100);
      channels = audioStream.channels || 2;
    }

    await updateOwnedStage("signal_analysis", 48, {
        status: "analyzing",
        progress: 48,
        durationSeconds,
        sampleRate: sourceSampleRate,
        channels,
      });

    const decodeRate = 8_000;
    const analysisDurationSeconds = Math.min(300, durationSeconds);
    const analysisStartSeconds = midi ? 0 : Math.max(0, (durationSeconds - analysisDurationSeconds) / 2);
    let samples = new Float32Array();
    let waveform: number[] = [];
    let normalizedObjectPath: string | null = null;
    let normalizedChecksum: string | null = null;
    if (!midi) {
      const { stdout: pcmBuffer } = await execFileAsync("ffmpeg", [
        "-v", "error", "-ss", String(analysisStartSeconds), "-i", inputPath,
        "-t", String(analysisDurationSeconds), "-ac", "1", "-ar", String(decodeRate),
        "-f", "f32le", "pipe:1",
      ], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
      samples = new Float32Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.byteLength / 4));
      await updateOwnedStage("validating_audio", 56);
      const overview = await fullDurationEnergy(inputPath, durationSeconds);
      // The detailed analysis window is deliberately capped. Do not reject a
      // long recording just because its audible material is outside that
      // representative window; reject only when both it and the complete
      // decode contain no audible signal.
      if (isEffectivelySilent(samples) && overview.isEffectivelySilent) {
        throw new Error("No audible audio was detected in this upload. Please upload a recording with audible sound.");
      }
      waveform = overview.values;
      const normalizedPath = join(directory, "normalized.flac");
      await execFileAsync("ffmpeg", ["-v", "error", "-i", inputPath, "-map", "0:a:0", "-c:a", "flac", normalizedPath]);
      normalizedChecksum = await fingerprintFile(normalizedPath);
      normalizedObjectPath = await withProjectStorageWrite(
        source.projectId,
        () => saveSourceProxyObject(source.id, normalizedPath, "audio/flac"),
      );
    }
    const energyDetection = midi ? null : detectEnergyEvidence(samples);
    const localTempo = midi ? null : detectTempoEvidence(samples, decodeRate);
    const keyDetection = midi ? null : detectKeyEvidence(samples, decodeRate);
    const energy = midi
      ? (() => {
          const values = Array.from({ length: Math.max(24, Math.min(1280, Math.ceil(durationSeconds / 2))) }, () => 0);
          for (const note of midi.melody) {
            const index = Math.min(values.length - 1, Math.floor(note.start / durationSeconds * values.length));
            values[index] += note.velocity / 127;
          }
          const max = Math.max(...values, 1);
          return values.map((value) => Number(Math.min(1, value / max).toFixed(3)));
        })()
      : waveform;
    if (midi) waveform = energy;
    let bpm = midi?.bpm ?? localTempo?.bpm ?? 0;
    let key = midi?.keyMap.length ? midi.key : keyDetection?.key ?? "—";
    let meter = midi?.meterMap.length ? midi.meter : "—";
    let sections: AnalysisSection[] = [];
    let beats = midi?.beats ?? [];
    let bars = midi?.bars ?? [];
    await updateOwnedStage("provider_analysis", 68);
    const needsProviderSource = !midi && [
      "BS_ROFORMER",
      "BS_ROFORMER_SW",
      "DEMUCS",
      "ALL_IN_ONE",
      "BASIC_PITCH",
      "MT3",
      "SHEETSAGE",
      "CHROMA",
      "BASS",
      "MADMOM",
      "TORCHCREPE",
      "ESSENTIA",
      "PYLOUDNORM",
    ].some((provider) => Boolean(configuredAnalysisProviderEndpoint(
      provider as Parameters<typeof configuredAnalysisProviderEndpoint>[0],
    )));
    let sourceUrl: string | null = null;
    if (needsProviderSource) {
      try {
        sourceUrl = await createSourceDownloadUrl(source.objectPath);
      } catch {
        sourceUrl = null;
      }
    }
    const providerResults = await runAnalysisProviders({
      sourceUrl,
      sourceType: source.sourceType,
      durationSeconds,
      idempotencyKey: job.id,
      onSheetSageCapacityRejection: recordSheetSageCapacityRejection,
    });
    let sourceStems: SongModelData["sourceStems"] =
      midi?.sourceStems.map((stem) => ({
        ...stem,
        objectPath: source.objectPath,
      })) ??
      (normalizedObjectPath ? [{
        role: "MIX",
        objectPath: normalizedObjectPath,
        provider: "FFMPEG",
        confidence: 1,
      }] : []);
    if (!midi && providerResults.separation) {
      try {
        sourceStems = await persistSeparationStems(
          providerResults.separation,
          source.projectId,
          job.id,
          directory,
          durationSeconds,
        );
        hasUncommittedAnalysisObjects = sourceStems.length > 0;
      } catch (error) {
        await deleteAnalysisObjects(source.projectId, job.id).catch(() => undefined);
        hasUncommittedAnalysisObjects = false;
        const message = formatHostErrorMessage(error, "Stem persistence failed");
        const provenance = providerResults.provenance.find((item) =>
          item.provider === providerResults.separation?.providerId
        );
        if (provenance) {
          provenance.status = "failed";
          provenance.errorCode = "stem-persistence-failed";
          provenance.errorMessage = message;
        }
        providerResults.separation = null;
        sourceStems = normalizedObjectPath ? [{
          role: "MIX",
          objectPath: normalizedObjectPath,
          provider: "FFMPEG",
          confidence: 1,
        }] : [];
      }
    }
    const vocalEvidence = midi
      ? {
          status: "not_available" as const,
          reason: "MIDI sources do not contain decoded vocal or voice stem PCM.",
          provenance: null,
          sampleRate: null,
          channels: null,
          frameSizeSamples: null,
          thresholds: null,
          observedVoicedWindows: [],
          observedSilentWindows: [],
        }
      : await deriveVocalEvidence(
          providerResults.separation,
          sourceStems,
          directory,
          durationSeconds,
        );
    if (!midi) {
      const verifiedBassStem = providerResults.separation?.providerId === "BS_ROFORMER"
        ? sourceStems.find((stem) =>
            stem.provider === "BS_ROFORMER" && stem.role.toLowerCase() === "bass")
        : undefined;
      if (verifiedBassStem) {
        await updateOwnedStage("bass_provider_analysis", 78);
        try {
          const bassSourceUrl = await createAnalysisDownloadUrl(
            verifiedBassStem.objectPath,
          );
          const bassPhase = await analyzeVerifiedBassStem({
            sourceUrl: bassSourceUrl,
            durationSeconds,
            idempotencyKey: attempt.id,
            sourceStem: verifiedBassStem.objectPath,
            sourceStemProvider: "BS_ROFORMER",
          });
          // This authoritative source/attempt fence occurs after both external
          // calls. A deleted project or superseded attempt cannot publish them.
          await updateOwnedStage("bass_provider_analysis_complete", 82);
          providerResults.bassEvidence = bassPhase.bassEvidence;
          providerResults.provenance.push(...bassPhase.provenance);
        } catch (error) {
          // Also fence the failure path so stale work cannot affect field state.
          await updateOwnedStage("bass_provider_analysis_complete", 82);
          providerResults.bassEvidence = [];
          providerResults.provenance.push({
            capability: "bass_evidence",
            provider: "BASS",
            version: "unavailable",
            status: "unavailable",
            attempts: 0,
            errorCode: "verified-stem-read-unavailable",
            errorMessage: formatHostErrorMessage(
              error,
              "The verified bass artifact could not be read.",
            ),
          });
        }
      } else {
        providerResults.bassEvidence = [];
        providerResults.provenance.push({
          capability: "bass_evidence",
          provider: "BASS",
          version: "unavailable",
          status: "unavailable",
          attempts: 0,
          errorCode: "verified-bs-roformer-bass-stem-unavailable",
          errorMessage: "No verified BS-RoFormer bass stem is available; full-mix fallback is forbidden.",
        });
      }
    }
    const tempoReconciliation = midi
      ? null
      : reconcileAnalysisField("tempo", [
          ...(providerResults.structure ? [{
            provider: providerResults.structure.providerId,
            value: providerResults.structure.bpm,
            confidence: providerResults.structure.confidence,
          }] : []),
          ...providerResults.rhythmEvidence.map((evidence) => ({
            provider: evidence.provider,
            value: evidence.tempoBpm,
            // Raw rhythm evidence has no provider-reported confidence; the
            // capability profile supplies its bounded weight.
          })),
          ...(localTempo ? [{
            provider: "LOCAL_SIGNAL_ANALYZER_V1",
            value: localTempo.bpm,
            confidence: localTempo.confidence,
          }] : []),
        ]);
    const meterReconciliation = midi
      ? null
      : reconcileAnalysisField("meter", providerResults.structure ? [{
          provider: providerResults.structure.providerId,
          value: providerResults.structure.meter,
          confidence: providerResults.structure.confidence,
        }] : []);
    const keyReconciliation = midi
      ? null
      : reconcileAnalysisField("key", [
          ...providerResults.keyEvidence.map((evidence) => ({
            provider: evidence.provider,
            value: `${evidence.key} ${evidence.scale}`.trim(),
            confidence: evidence.confidence,
          })),
          ...(keyDetection ? [{
            provider: "LOCAL_SIGNAL_ANALYZER_V1",
            value: keyDetection.key,
            confidence: keyDetection.confidence,
          }] : []),
        ]);
    if (!midi && providerResults.structure) {
      beats = providerResults.structure.beats;
      bars = providerResults.structure.bars;
      sections = providerResults.structure.sections;
    }
    bpm = midi?.bpm
      ?? providerResults.structure?.tempoMap[0]?.bpm
      ?? tempoReconciliation?.value
      ?? 0;
    meter = midi?.meterMap.length
      ? midi.meter
      : providerResults.structure?.meterMap[0]?.meter
        ?? meterReconciliation?.value
        ?? "—";
    key = midi?.keyMap.length ? midi.key : keyReconciliation?.value ?? "—";
    const melody = midi?.melody ??
      fuseCanonicalNotes(providerResults.transcriptions);
    const bass = midi ? [] : providerResults.bassEvidence;
    const bassProviders = [...new Set(bass.flatMap((note) =>
      note.providers?.length ? note.providers : note.provider ? [note.provider] : []
    ))];
    const bassConfidence = bass.length
      ? Math.max(...bass.map((note) => note.confidence))
      : 0;
    const confidenceByField = {
      tempo: midi ? 1 : tempoReconciliation?.confidence ?? 0,
      meter: midi?.meterMap.length ? 1 : meterReconciliation?.confidence ?? 0,
      key: midi?.keyMap.length ? 1 : keyReconciliation?.confidence ?? 0,
      structure: providerResults.structure?.confidence ?? 0,
      melody: midi
        ? 1
        : providerResults.transcriptions.length
          ? Math.max(...providerResults.transcriptions.map((item) => item.confidence))
          : 0,
      bass: bassConfidence,
      harmony: midi ? 0 : providerResults.harmonyConfidence,
      separation: midi ? 1 : providerResults.separation?.confidence ?? 0,
      energy: midi ? 1 : energyDetection?.confidence ?? 0,
    };
    const structureProvider = providerResults.structure?.providerId;
    const melodyProviders = midi
      ? ["STANDARD_MIDI"]
      : [...new Set(providerResults.transcriptions.map((item) => item.providerId))];
    const harmonyProviders = [...new Set(providerResults.harmony.map((item) => item.providerId))];
    const fieldStatus: Record<SongModelField, SongModelFieldStatus> = {
      tempo: {
        status: midi ? "detected" : tempoReconciliation?.status ?? "not_available",
        confidence: confidenceByField.tempo || null,
        providers: midi ? ["STANDARD_MIDI"] : tempoReconciliation?.providers ?? [],
        message: midi ? null : tempoReconciliation?.message ??
          "No usable periodic tempo evidence was detected.",
        edited: false,
      },
      meter: {
        status: midi?.meterMap.length ? "detected" : meterReconciliation?.status ?? "not_available",
        confidence: confidenceByField.meter || null,
        providers: midi?.meterMap.length ? ["STANDARD_MIDI"] :
          meterReconciliation?.providers ?? [],
        message: midi?.meterMap.length ? null : meterReconciliation?.message ??
          "No structure provider returned a verified meter.",
        edited: false,
      },
      key: {
        status: midi?.keyMap.length ? "detected" : keyReconciliation?.status ?? "not_available",
        confidence: confidenceByField.key || null,
        providers: midi?.keyMap.length ? ["STANDARD_MIDI"] :
          keyReconciliation?.providers ?? [],
        message: midi?.keyMap.length ? null : keyReconciliation?.message ??
          "No unambiguous tonal center was detected.",
        edited: false,
      },
      melody: {
        status: melody.length ? "detected" : "not_available",
        confidence: confidenceByField.melody || null,
        providers: melody.length ? melodyProviders : [],
        message: melody.length ? null : "No transcription provider returned a melodic line.",
        edited: false,
      },
      bass: {
        status: bass.length ? "detected" : "not_available",
        confidence: bassConfidence || null,
        providers: bassProviders,
        message: bass.length ? null : "No bass provider returned observed bass evidence.",
        edited: false,
      },
      harmony: {
        status: providerResults.chords.length ? "detected" : "not_available",
        confidence: confidenceByField.harmony || null,
        providers: providerResults.chords.length ? harmonyProviders : [],
        message: providerResults.chords.length ? null : "No harmony provider returned chord events.",
        edited: false,
      },
      sections: {
        status: providerResults.structure ? "detected" : "not_available",
        confidence: confidenceByField.structure || null,
        providers: structureProvider ? [structureProvider] : [],
        message: providerResults.structure ? null :
          "No structure provider returned verified section boundaries.",
        edited: false,
      },
      energy: {
        status: midi ? "detected" : energyDetection ? "low_confidence" : "not_available",
        confidence: confidenceByField.energy || null,
        providers: midi ? ["STANDARD_MIDI"] :
          energyDetection ? ["LOCAL_SIGNAL_ANALYZER_V1"] : [],
        message: midi ? null : energyDetection
          ? "Energy is measured locally from the decoded signal."
          : "The decoded signal did not contain usable energy evidence.",
        edited: false,
      },
    };
    const verifiedConfidences = Object.values(confidenceByField)
      .filter((value) => value > 0);
    const candidateConfidence = midi ? 1 : Number((
      verifiedConfidences.reduce((sum, value) => sum + value, 0) /
      Math.max(1, verifiedConfidences.length)
    ).toFixed(4));
    const successfulAnalysisProviders = [
      ...new Set(providerResults.provenance
        .filter((item) => item.status === "ready")
        .map((item) => item.provider)),
    ];
    const analysisCoverage = Number(
      (analysisDurationSeconds / durationSeconds).toFixed(4),
    );
    const candidateTempoMap = midi?.tempoMap.length
      ? midi.tempoMap
      : providerResults.structure?.tempoMap.length
        ? providerResults.structure.tempoMap
        : tempoReconciliation?.value !== null && tempoReconciliation?.value !== undefined
          ? [{ time: 0, bpm: tempoReconciliation.value, confidence: tempoReconciliation.confidence ?? 0 }]
          : [];
    const candidateMeterMap = midi?.meterMap.length
      ? midi.meterMap
      : providerResults.structure?.meterMap.length
        ? providerResults.structure.meterMap
        : meterReconciliation?.value
          ? [{ bar: 1, meter: meterReconciliation.value, confidence: meterReconciliation.confidence ?? 0 }]
          : [];
    const lyrics: SongModelData["lyrics"] = [];
    const vocalIntelligence = derivePhraseLevelVocalIntelligence(
      vocalEvidence, melody, lyrics, sections, candidateTempoMap, candidateMeterMap, durationSeconds,
    );
    const candidate = {
      audio: {
        name: source.name,
        contentType: source.contentType,
        size: source.size,
        durationSeconds,
        sampleRate: sourceSampleRate,
        channels,
        proxyObjectPath: normalizedObjectPath,
        proxyContentType: normalizedObjectPath ? "audio/flac" : null,
        analysisStartSeconds,
        analysisDurationSeconds,
        analysisCoverage: analysisCoverage < 1
          ? "representative" as const
          : "full" as const,
      },
      analysisStartSeconds,
      analysisDurationSeconds,
      analysisCoverage,
      tempoMap: candidateTempoMap,
      meterMap: candidateMeterMap,
      keyMap: midi?.keyMap.length
        ? midi.keyMap
        : keyReconciliation?.value
          ? [{ time: 0, key: keyReconciliation.value, confidence: keyReconciliation.confidence ?? 0 }]
          : [],
      beats,
      bars,
      melody,
      bass,
      chords: midi ? [] : providerResults.chords,
      sections,
      energy,
      dynamics: energy,
      waveform,
      stems: sourceStems.map((stem) => ({
        name: stem.role,
        role: stem.role,
        source: stem.objectPath,
        channels: 1,
        confidence: stem.confidence,
      })),
      sourceStems,
      vocalEvidence,
      vocalIntelligence,
      lyrics,
      confidenceByField,
      providerProvenance: [
        {
          capability: "preprocessing",
          provider: midi ? "STANDARD_MIDI" : "FFMPEG",
          version: "system",
          status: "ready" as const,
        },
        {
          capability: "key_analysis",
          provider: midi ? "STANDARD_MIDI" : "LOCAL_SIGNAL_ANALYZER_V1",
          version: "1.0.0",
          status: midi ? "ready" as const : "fallback" as const,
        },
        ...(midi
          ? [{
              capability: "structure",
              provider: "STANDARD_MIDI",
              version: "1.0.0",
              status: "ready" as const,
            }]
          : !providerResults.structure
            ? [{
                capability: "structure",
                provider: "LOCAL_SIGNAL_ANALYZER_V1",
                version: "1.0.0",
                status: "fallback" as const,
              }]
            : []),
        ...providerResults.provenance,
      ],
      rhythmEvidence: providerResults.rhythmEvidence,
      timingEvidence: providerResults.timingEvidence,
      pitchEvidence: providerResults.pitchEvidence,
      keyEvidence: providerResults.keyEvidence,
      loudness: providerResults.loudness,
      fieldStatus,
      provenance: {
        tempo: fieldStatus.tempo.providers,
        meter: fieldStatus.meter.providers,
        key: fieldStatus.key.providers,
        melody: fieldStatus.melody.providers,
        bass: fieldStatus.bass.providers,
        harmony: fieldStatus.harmony.providers,
        sections: fieldStatus.sections.providers,
        energy: fieldStatus.energy.providers,
      },
    };
    const candidateProvider = midi
      ? "STANDARD_MIDI"
      : successfulAnalysisProviders.join("+") || "UNVERIFIED_ANALYSIS";
    const fusion = fuseProviderSongModels([{
      provider: candidateProvider,
      output: candidate,
      confidence: candidateConfidence,
    }]);
    if (!fusion.accepted) {
      throw new Error(
        `Analysis providers returned an invalid Song Model. ${
          fusion.issues.map((item) => item.message).join(" ")
        }`,
      );
    }
    const model: SongModelData = fusion.model;
    const persistedProviders = midi
      ? ["STANDARD_MIDI"]
      : [
          "FFMPEG",
          "LOCAL_SIGNAL_ANALYZER_V1",
          ...successfulAnalysisProviders,
        ];
    const fusedConfidence = model.fusion.confidence;
    await updateOwnedStage("persisting_song_model", 88);
    const songModelId = randomUUID();
    const now = new Date();
    const modelBytes = Buffer.from(JSON.stringify(model));
    const modelChecksum = createHash("sha256").update(modelBytes).digest("hex");
    const sourceArtifactId = randomUUID();
    const songModelArtifactId = randomUUID();
    const normalizedArtifactId = normalizedObjectPath ? randomUUID() : null;

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${source.projectId}))`,
      );
      const [claimedSource] = await tx.update(projectSourcesTable)
        .set({
          status: "ready",
          progress: 100,
          error: null,
          analysisLeaseId: null,
          analysisLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(projectSourcesTable.id, source.id),
          eq(projectSourcesTable.analysisLeaseId, attempt.id),
          gt(projectSourcesTable.analysisLeaseExpiresAt, now),
        ))
        .returning({ id: projectSourcesTable.id });
      if (!claimedSource) {
        throw new LeaseLostError("Analysis lease was transferred before commit");
      }
      const [previous] = await tx
        .select({ version: songModelsTable.version })
        .from(songModelsTable)
        .where(eq(songModelsTable.projectId, source.projectId))
        .orderBy(desc(songModelsTable.version))
        .limit(1);
      const version = (previous?.version ?? 0) + 1;
      await tx.insert(songModelsTable).values({
        id: songModelId,
        projectId: source.projectId,
        sourceId: source.id,
        analysisJobId: attempt.id,
        version,
        model,
        providers: persistedProviders,
        confidence: fusedConfidence,
      });
      await tx.update(musicProjectsTable)
        .set({
          sourceName: source.name,
          sourceType: source.sourceType,
          status: "ready",
          duration: formatDuration(durationSeconds),
          bpm,
          key,
          meter,
          confidence: fusedConfidence,
          sections,
          energy,
          providers: persistedProviders,
          updatedAt: now,
        })
        .where(eq(musicProjectsTable.id, source.projectId));
      await tx.insert(musicArtifactsTable).values([
        {
          id: sourceArtifactId,
          projectId: source.projectId,
          type: "SOURCE",
          label: source.name,
          version,
          size: `${(source.size / 1024 / 1024).toFixed(1)} MB`,
          format: suffix.slice(1).toUpperCase(),
          hash: sourceChecksum,
          checksum: sourceChecksum,
          storageUri: source.objectPath,
          createdBy: "source-ingestion",
          modelVersion: "SOURCE_INGESTION@1.0.0",
          license: "User-provided source",
          retentionPolicy: "project",
          technicalMetadata: {
            mediaType: source.contentType,
            bytes: source.size,
            durationSeconds,
            sampleRate: sourceSampleRate,
            channels,
          },
        },
        {
          id: songModelArtifactId,
          projectId: source.projectId,
          type: "SONG_MODEL",
          label: "Canonical Song Model",
          version,
          size: `${Math.max(1, Math.round(modelBytes.length / 1024))} KB`,
          format: "JSON",
          hash: modelChecksum,
          checksum: modelChecksum,
          parentIds: [sourceArtifactId],
          storageUri: `db://music_song_models/${songModelId}`,
          createdBy: "analysis-fusion",
          modelVersion: "SONG_MODEL@1.0",
          provider: persistedProviders.join(","),
          license: "Derived project data",
          retentionPolicy: "project",
          technicalMetadata: {
            mediaType: "application/json",
            bytes: modelBytes.length,
            confidence: fusedConfidence,
          },
        },
        ...(normalizedObjectPath ? [{
          id: normalizedArtifactId!,
          projectId: source.projectId,
          type: "NORMALIZED_AUDIO",
          label: "Normalized analysis audio",
          version,
          size: "FLAC",
          format: "FLAC",
          url: normalizedObjectPath,
          parentIds: [sourceArtifactId],
          hash: normalizedChecksum,
          checksum: normalizedChecksum,
          storageUri: normalizedObjectPath,
          createdBy: "source-normalizer",
          modelVersion: "FFMPEG_FLAC@1",
          license: "Derived from user-provided source",
          retentionPolicy: "project",
          technicalMetadata: {
            mediaType: "audio/flac",
            durationSeconds,
            sampleRate: sourceSampleRate,
            channels,
          },
        }] : []),
        ...sourceStems
          .filter((stem) =>
            stem.provider === "BS_ROFORMER" || stem.provider === "DEMUCS")
          .map((stem) => ({
            id: randomUUID(),
            projectId: source.projectId,
            type: "STEM",
            label: stem.role.replace(/_/g, " "),
            version,
            size: "Private audio",
            format: "AUDIO",
            url: stem.objectPath,
            parentIds: [normalizedArtifactId ?? sourceArtifactId],
            storageUri: stem.objectPath,
            createdBy: "analysis-provider",
            provider: stem.provider,
            modelVersion: `${stem.provider}@configured`,
            license: "Provider terms",
            retentionPolicy: "project",
            technicalMetadata: {
              mediaType: "audio",
              durationSeconds,
              confidence: stem.confidence,
            },
          })),
      ]);
      await tx.update(analysisAttemptsTable)
        .set({
          status: "succeeded",
          stage: "complete",
          progress: 100,
          error: null,
          completedAt: now,
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(analysisAttemptsTable.id, attempt.id));
      await tx.update(analysisJobsTable)
        .set({
          status: "completed",
          stage: "complete",
          progress: 100,
          error: null,
          leaseExpiresAt: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(analysisJobsTable.id, attempt.id));
      await tx.insert(studioActivitiesTable).values({
        id: randomUUID(),
        projectId: source.projectId,
        title: "Song Model ready",
        detail: `${source.name} · ${bpm} BPM · ${key}`,
        type: "analysis",
      });
    });
    hasUncommittedAnalysisObjects = false;
    logger.info({
      sourceId: source.id,
      attemptId: attempt.id,
      stage: "complete",
      progress: 100,
    }, "music_analysis_attempt_succeeded");
  } catch (error) {
    if (hasUncommittedAnalysisObjects) {
      await deleteAnalysisObjects(source.projectId, attempt.id).catch(() => undefined);
      hasUncommittedAnalysisObjects = false;
    }
    const message = formatHostErrorMessage(error, "Source analysis failed");
    const failedAt = new Date();
    if (error instanceof LeaseLostError || error instanceof AnalysisLeaseLostError) {
      await interruptAttempt(attempt.id, message);
      logger.warn({
        sourceId: source.id,
        attemptId: attempt.id,
        stage: currentStage,
        progress: currentProgress,
      }, "music_analysis_attempt_interrupted");
    } else {
      const failedWithLease = await db.transaction(async (tx) => {
        const [claimedSource] = await tx.update(projectSourcesTable)
          .set({
            status: "failed",
            error: message,
            progress: currentProgress,
            analysisLeaseId: null,
            analysisLeaseExpiresAt: null,
            updatedAt: failedAt,
          })
          .where(and(
            eq(projectSourcesTable.id, source.id),
            eq(projectSourcesTable.analysisLeaseId, attempt.id),
            gt(projectSourcesTable.analysisLeaseExpiresAt, failedAt),
          ))
          .returning({ id: projectSourcesTable.id });
        if (!claimedSource) return false;
        await tx.update(analysisAttemptsTable)
          .set({
            status: "failed",
            stage: currentStage,
            progress: currentProgress,
            error: message,
            completedAt: failedAt,
            heartbeatAt: failedAt,
            updatedAt: failedAt,
          })
          .where(eq(analysisAttemptsTable.id, attempt.id));
        await tx.update(analysisJobsTable)
          .set({
            status: "failed",
            stage: currentStage,
            progress: currentProgress,
            error: message,
            leaseExpiresAt: null,
            finishedAt: failedAt,
            updatedAt: failedAt,
          })
          .where(eq(analysisJobsTable.id, attempt.id));
        const [latestModel] = await tx
          .select({ id: songModelsTable.id })
          .from(songModelsTable)
          .where(eq(songModelsTable.projectId, source.projectId))
          .orderBy(desc(songModelsTable.version))
          .limit(1);
        await tx.update(musicProjectsTable)
          .set({ status: latestModel ? "ready" : "draft", updatedAt: failedAt })
          .where(eq(musicProjectsTable.id, source.projectId));
        return true;
      });
      if (!failedWithLease) {
        await interruptAttempt(
          attempt.id,
          "Analysis lease expired before the error could be recorded.",
        );
        logger.warn({
          errorMessage: message,
          sourceId: source.id,
          attemptId: attempt.id,
          stage: currentStage,
          progress: currentProgress,
        }, "music_analysis_failure_after_lease_lost");
      } else {
        logger.error({
          errorMessage: message,
          sourceId: source.id,
          attemptId: attempt.id,
          stage: currentStage,
          progress: currentProgress,
        }, "music_analysis_attempt_failed");
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (directory) await rm(directory, { recursive: true, force: true });
    activeSourceJobs.delete(sourceId);
  }
}

export async function queueProjectSourceAnalysis(sourceId: string): Promise<boolean> {
  try {
    const claim = await claimAnalysisAttempt(sourceId);
    if (!claim) return false;
    logger.info({
      sourceId,
      attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.attemptNumber,
      resumed: claim.resumed,
    }, "music_analysis_attempt_queued");
    void analyzeProjectSource(sourceId, claim.attempt.id).catch((error) => {
      logger.error({
        errorMessage: formatHostErrorMessage(error, "Music analysis worker crashed"),
        sourceId,
      }, "music_analysis_worker_crashed");
    });
    return true;
  } catch (error) {
    logger.error({
      errorMessage: formatHostErrorMessage(error, "Analysis attempt queue failed"),
      sourceId,
    }, "music_analysis_attempt_queue_failed");
    throw error;
  }
}

export async function recoverInterruptedAnalyses(): Promise<void> {
  const resumableSources = await db
    .select()
    .from(projectSourcesTable)
    .where(inArray(projectSourcesTable.status, ["queued", "preprocessing", "analyzing"]));
  const resumedSourceIds: string[] = [];
  for (const source of resumableSources) {
    if (await queueProjectSourceAnalysis(source.id)) {
      resumedSourceIds.push(source.id);
    }
  }
  if (resumedSourceIds.length > 0) {
    logger.info({
      sourceCount: resumedSourceIds.length,
      sourceIds: resumedSourceIds,
    }, "music_analysis_sources_resumed");
  }
}

export async function resumePendingSourceJobs(): Promise<void> {
  const jobs = await db
    .select({ sourceId: analysisJobsTable.sourceId })
    .from(analysisJobsTable)
    .where(or(
      eq(analysisJobsTable.status, "queued"),
      and(
        eq(analysisJobsTable.status, "running"),
        or(
          isNull(analysisJobsTable.leaseExpiresAt),
          lte(analysisJobsTable.leaseExpiresAt, new Date()),
        ),
      ),
    ));
  for (const job of jobs) {
    setImmediate(() => {
      void analyzeProjectSource(job.sourceId);
    });
  }
}

function readMidiVarInt(bytes: Buffer, offset: number): [number, number] {
  let value = 0;
  let count = 0;
  while (offset < bytes.length && count++ < 4) {
    const byte = bytes[offset++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return [value, offset];
  }
  throw new Error("Invalid MIDI variable-length value");
}

function parseMidi(path: string): Promise<MidiModelData> {
  return readFile(path).then((bytes) => {
    if (bytes.toString("ascii", 0, 4) !== "MThd" || bytes.length < 14) throw new Error("Invalid Standard MIDI file");
    const headerLength = bytes.readUInt32BE(4);
    const division = bytes.readUInt16BE(12);
    if (!division || division & 0x8000) throw new Error("SMPTE-timed MIDI files are not supported");
    let offset = 8 + headerLength;
    const events: MidiEvent[] = [];
    const active = new Map<
      string,
      Array<{ tick: number; pitch: number; velocity: number; channel: number; track: number }>
    >();
    let finalTick = 0;
    let trackIndex = 0;
    while (offset + 8 <= bytes.length && bytes.toString("ascii", offset, offset + 4) === "MTrk") {
      const currentTrack = trackIndex++;
      const end = Math.min(bytes.length, offset + 8 + bytes.readUInt32BE(offset + 4));
      offset += 8;
      let tick = 0; let running = 0;
      while (offset < end) {
        const parsed = readMidiVarInt(bytes, offset); tick += parsed[0]; offset = parsed[1]; finalTick = Math.max(finalTick, tick);
        let status = bytes[offset++];
        if (status < 0x80) { if (!running) throw new Error("Invalid MIDI running status"); offset--; status = running; } else if (status < 0xf0) running = status;
        if (status === 0xff) {
          const meta = bytes[offset++]; const size = readMidiVarInt(bytes, offset); offset = size[1];
          const data = [...bytes.subarray(offset, offset + size[0])]; offset += size[0];
          if (meta === 0x51 && data.length === 3) events.push({ tick, type: "tempo", data });
          if (meta === 0x58 && data.length >= 2) events.push({ tick, type: "meter", data });
          if (meta === 0x59 && data.length >= 2) events.push({ tick, type: "key", data });
        } else if (status === 0xf0 || status === 0xf7) { const size = readMidiVarInt(bytes, offset); offset = size[1] + size[0]; }
        else {
          const command = status >> 4; const channel = status & 15; const dataLength = command === 0xc || command === 0xd ? 1 : 2;
          const data = [...bytes.subarray(offset, offset + dataLength)]; offset += dataLength;
          // A note-on with velocity zero is the MIDI-standard shorthand for
          // note-off and is emitted by many DAWs.
          if (command === 0x9 || command === 0x8) {
            const identity = `${currentTrack}:${channel}:${data[0]}`;
            if (command === 0x9 && data[1] > 0) {
              const notes = active.get(identity) ?? [];
              notes.push({
                tick,
                pitch: data[0],
                velocity: data[1],
                channel,
                track: currentTrack,
              });
              active.set(identity, notes);
            } else {
              const notes = active.get(identity);
              const note = notes?.shift();
              if (note) {
                events.push({
                  tick,
                  type: "note",
                  data: [note.tick, note.pitch, note.velocity],
                  channel,
                  track: note.track,
                });
                if (notes && notes.length === 0) active.delete(identity);
              }
            }
          }
        }
      }
      offset = end;
    }
    const ordered = events.sort((a, b) => a.tick - b.tick);
    const tempos = ordered.filter((event) => event.type === "tempo");
    const tickToSeconds = (tick: number) => {
      let seconds = 0; let previousTick = 0; let microseconds = 500000;
      for (const event of tempos) { if (event.tick >= tick) break; seconds += (event.tick - previousTick) * microseconds / division / 1e6; previousTick = event.tick; microseconds = (event.data[0] << 16) | (event.data[1] << 8) | event.data[2]; }
      return seconds + (tick - previousTick) * microseconds / division / 1e6;
    };
    const tempoMap = [{ time: 0, bpm: 120, confidence: 1 }, ...tempos.map((event) => ({ time: tickToSeconds(event.tick), bpm: Number((60e6 / ((event.data[0] << 16) | (event.data[1] << 8) | event.data[2])).toFixed(3)), confidence: 1 }))].filter((event, index, values) => index === values.length - 1 || event.time !== values[index + 1].time);
    const meters = ordered.filter((event) => event.type === "meter");
    const meterFor = (event?: MidiEvent) => event ? `${event.data[0]}/${2 ** event.data[1]}` : "4/4";
    const meterEvidence = buildMeterAwareEvidence(
      division,
      finalTick,
      meters.map((event) => ({ tick: event.tick, meter: meterFor(event) })),
      tickToSeconds,
    );
    const meter = meterEvidence.meterMap[0]?.meter ?? "4/4";
    const keys = ordered.filter((event) => event.type === "key");
    const keyFor = (event?: MidiEvent) => { const sf = event ? (event.data[0] > 127 ? event.data[0] - 256 : event.data[0]) : 0; return `${midiKeyNames[(sf + 12) % 12]} ${event?.data[1] ? "minor" : "major"}`; };
    const key = keyFor(keys[0]);
    const durationSeconds = Math.max(0.01, tickToSeconds(finalTick));
    const bpm = tempoMap[0].bpm;
    const melody = ordered.filter((event) => event.type === "note").map((event) => ({
      start: tickToSeconds(event.data[0]),
      end: Math.max(tickToSeconds(event.tick), tickToSeconds(event.data[0]) + 0.04),
      pitch: event.data[1],
      velocity: event.data[2],
      confidence: 1,
      source: `MIDI_TRACK_${(event.track ?? 0) + 1}_CHANNEL_${event.channel! + 1}`,
    }));
    const channels = [...new Set(melody.map((note) => note.source))];
    return { durationSeconds, sampleRate: 44_100, channels: channels.length || 1, bpm, meter, key, tempoMap, meterMap: meterEvidence.meterMap.map((event) => ({ ...event, confidence: 1 })), keyMap: [{ time: 0, key, confidence: 1 }, ...keys.map((event) => ({ time: tickToSeconds(event.tick), key: keyFor(event), confidence: 1 }))], beats: meterEvidence.beats, bars: meterEvidence.bars, melody, sourceStems: channels.map((role) => ({ role, objectPath: "", provider: "STANDARD_MIDI", confidence: 1 })) };
  });
}

const midiKeyNames = ["C", "G", "D", "A", "E", "B", "F♯", "C♯", "A♭", "E♭", "B♭", "F"];

async function fullDurationEnergy(
  path: string,
  durationSeconds: number,
): Promise<{ values: number[]; isEffectivelySilent: boolean }> {
  const bins = Math.max(24, Math.min(1_280, Math.ceil(durationSeconds / 2)));
  const sums = new Array<number>(bins).fill(0); const counts = new Array<number>(bins).fill(0);
  let sumOfSquares = 0;
  let peak = 0;
  let finiteSamples = 0;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", "200", "-f", "f32le", "pipe:1"]);
    let carry = Buffer.alloc(0); let sample = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      const data = Buffer.concat([carry, chunk]);
      const complete = data.length - data.length % 4;
      for (let i = 0; i < complete; i += 4, sample++) {
        const bin = Math.min(
          bins - 1,
          Math.floor(sample / Math.max(1, durationSeconds * 200) * bins),
        );
        const value = data.readFloatLE(i);
        if (Number.isFinite(value)) {
          const squared = value * value;
          sums[bin] += squared;
          counts[bin]++;
          sumOfSquares += squared;
          peak = Math.max(peak, Math.abs(value));
          finiteSamples++;
        }
      }
      carry = data.subarray(complete);
    });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Unable to decode audio overview")));
  });
  const raw = sums.map((sum, index) => Math.sqrt(sum / Math.max(1, counts[index])));
  const max = Math.max(...raw, 0.0001);
  const rms = finiteSamples ? Math.sqrt(sumOfSquares / finiteSamples) : 0;
  return {
    values: raw.map((value) => Number(Math.min(1, value / max).toFixed(3))),
    isEffectivelySilent: finiteSamples === 0 || (rms < 0.000_032 && peak < 0.000_5),
  };
}

type MidiModelData = {
  durationSeconds: number; sampleRate: number; channels: number; bpm: number; meter: string; key: string;
  tempoMap: Array<{ time: number; bpm: number; confidence: number }>;
  meterMap: Array<{ bar: number; meter: string; confidence: number }>;
  keyMap: Array<{ time: number; key: string; confidence: number }>;
  beats: Array<{ time: number; beat: number; bar: number; confidence: number }>;
  bars: Array<{ bar: number; start: number; end: number; beats: number; confidence: number }>;
  melody: Array<{ start: number; end: number; pitch: number; velocity: number; confidence: number; source: string }>;
  sourceStems: Array<{ role: string; objectPath: string; provider: string; confidence: number }>;
};

function detectKeyEvidence(
  samples: Float32Array,
  sampleRate: number,
): { key: string; confidence: number } | null {
  const noteNames = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const maxSamples = Math.min(samples.length, sampleRate * 60);
  if (!maxSamples) return null;
  let mean = 0;
  for (let i = 0; i < maxSamples; i += 1) mean += samples[i];
  mean /= maxSamples;
  const pitchEnergy = Array.from({ length: 12 }, () => 0);
  for (let midi = 48; midi <= 71; midi += 1) {
    const omega = (2 * Math.PI * (440 * 2 ** ((midi - 69) / 12))) / sampleRate;
    let real = 0;
    let imaginary = 0;
    for (let i = 0; i < maxSamples; i += 8) {
      const centered = samples[i] - mean;
      real += centered * Math.cos(omega * i);
      imaginary -= centered * Math.sin(omega * i);
    }
    pitchEnergy[midi % 12] += Math.hypot(real, imaginary);
  }
  const ranked = [...pitchEnergy].sort((a, b) => b - a);
  const peak = ranked[0] ?? 0;
  const runnerUp = ranked[1] ?? 0;
  const total = pitchEnergy.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || peak <= 0) return null;
  const peakShare = peak / total;
  const separation = (peak - runnerUp) / peak;
  if (peakShare < 0.1 || separation < 0.04) return null;
  const root = pitchEnergy.indexOf(peak);
  const minor = pitchEnergy[(root + 3) % 12] + pitchEnergy[(root + 8) % 12] >
    pitchEnergy[(root + 4) % 12] + pitchEnergy[(root + 7) % 12];
  return {
    key: `${noteNames[root]} ${minor ? "minor" : "major"}`,
    confidence: Number(Math.min(0.82, 0.35 + peakShare * 1.8 + separation).toFixed(2)),
  };
}

function detectTempoEvidence(
  samples: Float32Array,
  sampleRate: number,
): { bpm: number; confidence: number } | null {
  const hop = 512;
  const frame = 1024;
  const envelope: number[] = [];
  let previous = 0;
  for (let start = 0; start + frame < samples.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + frame; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / frame);
    envelope.push(Math.max(0, rms - previous));
    previous = rms;
  }
  if (envelope.length < 16) return null;
  const scores: Array<{ bpm: number; score: number }> = [];
  for (let bpm = 60; bpm <= 180; bpm += 1) {
    const lag = Math.round((60 * sampleRate) / (bpm * hop));
    let score = 0;
    for (let i = lag; i < envelope.length; i += 1) score += envelope[i] * envelope[i - lag];
    scores.push({ bpm, score });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const runnerUp = scores.find((item) => Math.abs(item.bpm - best.bpm) > 4);
  const total = envelope.reduce((sum, value) => sum + value, 0);
  if (!best || best.score <= 0 || total <= 0) return null;
  const separation = runnerUp ? (best.score - runnerUp.score) / best.score : 1;
  const onsetDensity = envelope.filter((value) => value > total / envelope.length).length /
    envelope.length;
  if (separation < 0.025 || onsetDensity < 0.01) return null;
  return {
    bpm: best.bpm,
    confidence: Number(Math.min(0.78, 0.35 + separation * 1.8 + onsetDensity).toFixed(2)),
  };
}
