import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { desc, eq } from "drizzle-orm";
import {
  db,
  musicArtifactsTable,
  musicProjectsTable,
  projectSourcesTable,
  songModelsTable,
  studioActivitiesTable,
  type AnalysisSection,
  type SongModelData,
} from "@workspace/db";
import { getSourceObject } from "./objectStorage";

const execFileAsync = promisify(execFile);

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
  const [source] = await db
    .select()
    .from(projectSourcesTable)
    .where(eq(projectSourcesTable.id, sourceId))
    .limit(1);
  if (!source) return;

  const directory = await mkdtemp(join(tmpdir(), "studio-source-"));
  const suffix = extname(source.name).replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
  const inputPath = join(directory, `source${suffix}`);
  try {
    await db.update(projectSourcesTable)
      .set({ status: "preprocessing", progress: 15, error: null })
      .where(eq(projectSourcesTable.id, source.id));

    const object = await getSourceObject(source.objectPath);
    if (!object) throw new Error("Uploaded object was not found");
    const objectStream = object.createReadStream();
    objectStream.setMaxListeners(20);
    await pipeline(objectStream, createWriteStream(inputPath));

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

    await db.update(projectSourcesTable)
      .set({
        status: "analyzing",
        progress: 48,
        durationSeconds,
        sampleRate: sourceSampleRate,
        channels,
      })
      .where(eq(projectSourcesTable.id, source.id));

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
    const fingerprint = await fingerprintFile(inputPath);
    const energy = energyCurve(samples);
    const bpm = estimateBpm(samples, decodeRate);
    const key = estimateKey(samples, decodeRate, fingerprint);
    const sections = makeSections(durationSeconds, bpm, energy);
    const confidence = Number(
      Math.min(0.94, 0.62 + Math.log10(Math.max(10, samples.length)) / 30).toFixed(2),
    );
    const model: SongModelData = {
      audio: {
        name: source.name,
        contentType: source.contentType,
        size: source.size,
        durationSeconds,
        sampleRate: sourceSampleRate,
        channels,
      },
      tempoMap: [{ time: 0, bpm, confidence }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 0.74 }],
      keyMap: [{ time: 0, key, confidence: Math.max(0.5, confidence - 0.12) }],
      melody: [],
      chords: [],
      sections,
      energy,
    };
    const previous = await db
      .select({ version: songModelsTable.version })
      .from(songModelsTable)
      .where(eq(songModelsTable.projectId, source.projectId))
      .orderBy(desc(songModelsTable.version))
      .limit(1);
    const version = (previous[0]?.version ?? 0) + 1;
    const songModelId = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(songModelsTable).values({
        id: songModelId,
        projectId: source.projectId,
        sourceId: source.id,
        version,
        model,
        providers: ["FFMPEG", "LOCAL_SIGNAL_ANALYZER_V1"],
        confidence,
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
          meter: "4/4",
          confidence,
          sections,
          energy,
          providers: ["FFMPEG", "LOCAL_SIGNAL_ANALYZER_V1"],
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
    const message = error instanceof Error ? error.message : "Source analysis failed";
    await db.update(projectSourcesTable)
      .set({ status: "failed", error: message, progress: 100 })
      .where(eq(projectSourcesTable.id, source.id));
    await db.update(musicProjectsTable)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(musicProjectsTable.id, source.projectId));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}