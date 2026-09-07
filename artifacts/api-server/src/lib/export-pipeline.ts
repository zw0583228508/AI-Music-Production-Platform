import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { SFZ_SAMPLE_LIBRARY } from "./sfz-sample-library";
import type { GeneratedExportFile } from "./exportEngine";
import type { PedalboardProcessingEvidence } from "./pedalboardBuiltin";
import {
  exportAudioRole,
  type ExportAudioRole,
} from "./exportAudioRoles";
import {
  expectedGpuCheckpointSha256,
  isGpuAttestedProvider,
} from "./gpuProviderAttestation";
import { CANONICAL_PPQ, createCanonicalTimeline } from "./canonicalTimeline";
import { publicCandidateEvaluation } from "./candidateRanking";
import type { CandidateEvaluation } from "@workspace/db";

type Project = {
  id: string;
  name: string;
  duration: string;
  bpm: number;
  meter: string;
  key: string;
  sourceType: string;
  sections: Array<{ name: string; startBar: number; endBar: number; energy: number }>;
  energy: number[];
  providers: string[];
};

type Arrangement = {
  id: string;
  projectId: string;
  name: string;
  style: string;
  mode: string;
  version: number;
  harmonyComplexity: number;
  energy: number;
  density: number;
  orchestraSize: number;
  rhythmIntensity: number;
  generationProvenance?: {
    provider: string;
    modelVersion: string;
    reportedModelVersion: string | null;
    checkpointSha256: string | null;
    candidateId: string;
    providerRequestId: string | null;
    seed: number;
    parentArtifactIds: string[];
    evaluation?: CandidateEvaluation;
  } | null;
  sections: Array<{
    name: string;
    energy: number;
    density: number;
    tracks: string[];
    startBar?: number;
    endBar?: number;
    transposeSemitones?: number;
    chords?: Array<{
      startBeat: number;
      durationBeats: number;
      symbol: string;
      quality: string;
      inversion: number;
      bass?: string;
    }>;
    automation?: Array<{ bar: number; value: number }>;
    midiNotes?: Array<{
      pitch: number;
      start: number;
      duration: number;
      velocity: number;
      articulation: string;
    }>;
    cc?: number[];
    midiTracks?: Record<string, {
      notes: Array<{
        pitch: number;
        start: number;
        duration: number;
        velocity: number;
        articulation: string;
      }>;
      cc: number[];
    }>;
  }>;
};

export type TrackPerformance = {
  ppq?: number;
  tempoMap: Array<{ tick: number; bpm: number }>;
  meterMap: Array<{ tick: number; numerator: number; denominator: number }>;
  notes: Array<{ startTick: number; durationTicks: number; pitch: number; velocity: number }>;
  expression: Array<{ tick: number; value: number }>;
  articulations: Array<{ tick: number; type: string; keyswitch: number }>;
};

type Track = {
  id: string;
  name: string;
  role: string;
  kind: string;
  volume: number;
  muted: boolean;
  solo: boolean;
  performance: TrackPerformance;
};

export type ExportInput = {
  arrangementId?: string | null;
  includeStems?: boolean;
  includeMidi?: boolean;
  includeMix?: boolean;
  includeMetadata?: boolean;
  masterProfile?: "STREAMING" | "DYNAMIC" | "CLASSICAL" | "POP" | "LOUD" | "FILM";
};

export type ExportFile = {
  name: string;
  type: "STEM" | "MIDI" | ExportAudioRole | "SONG_MODEL" | "ARRANGEMENT_PLAN" | "EXPORT";
  format: string;
  size: string;
  url: string;
};

export type ExportArtifactGraphEntry = {
  artifactId: string;
  parentIds: string[];
};
export type ExportPackage = {
  id: string;
  projectId: string;
  version: number;
  status: "ready";
  filename: string;
  size: string;
  createdAt: string;
  url: string;
  files: ExportFile[];
};

export type ExportBundle = {
  package: ExportPackage;
  zip: Buffer;
  files: Map<string, Buffer>;
};

const SAMPLE_RATE = 8_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const LEGACY_PPQ = 480;
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function meterTicksPerBar(meter: string, ppq: number = CANONICAL_PPQ): number {
  const [rawNumerator, rawDenominator] = meter.split("/");
  const numerator = Number(rawNumerator) || 4;
  const denominator = Number(rawDenominator) || 4;
  return numerator * ppq * 4 / denominator;
}

const SFZ_PRESETS: Record<string, string> = {
  rhythm: "<group> ampeg_attack=0.001 ampeg_release=0.08 <region> sample=samples/drum-c2.wav pitch_keycenter=36 harmonic=3",
  bass: "<group> ampeg_attack=0.01 ampeg_release=0.18 <region> sample=samples/bass-e2.wav pitch_keycenter=40 harmonic=2",
  harmony: "<group> ampeg_attack=0.03 ampeg_release=0.35 <region> sample=samples/piano-c4.wav pitch_keycenter=60 harmonic=1.5",
  countermelody: "<group> ampeg_attack=0.05 ampeg_release=0.42 <region> sample=samples/strings-g4.wav pitch_keycenter=67 harmonic=1.25",
  lift: "<group> ampeg_attack=0.06 ampeg_release=0.5 <region> sample=samples/brass-e4.wav pitch_keycenter=64 harmonic=1.75",
  melody: "<group> ampeg_attack=0.02 ampeg_release=0.25 <region> sample=samples/voice-a4.wav pitch_keycenter=69 harmonic=1.5",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "track";
}

function exportObjectPath(exportId: string): {
  bucketName: string;
  objectName: string;
} {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR is required for exports");
  const fullPath = `${privateDir.replace(/\/$/, "")}/exports/${exportId}.zip`;
  const parts = fullPath.replace(/^\//, "").split("/");
  if (parts.length < 2) throw new Error("PRIVATE_OBJECT_DIR is invalid");
  return {
    bucketName: parts[0],
    objectName: parts.slice(1).join("/"),
  };
}

async function signedObjectUrl(
  exportId: string,
  method: "GET" | "PUT",
): Promise<string> {
  const objectPath = exportObjectPath(exportId);
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: objectPath.bucketName,
        object_name: objectPath.objectName,
        method,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not create export storage URL (${response.status})`);
  }
  const payload = await response.json() as { signed_url?: string };
  if (!payload.signed_url) throw new Error("Export storage URL was not returned");
  return payload.signed_url;
}

export async function persistExportBundle(
  bundle: ExportBundle,
  storageObjectId = bundle.package.id,
): Promise<void> {
  const uploadUrl = await signedObjectUrl(storageObjectId, "PUT");
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/zip" },
    body: new Uint8Array(bundle.zip),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Could not store export package (${response.status})`);
  }
}

export async function loadExportZip(exportId: string): Promise<Buffer | null> {
  const downloadUrl = await signedObjectUrl(exportId, "GET");
  const response = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Could not load export package (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function durationSeconds(duration: string): number {
  const [minutes, seconds] = duration.split(":").map(Number);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return 30;
  return Math.max(4, minutes * 60 + seconds);
}

function parseSfzPreset(role: string): {
  sample: string;
  key: number;
  harmonic: number;
  attack: number;
  release: number;
  sourceText: string;
} {
  const sourceText = SFZ_PRESETS[role] ?? SFZ_PRESETS.harmony;
  const opcodes = Object.fromEntries(
    sourceText
      .replace(/<[^>]+>/g, " ")
      .trim()
      .split(/\s+/)
      .map((token) => token.split("=", 2))
      .filter((pair) => pair.length === 2),
  );
  return {
    sample: opcodes.sample || "samples/piano-c4.wav",
    key: Number(opcodes.pitch_keycenter) || 60,
    harmonic: Number(opcodes.harmonic) || 1.5,
    attack: Number(opcodes.ampeg_attack) || 0.01,
    release: Number(opcodes.ampeg_release) || 0.2,
    sourceText,
  };
}

function midiFrequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

function loadSfzSample(sampleName: string): Float32Array {
  const encoded = SFZ_SAMPLE_LIBRARY[sampleName];
  if (!encoded) throw new Error(`SFZ sample asset not found: ${sampleName}`);
  const wav = Buffer.from(encoded, "base64");
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`SFZ sample asset is not PCM WAV: ${sampleName}`);
  }
  const dataOffset = wav.indexOf(Buffer.from("data"));
  if (dataOffset < 0) throw new Error(`SFZ sample asset has no data chunk: ${sampleName}`);
  const sampleCount = wav.readUInt32LE(dataOffset + 4) / 2;
  const sample = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    sample[index] = wav.readInt16LE(dataOffset + 8 + index * 2) / 32768;
  }
  return sample;
}

export function tickToSeconds(
  tick: number,
  tempoMap: TrackPerformance["tempoMap"],
  ppq = LEGACY_PPQ,
): number {
  const map = [...tempoMap].sort((left, right) => left.tick - right.tick);
  if (map.length === 0 || map[0].tick !== 0) map.unshift({ tick: 0, bpm: 120 });
  const secondsMap = map.map((event, index) => ({
    time: index
      ? map.slice(0, index).reduce((seconds, previous, previousIndex) =>
        seconds + (map[previousIndex + 1].tick - previous.tick) * 60 / (previous.bpm * ppq), 0)
      : 0,
    bpm: event.bpm,
  }));
  const timeline = createCanonicalTimeline(secondsMap, [{ bar: 1, meter: "4/4" }]);
  return timeline.tickToSeconds(tick * CANONICAL_PPQ / ppq);
}

function expressionAt(tick: number, expression: TrackPerformance["expression"]): number {
  let value = 100;
  for (const event of expression) {
    if (event.tick > tick) break;
    value = event.value;
  }
  return value;
}

const ROOT_PITCH_CLASS: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4,
  F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9,
  "A#": 10, Bb: 10, B: 11,
};

function chordPitches(
  chord: NonNullable<Arrangement["sections"][number]["chords"]>[number],
  transpose: number,
): number[] {
  const rootName = chord.symbol.match(/^[A-G](?:#|b)?/)?.[0] ?? chord.bass ?? "C";
  const root = 48 + (ROOT_PITCH_CLASS[rootName] ?? 0) + transpose;
  const intervals = chord.quality === "minor"
    ? [0, 3, 7]
    : chord.quality === "diminished"
      ? [0, 3, 6]
      : chord.quality === "suspended"
        ? [0, 5, 7]
        : chord.quality === "dominant"
          ? [0, 4, 7, 10]
          : [0, 4, 7];
  const pitches = intervals.map((interval) => root + interval);
  for (let inversion = 0; inversion < Math.min(chord.inversion, pitches.length); inversion += 1) {
    pitches.push(pitches.shift()! + 12);
  }
  if (chord.bass && ROOT_PITCH_CLASS[chord.bass] !== undefined) {
    pitches.unshift(36 + ROOT_PITCH_CLASS[chord.bass] + transpose);
  }
  return pitches;
}

export function createTrackPerformance(
  track: Track,
  project: Project,
  arrangement: Arrangement,
  trackIndex: number,
  hasSoloTrack = false,
): TrackPerformance {
  const [numeratorText, denominatorText] = project.meter.split("/");
  const numerator = Number(numeratorText) || 4;
  const denominator = Number(denominatorText) || 4;
  const sections: Array<Arrangement["sections"][number] & { startBar: number; endBar: number }> = project.sections.length
    ? project.sections.map((section, sectionIndex) => {
        const arrangementSection = arrangement.sections.find((candidate) =>
          candidate.name.toLowerCase() === section.name.toLowerCase())
          ?? arrangement.sections[sectionIndex];
        return {
          ...section,
          ...arrangementSection,
          energy: arrangementSection?.energy ?? section.energy,
          density: arrangementSection?.density ?? arrangement.density,
          tracks: arrangementSection?.tracks ?? [],
          startBar: arrangementSection?.startBar ?? section.startBar,
          endBar: arrangementSection?.endBar ?? section.endBar,
        };
      })
    : arrangement.sections.map((section, index) => ({
        ...section,
        startBar: section.startBar ?? index * 8 + 1,
        endBar: section.endBar ?? index * 8 + 8,
      }));
  const rolePitch: Record<string, number> = {
    rhythm: 36,
    bass: 40,
    harmony: 60,
    countermelody: 67,
    lift: 64,
    melody: 69,
  };
  const ticksPerBar = meterTicksPerBar(project.meter);
  const ticksPerBeat = CANONICAL_PPQ * 4 / denominator;
  const tempoMap = sections.map((section, index) => ({
    tick: Math.max(0, section.startBar - 1) * ticksPerBar,
    bpm: Math.max(40, Math.round(project.bpm + (section.energy - 0.5) * 4 + (index % 2))),
  }));
  const notes: TrackPerformance["notes"] = [];
  const expression: TrackPerformance["expression"] = [];
  const articulations: TrackPerformance["articulations"] = [];
  const basePitch = rolePitch[track.role] ?? 60 + (trackIndex % 5);
  const trackIdentity = `${track.name} ${track.role}`.toLowerCase();
  const roleAliases: Record<string, string[]> = {
    rhythm: ["drum", "drums", "percussion"],
    bass: ["bass"],
    harmony: ["piano", "keys", "keyboard", "harmony"],
    countermelody: ["strings", "orchestra", "countermelody"],
    lift: ["brass", "horn", "horns", "lift"],
    melody: ["vocal", "voice", "lead", "melody"],
  };
  const trackAliases = [
    trackIdentity,
    ...(roleAliases[track.role] ?? []),
    ...(/horn/.test(trackIdentity) ? ["brass"] : []),
  ];
  const globallyEnabled = !track.muted && (!hasSoloTrack || track.solo);
  for (const [sectionIndex, section] of sections.entries()) {
    const activeInSection = globallyEnabled && (
      /vocal|voice/.test(trackIdentity)
      || section.tracks.length === 0
      || section.tracks.some((part) => {
        const token = part.toLowerCase();
        return trackAliases.some((alias) => alias.includes(token))
          || token.includes(track.role.toLowerCase());
      })
    );
    if (!activeInSection) continue;
    const sectionTick = Math.max(0, section.startBar - 1) * ticksPerBar;
    expression.push({
      tick: sectionTick,
      value: Math.max(24, Math.min(127, Math.round(42 + section.energy * 82))),
    });
    const articulation = section.energy > 0.78 ? "accent" : track.role === "rhythm" ? "staccato" : "legato";
    articulations.push({
      tick: sectionTick,
      type: articulation,
      keyswitch: articulation === "accent" ? 26 : articulation === "staccato" ? 25 : 24,
    });
    for (const point of section.automation ?? []) {
      expression.push({
        tick: Math.max(0, point.bar - 1) * ticksPerBar,
        value: Math.max(0, Math.min(127, Math.round(point.value * 127))),
      });
    }
    const transpose = section.transposeSemitones ?? 0;
    const editor = section.midiTracks?.[track.name]
      ?? (track.kind === "midi" && section.midiNotes
        ? { notes: section.midiNotes, cc: section.cc ?? [] }
        : undefined);
    if (editor) {
      const sectionDurationTicks = (section.endBar - section.startBar + 1) * ticksPerBar;
      for (const [ccIndex, value] of editor.cc.entries()) {
        expression.push({
          tick: sectionTick + Math.round((ccIndex / Math.max(1, editor.cc.length - 1)) * sectionDurationTicks),
          value: Math.max(0, Math.min(127, Math.round(value))),
        });
      }
      for (const note of editor.notes) {
        const noteTick = sectionTick + Math.round(note.start * ticksPerBeat);
        notes.push({
          startTick: noteTick,
          durationTicks: Math.max(1, Math.round(note.duration * ticksPerBeat)),
          pitch: Math.max(0, Math.min(127, note.pitch + transpose)),
          velocity: Math.max(1, Math.min(127, Math.round(note.velocity))),
        });
        articulations.push({
          tick: noteTick,
          type: note.articulation,
          keyswitch: note.articulation === "accent" ? 26 : note.articulation === "staccato" ? 25 : note.articulation === "ghost" ? 23 : 24,
        });
      }
    }
    if (track.role === "harmony" && section.chords?.length) {
      for (const chord of section.chords) {
        const startTick = sectionTick + Math.round(chord.startBeat * ticksPerBeat);
        const durationTicks = Math.max(1, Math.round(chord.durationBeats * ticksPerBeat));
        for (const pitch of chordPitches(chord, transpose)) {
          notes.push({
            startTick,
            durationTicks,
            pitch: Math.max(0, Math.min(127, pitch)),
            velocity: Math.max(35, Math.min(127, Math.round(54 + section.energy * 64))),
          });
        }
      }
    }
    if (editor || (track.role === "harmony" && section.chords?.length)) continue;
    const stepsPerBar = track.role === "rhythm" ? numerator : track.role === "bass" ? 2 : 1;
    const stepTicks = Math.max(1, Math.round(ticksPerBar / stepsPerBar));
    for (let bar = section.startBar; bar <= section.endBar; bar += 1) {
      for (let step = 0; step < stepsPerBar; step += 1) {
        const startTick = ((bar - 1) * ticksPerBar) + step * stepTicks;
        notes.push({
          startTick,
          durationTicks: track.role === "rhythm" ? Math.round(ticksPerBeat * 0.35) : Math.round(stepTicks * 0.86),
          pitch: basePitch + ((bar + step + sectionIndex) % 4 === 0 ? 7 : (bar + sectionIndex) % 3) * (track.role === "rhythm" ? 0 : 2),
          velocity: Math.max(35, Math.min(127, Math.round(54 + section.energy * 64))),
        });
      }
    }
  }
  return {
    ppq: CANONICAL_PPQ,
    tempoMap,
    meterMap: [{ tick: 0, numerator, denominator }],
    notes,
    expression: expression.sort((left, right) => left.tick - right.tick),
    articulations: articulations.sort((left, right) => left.tick - right.tick),
  };
}

export function performanceDurationSeconds(
  tracks: Array<{ role: string; performance: TrackPerformance }>,
): number {
  let endSeconds = 0;
  for (const track of tracks) {
    const release = parseSfzPreset(track.role).release;
    for (const note of track.performance.notes) {
      const noteEnd = tickToSeconds(
        note.startTick + note.durationTicks,
        track.performance.tempoMap,
        track.performance.ppq ?? LEGACY_PPQ,
      );
      endSeconds = Math.max(endSeconds, noteEnd + release);
    }
  }
  return endSeconds;
}

function arrangementEndTick(
  project: Project,
  arrangement: Arrangement,
  ppq: number = CANONICAL_PPQ,
): number {
  const ticksPerBar = meterTicksPerBar(project.meter, ppq);
  const editedEndBars = arrangement.sections
    .map((section) => section.endBar)
    .filter((endBar): endBar is number => Number.isFinite(endBar));
  const finalBar = editedEndBars.length
    ? Math.max(...editedEndBars)
    : project.sections.length
      ? Math.max(...project.sections.map((section) => section.endBar))
      : arrangement.sections.length * 8;
  return finalBar * ticksPerBar;
}

export function exportTimelineSeconds(
  project: Project,
  arrangement: Arrangement,
  tracks: Array<{ role: string; performance: TrackPerformance }>,
): number {
  const tempoMap = tracks.find((track) => track.performance.tempoMap.length)
    ?.performance.tempoMap ?? [{ tick: 0, bpm: project.bpm }];
  const ppq = tracks.find((track) => track.performance.tempoMap.length)
    ?.performance.ppq ?? LEGACY_PPQ;
  return Math.max(
    performanceDurationSeconds(tracks),
    tickToSeconds(arrangementEndTick(project, arrangement, ppq), tempoMap, ppq),
  );
}

function writeWav(samples: Float32Array): Buffer {
  const dataSize = samples.length * (BITS_PER_SAMPLE / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8), 28);
  buffer.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return buffer;
}

function renderTrack(track: Track, seconds: number): Float32Array {
  const sampleCount = Math.ceil(seconds * SAMPLE_RATE);
  const samples = new Float32Array(sampleCount);
  const preset = parseSfzPreset(track.role);
  const sourceSample = loadSfzSample(preset.sample);
  const gain = Math.max(0.05, Math.min(1, 10 ** (track.volume / 20))) * (track.muted ? 0 : 0.18);
  for (const note of track.performance.notes) {
    const ppq = track.performance.ppq ?? LEGACY_PPQ;
    const startSeconds = tickToSeconds(note.startTick, track.performance.tempoMap, ppq);
    const noteSeconds = tickToSeconds(
      note.startTick + note.durationTicks,
      track.performance.tempoMap,
      ppq,
    ) - startSeconds;
    const startSample = Math.max(0, Math.floor(startSeconds * SAMPLE_RATE));
    const endSample = Math.min(sampleCount, Math.ceil((startSeconds + noteSeconds + preset.release) * SAMPLE_RATE));
    const pitchRatio = 2 ** ((note.pitch - preset.key) / 12);
    const expression = expressionAt(note.startTick, track.performance.expression) / 127;
    const articulation = [...track.performance.articulations]
      .reverse()
      .find((event) => event.tick <= note.startTick)?.type;
    const articulationAttack = articulation === "staccato" ? preset.attack * 0.35 : preset.attack;
    const articulationLength = articulation === "staccato" ? noteSeconds * 0.55 : noteSeconds;
    const articulationGain = articulation === "accent" ? 1.2 : 1;
    for (let index = startSample; index < endSample; index += 1) {
      const noteTime = (index - startSample) / SAMPLE_RATE;
      const attack = Math.min(1, noteTime / articulationAttack);
      const release = noteTime <= articulationLength
        ? 1
        : Math.max(0, 1 - (noteTime - articulationLength) / preset.release);
      const sampleIndex = Math.floor(noteTime * SAMPLE_RATE * pitchRatio) % sourceSample.length;
      samples[index] += sourceSample[sampleIndex]
        * attack
        * release
        * (note.velocity / 127)
        * expression
        * articulationGain
        * gain;
    }
  }
  return samples;
}

function mixSamples(
  tracks: Float32Array[],
  master = false,
  masterProfile: ExportInput["masterProfile"] = "STREAMING",
): Float32Array {
  const length = tracks.reduce((longest, current) => Math.max(longest, current.length), 0);
  const mixed = new Float32Array(length);
  for (const track of tracks) {
    for (let index = 0; index < track.length; index += 1) mixed[index] += track[index];
  }
  let peak = 0;
  for (const value of mixed) peak = Math.max(peak, Math.abs(value));
  const profile = {
    STREAMING: { peak: 0.92, drive: 1.35 },
    DYNAMIC: { peak: 0.82, drive: 1.1 },
    CLASSICAL: { peak: 0.76, drive: 1.04 },
    POP: { peak: 0.95, drive: 1.5 },
    LOUD: { peak: 0.98, drive: 1.75 },
    FILM: { peak: 0.86, drive: 1.18 },
  }[masterProfile ?? "STREAMING"];
  const gain = peak > 0 ? (master ? profile.peak / peak : 0.78 / peak) : 1;
  for (let index = 0; index < mixed.length; index += 1) {
    const value = mixed[index] * gain;
    mixed[index] = master ? Math.tanh(value * profile.drive) * profile.peak : value;
  }
  return mixed;
}

function vlq(value: number): number[] {
  let remaining = Math.max(0, Math.floor(value));
  const bytes = [remaining & 0x7f];
  while ((remaining >>= 7) > 0) bytes.unshift((remaining & 0x7f) | 0x80);
  return bytes;
}

function midiEvent(delta: number, bytes: number[]): number[] {
  return [...vlq(delta), ...bytes];
}

function midiMeta(delta: number, type: number, data: number[]): number[] {
  return midiEvent(delta, [0xff, type, ...vlq(data.length), ...data]);
}

function asciiBytes(value: string): number[] {
  return Array.from(Buffer.from(value, "utf8"));
}

function midiTrackChunk(events: number[]): Buffer {
  const track = Buffer.from([...events, ...midiMeta(0, 0x2f, [])]);
  const chunk = Buffer.alloc(8 + track.length);
  chunk.write("MTrk", 0);
  chunk.writeUInt32BE(track.length, 4);
  track.copy(chunk, 8);
  return chunk;
}

type TimedMidiEvent = {
  tick: number;
  order: number;
  bytes: number[];
};

function timedMidiEvents(events: TimedMidiEvent[]): number[] {
  let previousTick = 0;
  const output: number[] = [];
  for (const event of [...events].sort((left, right) => left.tick - right.tick || left.order - right.order)) {
    output.push(...midiEvent(event.tick - previousTick, event.bytes));
    previousTick = event.tick;
  }
  return output;
}

export function normalizeMidiTick(
  tick: number,
  sourcePpq: number,
  targetPpq: number = CANONICAL_PPQ,
): number {
  if (!Number.isFinite(tick) || !Number.isFinite(sourcePpq) || sourcePpq <= 0) {
    throw new Error("MIDI ticks require a finite value and positive source PPQ.");
  }
  return Math.max(0, Math.round(tick * targetPpq / sourcePpq));
}

function renderMidi(project: Project, arrangement: Arrangement, tracks: Track[]): Buffer {
  const performance = tracks.find((track) => track.performance.tempoMap.length)?.performance;
  const ppq = CANONICAL_PPQ;
  const conductorSourcePpq = performance?.ppq ?? LEGACY_PPQ;
  const conductorTimed: TimedMidiEvent[] = [
    { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(asciiBytes(`${project.name} · ${arrangement.name}`).length), ...asciiBytes(`${project.name} · ${arrangement.name}`)] },
  ];
  for (const event of performance?.tempoMap ?? [{ tick: 0, bpm: project.bpm }]) {
    const tempo = Math.round(60_000_000 / Math.max(40, event.bpm || 100));
    conductorTimed.push({
      tick: normalizeMidiTick(event.tick, conductorSourcePpq, ppq),
      order: 1,
      bytes: [0xff, 0x51, 3, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff],
    });
  }
  for (const event of performance?.meterMap ?? [{ tick: 0, numerator: 4, denominator: 4 }]) {
    conductorTimed.push({
      tick: normalizeMidiTick(event.tick, conductorSourcePpq, ppq),
      order: 2,
      bytes: [0xff, 0x58, 4, event.numerator, Math.round(Math.log2(event.denominator)), 24, 8],
    });
  }
  conductorTimed.push({
    tick: 0,
    order: 3,
    bytes: [0xff, 0x01, ...vlq(asciiBytes("tempo map and meter map from track performance").length), ...asciiBytes("tempo map and meter map from track performance")],
  });
  const endLabel = asciiBytes("arrangement end");
  conductorTimed.push({
    tick: arrangementEndTick(project, arrangement, ppq),
    order: 99,
    bytes: [0xff, 0x06, ...vlq(endLabel.length), ...endLabel],
  });
  const trackChunks = [midiTrackChunk(timedMidiEvents(conductorTimed))];

  tracks.filter((track) => track.kind === "midi").forEach((track, trackIndex) => {
    const sourcePpq = track.performance.ppq ?? LEGACY_PPQ;
    const channel = trackIndex % 15;
    const program = 32 + (trackIndex * 11) % 64;
    const nameBytes = asciiBytes(track.name);
    const events: TimedMidiEvent[] = [
      { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes] },
      { tick: 0, order: 1, bytes: [0xc0 | channel, program] },
      { tick: 0, order: 2, bytes: [0xb0 | channel, 7, Math.max(0, Math.min(127, Math.round(100 + track.volume)))] },
      { tick: 0, order: 3, bytes: [0xb0 | channel, 74, track.role === "countermelody" ? 96 : 64] },
    ];
    for (const expression of track.performance.expression) {
      events.push({
        tick: normalizeMidiTick(expression.tick, sourcePpq, ppq),
        order: 4,
        bytes: [0xb0 | channel, 11, Math.max(0, Math.min(127, expression.value))],
      });
    }
    for (const articulation of track.performance.articulations) {
      const label = asciiBytes(`articulation: ${articulation.type}`);
      events.push(
        { tick: normalizeMidiTick(articulation.tick, sourcePpq, ppq), order: 5, bytes: [0xff, 0x01, ...vlq(label.length), ...label] },
        { tick: normalizeMidiTick(articulation.tick, sourcePpq, ppq), order: 6, bytes: [0x90 | channel, articulation.keyswitch, 1] },
        { tick: normalizeMidiTick(articulation.tick + 30, sourcePpq, ppq), order: 0, bytes: [0x80 | channel, articulation.keyswitch, 0] },
      );
    }
    for (const note of track.performance.notes) {
      events.push(
        { tick: normalizeMidiTick(note.startTick, sourcePpq, ppq), order: 10, bytes: [0x90 | channel, note.pitch, note.velocity] },
        { tick: normalizeMidiTick(note.startTick + note.durationTicks, sourcePpq, ppq), order: 0, bytes: [0x80 | channel, note.pitch, 0] },
      );
    }
    trackChunks.push(midiTrackChunk(timedMidiEvents(events)));
  });

  const header = Buffer.alloc(14);
  header.write("MThd", 0);
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(1, 8);
  header.writeUInt16BE(trackChunks.length, 10);
  header.writeUInt16BE(ppq, 12);
  return Buffer.concat([header, ...trackChunks]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    name.copy(localHeader, 30);
    local.push(localHeader, entry.data);

    const centralHeader = Buffer.alloc(46 + name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    name.copy(centralHeader, 46);
    central.push(centralHeader);
    offset += localHeader.length + entry.data.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}

export function createExportBundle(
  project: Project,
  arrangement: Arrangement,
  tracks: Track[],
  input: ExportInput,
  version: number,
  baseUrl: string,
  exportId?: string,
  renderedFiles?: GeneratedExportFile[],
  artifactGraph?: Record<string, ExportArtifactGraphEntry>,
  processingEvidence?: Record<string, PedalboardProcessingEvidence>,
): ExportBundle {
  const generation = arrangement.generationProvenance;
  const expectedCheckpoint = generation && isGpuAttestedProvider(generation.provider)
    ? expectedGpuCheckpointSha256(generation.provider)
    : null;
  if (
    generation &&
    isGpuAttestedProvider(generation.provider) &&
    (
      !expectedCheckpoint ||
      generation.checkpointSha256?.toLowerCase() !== expectedCheckpoint
    )
  ) {
    throw new Error(
      "GPU-backed arrangement checkpoint provenance does not match the deployment pin",
    );
  }
  const id = exportId ?? `export-${project.id}-${version}-${randomUUID().slice(0, 8)}`;
  const filename = `${safeName(project.name)}-v${version}-export.zip`;
  const timelineSeconds = exportTimelineSeconds(project, arrangement, tracks);
  const seconds = timelineSeconds > 0
    ? timelineSeconds
    : durationSeconds(project.duration);
  const rendered = renderedFiles
    ? []
    : tracks.map((track) => ({ track, samples: renderTrack(track, seconds) }));
  const audioTracks = rendered.filter(({ track }) => !track.muted);
  const instrumentalTracks = audioTracks.filter(({ track }) => !/vocal|voice|lead/i.test(track.name));
  const entries: Array<{ name: string; data: Buffer }> = [];
  const fileRecords: Array<{ name: string; type: ExportFile["type"]; data: Buffer }> = [];

  if (renderedFiles) {
    for (const file of renderedFiles) {
      fileRecords.push({
        name: file.name,
        type: file.type === "METADATA"
            ? "ARRANGEMENT_PLAN"
            : file.type,
        data: file.data,
      });
    }
  } else if (input.includeStems !== false) {
    for (const { track, samples } of rendered) {
      const name = `stems/${safeName(track.name)}.wav`;
      fileRecords.push({ name, type: "STEM", data: writeWav(samples) });
    }
  }

  if (!renderedFiles && input.includeMix !== false) {
    const premaster = writeWav(mixSamples(audioTracks.map(({ samples }) => samples)));
    const instrumental = writeWav(mixSamples(instrumentalTracks.map(({ samples }) => samples)));
    const mastered = writeWav(mixSamples(
      audioTracks.map(({ samples }) => samples),
      true,
      input.masterProfile,
    ));
    fileRecords.push({
      name: "mix/premaster.wav",
      type: exportAudioRole("premaster"),
      data: premaster,
    });
    fileRecords.push({
      name: "mix/instrumental.wav",
      type: exportAudioRole("mix"),
      data: instrumental,
    });
    fileRecords.push({
      name: "mix/mastered.wav",
      type: exportAudioRole("master"),
      data: mastered,
    });
  }

  if (!renderedFiles && input.includeMidi !== false) {
    fileRecords.push({
      name: `midi/${safeName(project.name)}-arrangement.mid`,
      type: "MIDI",
      data: renderMidi(project, arrangement, tracks),
    });
  }

  const songModel = {
    schema: "song-model/v1",
    project: { id: project.id, name: project.name, sourceType: project.sourceType, key: project.key },
    analysis: { bpm: project.bpm, meter: project.meter, duration: project.duration, sections: project.sections, energy: project.energy, providers: project.providers },
    tracks: tracks.map(({ id, name, role, kind, volume, muted, solo, performance }) => ({
      id,
      name,
      role,
      kind,
      volume,
      muted,
      solo,
      performance,
    })),
    generatedAt: new Date().toISOString(),
  };
  const publicArrangement = arrangement.generationProvenance?.evaluation
    ? {
        ...arrangement,
        generationProvenance: {
          ...arrangement.generationProvenance,
          evaluation: publicCandidateEvaluation(
            arrangement.generationProvenance.evaluation,
          ),
        },
      }
    : arrangement;
  const arrangementMetadata = {
    schema: "arrangement-metadata/v1",
    arrangement: publicArrangement,
    rendering: {
      engine: "embedded-sfz-sampler",
      presetFormat: "SFZ v2 opcode subset",
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitDepth: BITS_PER_SAMPLE,
      masterProfile: input.masterProfile ?? "STREAMING",
      trackPresets: tracks.map((track) => ({
        trackId: track.id,
        role: track.role,
        sfz: parseSfzPreset(track.role).sourceText,
      })),
    },
  };
  if (!renderedFiles && input.includeMetadata !== false) {
    fileRecords.push({ name: "metadata/song-model.json", type: "SONG_MODEL", data: Buffer.from(JSON.stringify(songModel, null, 2)) });
    fileRecords.push({ name: "metadata/arrangement.json", type: "ARRANGEMENT_PLAN", data: Buffer.from(JSON.stringify(arrangementMetadata, null, 2)) });
  }

  const packageFileRecords = fileRecords.map(({ name, type, data }) => ({
    name,
    type,
    format: name.endsWith(".wav") ? "WAV" : name.endsWith(".mid") ? "MIDI" : "JSON",
    size: formatBytes(data.length),
    url: `${baseUrl}/api/exports/${id}/download`,
  }));
  const manifest = {
    schema: "music-studio-export/v1",
    id,
    projectId: project.id,
    projectName: project.name,
    arrangementId: arrangement.id,
    arrangementVersion: arrangement.version,
    generation: generation
      ? {
          provider: generation.provider,
          modelVersion: generation.modelVersion,
          reportedModelVersion: generation.reportedModelVersion,
          checkpointSha256: generation.checkpointSha256,
          candidateId: generation.candidateId,
          providerRequestId: generation.providerRequestId,
          seed: generation.seed,
          parentArtifactIds: generation.parentArtifactIds,
        }
      : null,
    files: packageFileRecords,
    artifactGraph: packageFileRecords.map((file) => ({
      file: file.name,
      artifactId: artifactGraph?.[file.name]?.artifactId ?? null,
      parentIds: artifactGraph?.[file.name]?.parentIds ?? [],
    })),
    processingEvidence: processingEvidence ?? {},
    notes: "WAV files are linear PCM and MIDI includes tempo, meter, expression CC11, modulation CC74, and articulation events.",
  };
  const manifestData = Buffer.from(JSON.stringify(manifest, null, 2));
  fileRecords.push({ name: "metadata/export-manifest.json", type: "EXPORT", data: manifestData });

  for (const file of fileRecords) entries.push({ name: file.name, data: file.data });
  const zip = zipStored(entries);
  const createdAt = new Date().toISOString();
  const packageFile = {
    id,
    projectId: project.id,
    version,
    status: "ready" as const,
    filename,
    size: formatBytes(zip.length),
    createdAt,
    url: `${baseUrl}/api/exports/${id}/download`,
    files: packageFileRecords,
  };
  return {
    package: packageFile,
    zip,
    files: new Map(fileRecords.map(({ name, data }) => [name, data])),
  };
}
