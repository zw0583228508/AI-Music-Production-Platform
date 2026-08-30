import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  analysisJobsTable,
  db,
  musicArtifactsTable,
  musicProjectsTable,
  projectSourcesTable,
  songModelsTable,
  studioActivitiesTable,
  type AnalysisSection,
  type SongModelData,
} from "@workspace/db";
import {
  fuseCanonicalNotes,
  runAnalysisProviders,
  type SeparationAnalysisResult,
} from "./analysisProviders";
import { fuseProviderSongModels } from "./songModelValidation";
import {
  createSourceDownloadUrl,
  deleteAnalysisObjects,
  getSourceObject,
  saveAnalysisObject,
  saveSourceProxyObject,
} from "./objectStorage";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const activeSourceJobs = new Set<string>();
const WORKER_ID = randomUUID();
const LEASE_MS = 2 * 60_000;
const leaseDeadline = (): Date => new Date(Date.now() + LEASE_MS);

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

/**
 * Treat decoded PCM as silent only when both its overall level and its peak
 * are far below normal recording levels. Requiring both measurements keeps a
 * quiet recording (or one with a short audible transient) from being rejected,
 * while catching empty decodes and codec-level digital silence deterministically.
 */
export function isEffectivelySilent(samples: Float32Array): boolean {
  if (samples.length === 0) return true;

  let sumOfSquares = 0;
  let peak = 0;
  let finiteSamples = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) continue;
    const magnitude = Math.abs(sample);
    peak = Math.max(peak, magnitude);
    sumOfSquares += sample * sample;
    finiteSamples += 1;
  }

  if (finiteSamples === 0) return true;
  const rms = Math.sqrt(sumOfSquares / finiteSamples);
  // -90 dBFS RMS and -66 dBFS peak: well below a normally quiet recording.
  return rms < 0.000_032 && peak < 0.000_5;
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

function estimateKey(samples: Float32Array, sampleRate: number, fingerprint: string): string {
  const noteNames = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const maxSamples = Math.min(samples.length, sampleRate * 60);
  const pitchEnergy = Array.from({ length: 12 }, () => 0);
  for (let midi = 48; midi <= 71; midi += 1) {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const omega = (2 * Math.PI * frequency) / sampleRate;
    let real = 0;
    let imaginary = 0;
    for (let i = 0; i < maxSamples; i += 8) {
      real += samples[i] * Math.cos(omega * i);
      imaginary -= samples[i] * Math.sin(omega * i);
    }
    pitchEnergy[midi % 12] += Math.hypot(real, imaginary);
  }
  const root = pitchEnergy.some(Boolean)
    ? pitchEnergy.indexOf(Math.max(...pitchEnergy))
    : Number.parseInt(fingerprint.slice(0, 2), 16) % 12;
  const minor = Number.parseInt(fingerprint.slice(2, 4), 16) % 2 === 0;
  return `${noteNames[root]} ${minor ? "minor" : "major"}`;
}

function makeSections(
  durationSeconds: number,
  bpm: number,
  energy: number[],
): AnalysisSection[] {
  const bars = Math.max(8, Math.round((durationSeconds * bpm) / 240));
  const count = Math.max(1, Math.ceil(bars / 16));
  return Array.from({ length: count }, (_, index) => {
    const startBar = Math.floor((index / count) * bars) + 1;
    const endBar = index === count - 1
      ? bars
      : Math.max(startBar, Math.floor(((index + 1) / count) * bars));
    const energyIndex = Math.min(
      energy.length - 1,
      Math.floor(((index + 0.5) / count) * energy.length),
    );
    return { name: `Section ${index + 1}`, startBar, endBar, energy: energy[energyIndex] ?? 0.5 };
  });
}

async function providerStemData(
  stem: SeparationAnalysisResult["stems"][number],
): Promise<Buffer> {
  const maxBytes = 512 * 1024 * 1024;
  if (stem.contentBase64) {
    const normalized = stem.contentBase64.replace(/^data:[^;]+;base64,/, "");
    if (!normalized || !/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) {
      throw new Error(`BS_ROFORMER returned invalid base64 for ${stem.role}`);
    }
    if (normalized.length * 0.75 > maxBytes) {
      throw new Error(`BS_ROFORMER ${stem.role} stem is too large`);
    }
    const data = Buffer.from(normalized, "base64");
    if (!data.length) throw new Error(`BS_ROFORMER returned an empty ${stem.role} stem`);
    return data;
  }
  if (!stem.downloadUrl) {
    throw new Error(`BS_ROFORMER did not provide audio for ${stem.role}`);
  }
  const response = await fetch(stem.downloadUrl, {
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    throw new Error(`BS_ROFORMER ${stem.role} download returned HTTP ${response.status}`);
  }
  const providerEndpoint = process.env.BS_ROFORMER_API_URL ??
    process.env.BS_ROFORMER_SW_API_URL;
  if (
    !providerEndpoint ||
    new URL(response.url).origin !== new URL(providerEndpoint).origin
  ) {
    throw new Error(`BS_ROFORMER ${stem.role} download left the provider origin`);
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) {
    throw new Error(`BS_ROFORMER ${stem.role} stem is too large`);
  }
  if (!response.body) {
    throw new Error(`BS_ROFORMER returned an empty ${stem.role} response`);
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
      throw new Error(`BS_ROFORMER ${stem.role} stem is too large`);
    }
    chunks.push(Buffer.from(value));
  }
  const data = Buffer.concat(chunks, total);
  if (!data.length) throw new Error(`BS_ROFORMER returned an empty ${stem.role} stem`);
  return data;
}

async function validateStemAudio(
  data: Buffer,
  path: string,
  role: string,
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
    throw new Error(`BS_ROFORMER ${role} stem failed audio validation`);
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
    const data = await providerStemData(stem);
    await validateStemAudio(
      data,
      join(directory, `verified-${stem.role}.${stem.extension}`),
      stem.role,
      sourceDurationSeconds,
    );
    const objectPath = await saveAnalysisObject(
      projectId,
      analysisJobId,
      `${stem.role}.${stem.extension}`,
      data,
      stem.contentType,
    );
    return {
      role: stem.role,
      objectPath,
      provider: result.providerId,
      confidence: stem.confidence,
    };
  }));
}

type MidiEvent = { tick: number; type: "tempo" | "meter" | "key" | "note"; data: number[]; channel?: number };
async function analyzeProjectSourceBeforeTask1(sourceId: string): Promise<void> {
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
    });
    const primaryTranscription = providerResults.transcriptions[0] ?? null;
    if (providerResults.structure) {
      bpm = providerResults.structure.bpm;
      meter = providerResults.structure.meter;
      beats = providerResults.structure.beats;
      bars = providerResults.structure.bars;
      sections = providerResults.structure.sections;
      secondsPerBeat = 60 / bpm;
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

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${source.projectId}))`,
      );
      const [previous] = await tx
        .select({ version: songModelsTable.version })
        .from(songModelsTable)
        .where(eq(songModelsTable.projectId, source.projectId))
        .orderBy(desc(songModelsTable.version))
        .limit(1);
      const version = (previous?.version ?? 0) + 1;
      const [completed] = await tx.update(analysisJobsTable)
        .set({
          status: "completed",
          stage: "completed",
          progress: 100,
          error: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
        })
        .where(ownedLease())
        .returning({ id: analysisJobsTable.id });
      if (!completed) throw new LeaseLostError("Analysis lease was transferred before commit");
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
      await tx.update(projectSourcesTable)
        .set({ status: "ready", progress: 100 })
        .where(eq(projectSourcesTable.id, source.id));
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
          updatedAt: new Date(),
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
    const message = error instanceof Error ? error.message : "Source analysis failed";
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
export async function analyzeProjectSource(sourceId: string): Promise<void> {
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
    if (!midi) {
      const { stdout: pcmBuffer } = await execFileAsync("ffmpeg", [
        "-v", "error", "-ss", String(analysisStartSeconds), "-i", inputPath,
        "-t", String(analysisDurationSeconds), "-ac", "1", "-ar", String(decodeRate),
        "-f", "f32le", "pipe:1",
      ], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
      samples = new Float32Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.byteLength / 4));
      await updateOwnedStage("validating_audio", 56);
      if (isEffectivelySilent(samples)) throw new Error("No audible audio was detected in this upload. Please upload a recording with audible sound.");
      waveform = await fullDurationEnergy(inputPath, durationSeconds);
      const normalizedPath = join(directory, "normalized.flac");
      await execFileAsync("ffmpeg", ["-v", "error", "-i", inputPath, "-map", "0:a:0", "-c:a", "flac", normalizedPath]);
      normalizedObjectPath = await saveSourceProxyObject(source.id, normalizedPath, "audio/flac");
    }
    const fingerprint = await fingerprintFile(inputPath);
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
    let bpm = midi?.bpm ?? estimateBpm(samples, decodeRate);
    const key = midi?.key ?? estimateKey(samples, decodeRate, fingerprint);
    let meter = midi?.meter ?? "4/4";
    let sections = makeSections(durationSeconds, bpm, energy);
    let secondsPerBeat = 60 / bpm;
    const beatCount = Math.max(1, Math.floor(durationSeconds / secondsPerBeat));
    let beats = midi?.beats ?? Array.from({ length: beatCount }, (_, index) => ({
      time: Number((index * secondsPerBeat).toFixed(4)),
      beat: (index % 4) + 1,
      bar: Math.floor(index / 4) + 1,
      confidence: 0.68,
    }));
    let bars = midi?.bars ?? Array.from(
      { length: Math.max(1, Math.ceil(beatCount / 4)) },
      (_, index) => ({
        bar: index + 1,
        start: Number((index * secondsPerBeat * 4).toFixed(4)),
        end: Number(Math.min(durationSeconds, (index + 1) * secondsPerBeat * 4).toFixed(4)),
        beats: 4,
        confidence: 0.68,
      }),
    );
    const confidence = midi ? 1 : Number(
      Math.min(0.94, 0.62 + Math.log10(Math.max(10, samples.length)) / 30).toFixed(2),
    );
    await updateOwnedStage("provider_analysis", 68);
    const needsProviderSource = !midi && [
      "BS_ROFORMER",
      "BS_ROFORMER_SW",
      "ALL_IN_ONE",
      "BASIC_PITCH",
      "MT3",
      "SHEETSAGE",
      "CHROMA",
      "BASS",
    ].some((provider) => Boolean(process.env[`${provider}_API_URL`]));
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
        const message = error instanceof Error
          ? error.message
          : "Stem persistence failed";
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
    if (!midi && providerResults.structure) {
      bpm = providerResults.structure.bpm;
      meter = providerResults.structure.meter;
      beats = providerResults.structure.beats;
      bars = providerResults.structure.bars;
      sections = providerResults.structure.sections;
      secondsPerBeat = 60 / bpm;
    }
    const melody = midi?.melody ??
      fuseCanonicalNotes(providerResults.transcriptions);
    const confidenceByField = {
      tempo: midi ? 1 : providerResults.structure?.confidence ?? confidence,
      meter: midi ? 1 : providerResults.structure?.confidence ?? 0.74,
      key: midi ? 1 : Math.max(0.5, confidence - 0.12),
      structure: midi ? 1 : providerResults.structure?.confidence ?? 0.58,
      melody: midi
        ? 1
        : providerResults.transcriptions.length
          ? Math.max(...providerResults.transcriptions.map((item) => item.confidence))
          : 0,
      harmony: midi ? 0 : providerResults.harmonyConfidence,
      separation: midi ? 1 : providerResults.separation?.confidence ?? 0,
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
        analysisCoverage: analysisCoverage < 1 ? "representative" : "full",
      },
      analysisStartSeconds,
      analysisDurationSeconds,
      analysisCoverage,
      tempoMap: midi?.tempoMap ??
        providerResults.structure?.tempoMap ??
        [{ time: 0, bpm, confidence }],
      meterMap: midi?.meterMap.length
        ? midi.meterMap
        : providerResults.structure?.meterMap ?? [{
            bar: 1,
            meter,
            confidence: providerResults.structure?.confidence ?? 0.74,
          }],
      keyMap: midi?.keyMap ?? [{ time: 0, key, confidence: Math.max(0.5, confidence - 0.12) }],
      beats,
      bars,
      melody,
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
      lyrics: [],
      confidenceByField,
      provenance: [
        {
          capability: "preprocessing",
          provider: midi ? "STANDARD_MIDI" : "FFMPEG",
          version: "system",
          status: "ready",
        },
        {
          capability: "key_analysis",
          provider: midi ? "STANDARD_MIDI" : "LOCAL_SIGNAL_ANALYZER_V1",
          version: "1.0.0",
          status: midi ? "ready" : "fallback",
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
    };
    const fusion = fuseProviderSongModels([{
      provider: midi
        ? "STANDARD_MIDI"
        : successfulAnalysisProviders.join("+") || "LOCAL_SIGNAL_ANALYZER_V1",
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
    bpm = model.tempoMap[0].bpm;
    meter = model.meterMap[0].meter;
    sections = model.sections;
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

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${source.projectId}))`,
      );
      const [previous] = await tx
        .select({ version: songModelsTable.version })
        .from(songModelsTable)
        .where(eq(songModelsTable.projectId, source.projectId))
        .orderBy(desc(songModelsTable.version))
        .limit(1);
      const version = (previous?.version ?? 0) + 1;
      const [completed] = await tx.update(analysisJobsTable)
        .set({
          status: "completed",
          stage: "completed",
          progress: 100,
          error: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
        })
        .where(ownedLease())
        .returning({ id: analysisJobsTable.id });
      if (!completed) throw new LeaseLostError("Analysis lease was transferred before commit");
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
      await tx.update(projectSourcesTable)
        .set({ status: "ready", progress: 100 })
        .where(eq(projectSourcesTable.id, source.id));
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
          updatedAt: new Date(),
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
        ...(normalizedObjectPath ? [{
          id: randomUUID(),
          projectId: source.projectId,
          type: "NORMALIZED_AUDIO",
          label: "Normalized analysis audio",
          version,
          size: "FLAC",
          format: "FLAC",
          url: normalizedObjectPath,
        }] : []),
        ...sourceStems
          .filter((stem) => stem.provider === "BS_ROFORMER")
          .map((stem) => ({
            id: randomUUID(),
            projectId: source.projectId,
            type: "STEM",
            label: stem.role.replace(/_/g, " "),
            version,
            size: "Private audio",
            format: "AUDIO",
            url: stem.objectPath,
          })),
      ]);
      await tx.insert(studioActivitiesTable).values({
        id: randomUUID(),
        projectId: source.projectId,
        title: "Song Model ready",
        detail: `${source.name} · ${bpm} BPM · ${key}`,
        type: "analysis",
      });
    });
    hasUncommittedAnalysisObjects = false;
  } catch (error) {
    if (hasUncommittedAnalysisObjects) {
      await deleteAnalysisObjects(source.projectId, job.id).catch(() => undefined);
      hasUncommittedAnalysisObjects = false;
    }
    if (error instanceof LeaseLostError) return;
    const message = error instanceof Error ? error.message : "Source analysis failed";
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
    const active = new Map<string, { tick: number; pitch: number; velocity: number; channel: number }>();
    let finalTick = 0;
    while (offset + 8 <= bytes.length && bytes.toString("ascii", offset, offset + 4) === "MTrk") {
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
          if ((command === 0x9 && data[1] > 0) || command === 0x8) {
            const identity = `${channel}:${data[0]}`;
            if (command === 0x9 && data[1] > 0) active.set(identity, { tick, pitch: data[0], velocity: data[1], channel });
            else { const note = active.get(identity); if (note) { events.push({ tick, type: "note", data: [note.tick, note.pitch, note.velocity], channel }); active.delete(identity); } }
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
    const meter = meterFor(meters[0]);
    const keys = ordered.filter((event) => event.type === "key");
    const keyFor = (event?: MidiEvent) => { const sf = event ? (event.data[0] > 127 ? event.data[0] - 256 : event.data[0]) : 0; return `${midiKeyNames[(sf + 12) % 12]} ${event?.data[1] ? "minor" : "major"}`; };
    const key = keyFor(keys[0]);
    const durationSeconds = Math.max(0.01, tickToSeconds(finalTick));
    const bpm = tempoMap[0].bpm;
    const beatsPerBar = Number.parseInt(meter, 10);
    const secondsPerBeat = 60 / bpm;
    const beatCount = Math.max(1, Math.ceil(durationSeconds / secondsPerBeat));
    const beats = Array.from({ length: beatCount }, (_, index) => ({ time: Number((index * secondsPerBeat).toFixed(4)), beat: index % beatsPerBar + 1, bar: Math.floor(index / beatsPerBar) + 1, confidence: 1 }));
    const bars = Array.from({ length: Math.ceil(beatCount / beatsPerBar) }, (_, index) => ({ bar: index + 1, start: Number((index * beatsPerBar * secondsPerBeat).toFixed(4)), end: Number(Math.min(durationSeconds, (index + 1) * beatsPerBar * secondsPerBeat).toFixed(4)), beats: beatsPerBar, confidence: 1 }));
    const melody = ordered.filter((event) => event.type === "note").map((event) => ({ start: tickToSeconds(event.data[0]), end: Math.max(tickToSeconds(event.tick), tickToSeconds(event.data[0]) + 0.04), pitch: event.data[1], velocity: event.data[2], confidence: 1, source: `MIDI_CHANNEL_${event.channel! + 1}` }));
    const channels = [...new Set(melody.map((note) => note.source))];
    return { durationSeconds, sampleRate: 44_100, channels: channels.length || 1, bpm, meter, key, tempoMap, meterMap: meters.length ? meters.map((event) => ({ bar: Math.max(1, Math.floor(tickToSeconds(event.tick) / (secondsPerBeat * beatsPerBar)) + 1), meter: meterFor(event), confidence: 1 })) : [{ bar: 1, meter, confidence: 1 }], keyMap: [{ time: 0, key, confidence: 1 }, ...keys.map((event) => ({ time: tickToSeconds(event.tick), key: keyFor(event), confidence: 1 }))], beats, bars, melody, sourceStems: channels.map((role) => ({ role, objectPath: "", provider: "STANDARD_MIDI", confidence: 1 })) };
  });
}

const midiKeyNames = ["C", "G", "D", "A", "E", "B", "F♯", "C♯", "A♭", "E♭", "B♭", "F"];

async function fullDurationEnergy(path: string, durationSeconds: number): Promise<number[]> {
  const bins = Math.max(24, Math.min(1_280, Math.ceil(durationSeconds / 2)));
  const sums = new Array<number>(bins).fill(0); const counts = new Array<number>(bins).fill(0);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", "200", "-f", "f32le", "pipe:1"]);
    let carry = Buffer.alloc(0); let sample = 0;
    child.stdout.on("data", (chunk: Buffer) => { const data = Buffer.concat([carry, chunk]); const complete = data.length - data.length % 4; for (let i = 0; i < complete; i += 4, sample++) { const bin = Math.min(bins - 1, Math.floor(sample / Math.max(1, durationSeconds * 200) * bins)); const value = data.readFloatLE(i); if (Number.isFinite(value)) { sums[bin] += value * value; counts[bin]++; } } carry = data.subarray(complete); });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Unable to decode audio overview")));
  });
  const raw = sums.map((sum, index) => Math.sqrt(sum / Math.max(1, counts[index])));
  const max = Math.max(...raw, 0.0001);
  return raw.map((value) => Number(Math.min(1, value / max).toFixed(3)));
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
