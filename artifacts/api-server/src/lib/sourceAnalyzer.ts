import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
} from "@workspace/db";
import { runAnalysisProviders } from "./analysisProviders";
import { createSourceDownloadUrl, getSourceObject } from "./objectStorage";
import { fuseProviderSongModels } from "./songModelValidation";

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
  const names = bars >= 48
    ? ["Intro", "Verse", "Chorus", "Verse 2", "Bridge", "Final Chorus", "Outro"]
    : ["Intro", "Verse", "Chorus", "Outro"];
  return names.map((name, index) => {
    const startBar = Math.floor((index / names.length) * bars) + 1;
    const endBar = index === names.length - 1
      ? bars
      : Math.max(startBar, Math.floor(((index + 1) / names.length) * bars));
    const energyIndex = Math.min(
      energy.length - 1,
      Math.floor(((index + 0.5) / names.length) * energy.length),
    );
    return { name, startBar, endBar, energy: energy[energyIndex] ?? 0.5 };
  });
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
    if (providerResults.transcription) {
      successfulAnalysisProviders.push(providerResults.transcription.providerId);
    }
    if (providerResults.separation) {
      successfulAnalysisProviders.push(providerResults.separation.providerId);
    }
    if (providerResults.harmony) {
      successfulAnalysisProviders.push(providerResults.harmony.providerId);
    }
    const providerConfidences = [
      providerResults.structure?.confidence,
      providerResults.transcription?.confidence,
      providerResults.separation?.confidence,
      providerResults.harmony?.confidence,
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
      melody: providerResults.transcription?.notes ?? [],
      chords: providerResults.harmony?.chords ?? [],
      sections,
      energy,
      dynamics: energy,
      sourceStems: providerResults.separation?.stems ?? [],
      lyrics: [],
      confidenceByField: {
        tempo: providerResults.structure?.confidence ?? confidence,
        meter: providerResults.structure?.confidence ?? 0.74,
        key: Math.max(0.5, confidence - 0.12),
        structure: providerResults.structure?.confidence ?? 0.58,
        melody: providerResults.transcription?.confidence ?? 0,
        harmony: providerResults.harmony?.confidence ?? 0,
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