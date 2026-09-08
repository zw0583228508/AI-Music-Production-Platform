import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type {
  ArrangementPlan,
  ArtifactProvenance,
  SongModelData,
  StyleSpec,
  TrackModel,
  MixMasterControls,
} from "@workspace/db";
import {
  MasterEngine,
  MixGraph,
  PedalboardRenderer,
  QualityEngine,
  SfzRenderer,
  canonicalPerformanceTimelineSha256,
  canonicalPerformancePhraseIds,
  getInstrumentPerformanceCapability,
  performedMaterialSha256,
  renderMusicPipeline,
  type RenderedTrack,
} from "./musicEngines";
import { validateCanonicalTrackModels } from "./musicProviders";
import type { PedalboardProcessingEvidence } from "./pedalboardBuiltin";
import {
  exportAudioRole,
  type ExportAudioRole,
} from "./exportAudioRoles";

export type ExportTrack = {
  id: string;
  name: string;
  role: string;
  volume: number;
  muted: boolean;
  solo?: boolean;
};

export type GeneratedExportFile = {
  name: string;
  type: "STEM" | "MIDI" | ExportAudioRole | "METADATA";
  format: string;
  contentType: string;
  data: Buffer;
  provenance: ArtifactProvenance;
  rendererEvidence?: ExportRendererEvidence;
  processingEvidence?: PedalboardProcessingEvidence;
};

export type ExportRendererEvidence = {
  trackName: string;
  role: string;
  rendererStatus: "licensed-native" | "preview-only";
  rendererProvider: string;
  rendererProduct?: string;
  nativeHost?: string;
  licenseOwner?: string;
  licenseReference?: string;
  assetSha256?: string;
  rendererSha256?: string;
  smokeOutputSha256?: string;
  trackModelSha256?: string;
  rendererOutputSha256?: string;
  stemOutputSha256?: string;
  runtimeIdentity?: string;
  performedMaterialSha256: string;
  midiAgreementSha256: string;
  productionReady: boolean;
  fallbackReason?: string;
};

export function rendererEvidenceTechnicalMetadata(
  evidence?: ExportRendererEvidence,
): Record<string, string> {
  if (!evidence) return {};
  return {
    rendererStatus: evidence.rendererStatus,
    rendererProvider: evidence.rendererProvider,
    ...(evidence.rendererProduct ? { rendererProduct: evidence.rendererProduct } : {}),
    ...(evidence.nativeHost ? { nativeHost: evidence.nativeHost } : {}),
    ...(evidence.licenseOwner ? { licenseOwner: evidence.licenseOwner } : {}),
    ...(evidence.licenseReference ? { licenseReference: evidence.licenseReference } : {}),
    ...(evidence.assetSha256 ? { assetSha256: evidence.assetSha256 } : {}),
    ...(evidence.rendererSha256 ? { rendererSha256: evidence.rendererSha256 } : {}),
    ...(evidence.smokeOutputSha256 ? { smokeOutputSha256: evidence.smokeOutputSha256 } : {}),
    ...(evidence.trackModelSha256 ? { trackModelSha256: evidence.trackModelSha256 } : {}),
    ...(evidence.rendererOutputSha256 ? { rendererOutputSha256: evidence.rendererOutputSha256 } : {}),
    ...(evidence.stemOutputSha256 ? { stemOutputSha256: evidence.stemOutputSha256 } : {}),
    ...(evidence.runtimeIdentity ? { runtimeIdentity: evidence.runtimeIdentity } : {}),
    performedMaterialSha256: evidence.performedMaterialSha256,
    midiAgreementSha256: evidence.midiAgreementSha256,
    productionReady: String(evidence.productionReady),
    ...(evidence.fallbackReason ? { fallbackReason: evidence.fallbackReason } : {}),
  };
}

export function processingEvidenceTechnicalMetadata(
  evidence?: PedalboardProcessingEvidence,
): Record<string, string | number> {
  if (!evidence) return {};
  return {
    processingProvider: evidence.provider,
    processingVersion: evidence.version,
    processingStatus: evidence.status,
    processingGainDb: evidence.parameters.gainDb,
    processingThresholdDb: evidence.parameters.thresholdDb,
    processingInputSha256: evidence.inputSha256,
    processingOutputSha256: evidence.outputSha256,
  };
}

const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const DURATION_SECONDS = 8;

function clamp(value: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export function validateNativeRenderSamples(
  samples: Float32Array,
  expectedLength: number,
): string[] {
  const errors: string[] = [];
  if (samples.length !== expectedLength) {
    errors.push(`sample length ${samples.length} does not match ${expectedLength}`);
    return errors;
  }
  let peak = 0;
  let activeFrames = 0;
  let clippedSamples = 0;
  for (let index = 0; index < samples.length; index += 2) {
    const left = samples[index];
    const right = samples[index + 1];
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      errors.push("audio contains non-finite samples");
      break;
    }
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    if (Math.max(Math.abs(left), Math.abs(right)) > 0.0005) activeFrames += 1;
    if (Math.abs(left) >= 0.999 || Math.abs(right) >= 0.999) clippedSamples += 1;
  }
  const frames = Math.max(1, samples.length / CHANNELS);
  if (peak < 0.0005 || activeFrames / frames < 0.005) {
    errors.push("audio is silent or effectively empty");
  }
  if (clippedSamples / frames > 0.001) {
    errors.push("audio contains excessive clipping");
  }
  return errors;
}
function safeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase() || "track";
}

function seededNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function createStem(
  track: ExportTrack,
  index: number,
  bpm: number,
  controls: {
    energy: number;
    density: number;
    harmonyComplexity: number;
    sections: Array<{ name: string; energy: number; density: number; tracks: string[] }>;
  },
): Float32Array {
  const frames = SAMPLE_RATE * DURATION_SECONDS;
  const output = new Float32Array(frames * CHANNELS);
  const random = seededNoise(index * 97 + track.name.length * 31);
  const role = `${track.role} ${track.name}`.toLowerCase();
  const baseFrequency = role.includes("bass")
    ? 73.42
    : role.includes("piano")
      ? 293.66
      : role.includes("string")
        ? 220
        : role.includes("brass") || role.includes("horn")
          ? 174.61
          : role.includes("vocal")
            ? 261.63
            : 110;
  const baseGain = track.muted ? 0 : Math.pow(10, track.volume / 20);
  const beatSeconds = 60 / Math.max(40, bpm || 92);
  const trackIdentity = `${track.role} ${track.name}`.toLowerCase();
  const sections = controls.sections.length
    ? controls.sections
    : [{
        name: "Full arrangement",
        energy: controls.energy,
        density: controls.density,
        tracks: [],
      }];

  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / SAMPLE_RATE;
    const beatPhase = (time % beatSeconds) / beatSeconds;
    const sectionIndex = Math.min(
      sections.length - 1,
      Math.floor((time / DURATION_SECONDS) * sections.length),
    );
    const section = sections[sectionIndex];
    const sectionEnergy = clamp(section.energy ?? controls.energy, 0, 1);
    const sectionDensity = clamp(section.density ?? controls.density, 0, 1);
    const trackActive =
      trackIdentity.includes("vocal") ||
      section.tracks.length === 0 ||
      section.tracks.some((part) => {
        const token = part.toLowerCase();
        return trackIdentity.includes(token) || token.includes(track.role.toLowerCase());
      });
    const gain =
      baseGain * (trackActive ? 0.1 + sectionEnergy * 0.13 : 0);
    let sample: number;

    if (role.includes("drum") || role.includes("rhythm")) {
      const kickEnvelope = Math.exp(-beatPhase * 18);
      const snareBeat = ((time / beatSeconds) | 0) % 2 === 1;
      const noise = (random() * 2 - 1) * Math.exp(-beatPhase * 30);
      sample =
        Math.sin(2 * Math.PI * (52 + 38 * (1 - beatPhase)) * time) *
          kickEnvelope *
          0.8 +
        (snareBeat ? noise * 0.55 : noise * 0.08);
    } else {
      const chordIndex =
        (Math.floor(time / (beatSeconds * 4)) + sectionIndex) % 4;
      const ratios = [1, 1.1892, 1.4983, 1.3348];
      const frequency = baseFrequency * ratios[chordIndex];
      const attack = Math.min(1, beatPhase * 12);
      const envelope = attack * (0.68 + 0.32 * Math.cos(beatPhase * Math.PI));
      const vibrato = 1 + 0.0025 * Math.sin(2 * Math.PI * 5.2 * time);
      sample =
        (Math.sin(2 * Math.PI * frequency * vibrato * time) * 0.72 +
          Math.sin(2 * Math.PI * frequency * 2 * time) *
            (0.08 + controls.harmonyComplexity * 0.015) +
          Math.sin(2 * Math.PI * frequency * 0.5 * time) * 0.08) *
        envelope *
        (beatPhase < 0.2 + sectionDensity * 0.8 ? 1 : 0.22);
    }

    const pan = ((index % 5) - 2) * 0.12;
    output[frame * 2] = sample * gain * (1 - Math.max(0, pan));
    output[frame * 2 + 1] = sample * gain * (1 + Math.min(0, pan));
  }
  return output;
}

function mixStems(stems: Float32Array[]): Float32Array {
  const mixed = new Float32Array(SAMPLE_RATE * DURATION_SECONDS * CHANNELS);
  for (const stem of stems) {
    for (let i = 0; i < mixed.length; i += 1) {
      mixed[i] += stem[i];
    }
  }
  let peak = 0;
  for (const value of mixed) peak = Math.max(peak, Math.abs(value));
  const trim = peak > 0.86 ? 0.86 / peak : 1;
  for (let i = 0; i < mixed.length; i += 1) mixed[i] *= trim;
  return mixed;
}

function masterAudio(source: Float32Array, profile: string): Float32Array {
  const mastered = new Float32Array(source.length);
  const drive = profile === "LOUD" ? 2.2 : profile === "DYNAMIC" ? 1.2 : 1.65;
  const target = profile === "CLASSICAL" ? 0.72 : profile === "LOUD" ? 0.96 : 0.89;
  let peak = 0;
  for (let i = 0; i < source.length; i += 1) {
    mastered[i] = Math.tanh(source[i] * drive);
    peak = Math.max(peak, Math.abs(mastered[i]));
  }
  const gain = peak > 0 ? target / peak : 1;
  for (let i = 0; i < mastered.length; i += 1) {
    mastered[i] = clamp(mastered[i] * gain, -0.99, 0.99);
  }
  return mastered;
}

export function encodeWav(samples: Float32Array): Buffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28);
  buffer.writeUInt16LE(CHANNELS * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const value = clamp(samples[i]);
    buffer.writeInt16LE(
      value < 0 ? Math.round(value * 32768) : Math.round(value * 32767),
      44 + i * 2,
    );
  }
  return buffer;
}

/** Bounded deterministic DSP used by audition revisions; never mutates source buffers. */
export function applyMixMasterControls(
  tracks: RenderedTrack[],
  controls: MixMasterControls,
): { tracks: RenderedTrack[]; mixed: Float32Array; mastered: Float32Array; integratedLufs: number; truePeakDbtp: number } {
  const processed = tracks.map((track) => {
    const control = controls.tracks[track.trackModel.id];
    if (!control) return track;
    const samples = new Float32Array(track.samples.length);
    const gain = 10 ** (control.levelDb / 20);
    const panLeft = Math.cos((control.pan + 1) * Math.PI / 4);
    const panRight = Math.sin((control.pan + 1) * Math.PI / 4);
    const send = 10 ** (control.sendDb / 20);
    // The one-pole DC/high-pass approximation and soft saturation are stable,
    // bounded, and ensure each persisted control changes audible PCM.
    const hp = Math.exp(-2 * Math.PI * control.processing.highPassHz / SAMPLE_RATE);
    let previousL = 0; let previousR = 0; let filteredL = 0; let filteredR = 0;
    const busGain = control.bus === "FX" ? .8 : control.bus === "VOCALS" ? 1.04 :
      control.bus === "DRUMS" ? .96 : control.bus === "MUSIC" ? 1.02 : 1;
    for (let i = 0; i < samples.length; i += 2) {
      const left = track.samples[i]; const right = track.samples[i + 1];
      filteredL = hp * (filteredL + left - previousL); previousL = left;
      filteredR = hp * (filteredR + right - previousR); previousR = right;
      const ratio = control.processing.compressorRatio;
      const compress = (value: number) => Math.tanh(value * (1 + (ratio - 1) * .12));
      const saturate = (value: number) => Math.tanh(value * (1 + control.processing.saturation * 4));
      const wetL = filteredL * send * .16; const wetR = filteredR * send * .16;
      samples[i] = saturate(compress((filteredL * .8 + left * .2) * gain * panLeft * busGain + wetR));
      samples[i + 1] = saturate(compress((filteredR * .8 + right * .2) * gain * panRight * busGain + wetL));
    }
    return { ...track, samples };
  });
  const mixed = new MixGraph().mix(processed, { production: { stereoWidth: controls.master.processing.stereoWidth } } as StyleSpec, Math.ceil((processed[0]?.samples.length ?? 0) / CHANNELS));
  const ceiling = 10 ** (controls.master.truePeakDbtp / 20);
  const targetRms = 10 ** (controls.master.targetLufs / 20);
  let sum = 0;
  for (const value of mixed) sum += value * value;
  const rms = Math.sqrt(sum / Math.max(1, mixed.length));
  const targetGain = Math.min(8, targetRms / Math.max(rms, 1e-9));
  const mastered = new Float32Array(mixed.length);
  let peak = 0; let masteredSum = 0;
  for (let i = 0; i < mixed.length; i += 1) {
    const value = mixed[i] * targetGain;
    const output = controls.master.processing.limiter ? Math.max(-ceiling, Math.min(ceiling, value)) : Math.tanh(value);
    mastered[i] = output; peak = Math.max(peak, Math.abs(output)); masteredSum += output * output;
  }
  return {
    tracks: processed, mixed, mastered,
    integratedLufs: 20 * Math.log10(Math.sqrt(masteredSum / Math.max(1, mastered.length)) + 1e-12),
    truePeakDbtp: 20 * Math.log10(peak + 1e-12),
  };
}

function vlq(value: number): number[] {
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

function midiChunk(type: string, data: number[]): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, Buffer.from(data)]);
}

function createMidi(
  tracks: ExportTrack[],
  bpm: number,
  meter: string,
  sections: Array<{ name: string; energy: number; density: number; tracks: string[] }>,
): Buffer {
  const ticks = 480;
  const micros = Math.round(60_000_000 / Math.max(40, bpm || 92));
  const [rawNumerator, rawDenominator] = meter.split("/").map(Number);
  const numerator = Number.isFinite(rawNumerator) ? rawNumerator : 4;
  const denominator = Number.isFinite(rawDenominator) ? rawDenominator : 4;
  const denominatorPower = Math.max(0, Math.round(Math.log2(denominator)));
  const tempoTrack = [
    0x00, 0xff, 0x51, 0x03,
    (micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff,
    0x00, 0xff, 0x58, 0x04, numerator, denominatorPower, 0x18, 0x08,
    0x00, 0xff, 0x2f, 0x00,
  ];
  const progression = [50, 53, 57, 48];
  const chunks = [midiChunk("MTrk", tempoTrack)];

  tracks.forEach((track, trackIndex) => {
    const channel = trackIndex === 9 ? 9 : trackIndex % 16;
    const events: number[] = [
      0x00,
      0xc0 | channel,
      trackIndex === 0 ? 40 : (trackIndex * 8) % 96,
    ];
    let pendingDelta = 0;
    for (let beat = 0; beat < 32; beat += 1) {
      const sectionIndex = sections.length
        ? Math.min(sections.length - 1, Math.floor((beat / 32) * sections.length))
        : 0;
      const section = sections[sectionIndex];
      const identity = `${track.role} ${track.name}`.toLowerCase();
      const active =
        identity.includes("vocal") ||
        !section ||
        section.tracks.length === 0 ||
        section.tracks.some((part) => {
          const token = part.toLowerCase();
          return identity.includes(token) || token.includes(track.role.toLowerCase());
        });
      if (!active) {
        pendingDelta += ticks;
        continue;
      }
      const root = progression[(Math.floor(beat / 8) + sectionIndex) % progression.length];
      const note = root + (trackIndex % 4) * 7 + (beat % 4 === 3 ? 2 : 0);
      const velocity = Math.round(56 + (section?.energy ?? 0.6) * 52);
      events.push(...vlq(pendingDelta), 0x90 | channel, note, velocity);
      events.push(...vlq(ticks), 0x80 | channel, note, 48);
      pendingDelta = 0;
    }
    events.push(...vlq(pendingDelta), 0xff, 0x2f, 0x00);
    chunks.push(midiChunk("MTrk", events));
  });

  const header = Buffer.alloc(14);
  header.write("MThd", 0);
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(1, 8);
  header.writeUInt16BE(chunks.length, 10);
  header.writeUInt16BE(ticks, 12);
  return Buffer.concat([header, ...chunks]);
}

export function createPerformanceMidi(
  trackModels: TrackModel[],
  bpm: number,
  meter: string,
  durationSeconds: number,
): Buffer {
  const ticks = 480;
  const micros = Math.round(60_000_000 / Math.max(40, bpm || 92));
  const [rawNumerator, rawDenominator] = meter.split("/").map(Number);
  const numerator = Number.isFinite(rawNumerator) ? rawNumerator : 4;
  const denominator = Number.isFinite(rawDenominator) ? rawDenominator : 4;
  const denominatorPower = Math.max(0, Math.round(Math.log2(denominator)));
  const tempoTrack = [
    0x00, 0xff, 0x51, 0x03,
    (micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff,
    0x00, 0xff, 0x58, 0x04, numerator, denominatorPower, 0x18, 0x08,
    0x00, 0xff, 0x2f, 0x00,
  ];
  const chunks = [midiChunk("MTrk", tempoTrack)];
  const ticksPerSecond = ticks * Math.max(40, bpm || 92) / 60;
  const endTick = Math.max(1, Math.ceil(durationSeconds * ticksPerSecond));
  tempoTrack.splice(
    tempoTrack.length - 4,
    4,
    ...vlq(endTick),
    0xff,
    0x2f,
    0x00,
  );

  trackModels.forEach((track, trackIndex) => {
    const channel = track.instrumentDefinition.family === "drums" ? 9 : trackIndex % 16;
    const events: Array<{ tick: number; order: number; bytes: number[] }> = [];
    track.cc.forEach((event) => {
      events.push({
        tick: Math.max(0, Math.round(event.time * ticksPerSecond)),
        order: 0,
        bytes: [0xb0 | channel, midiByte(event.controller), midiByte(event.value)],
      });
    });
    track.articulations.forEach((event) => {
      if (event.keyswitch === undefined) return;
      const tick = Math.max(0, Math.round(event.time * ticksPerSecond));
      events.push({ tick, order: 0, bytes: [0x90 | channel, midiByte(event.keyswitch), 64] });
      events.push({ tick: tick + 12, order: 1, bytes: [0x80 | channel, midiByte(event.keyswitch), 32] });
    });
    track.automation.forEach((event) => {
      const tick = Math.max(0, Math.round(event.time * ticksPerSecond));
      if (event.parameter === "pitch_bend") {
        const bend = Math.max(0, Math.min(16_383, Math.round(8_192 + event.value * 8_191)));
        events.push({ tick, order: 0, bytes: [0xe0 | channel, bend & 0x7f, (bend >> 7) & 0x7f] });
      } else if (event.parameter === "aftertouch") {
        events.push({ tick, order: 0, bytes: [0xd0 | channel, midiByte(event.value * 127)] });
      }
    });
    track.notes.forEach((note) => {
      const start = Math.max(0, Math.round(note.start * ticksPerSecond));
      const end = Math.max(start + 1, Math.round((note.start + note.duration) * ticksPerSecond));
      events.push({ tick: start, order: 2, bytes: [0x90 | channel, midiByte(note.pitch), midiByte(note.velocity)] });
      events.push({ tick: end, order: 1, bytes: [0x80 | channel, midiByte(note.pitch), 48] });
    });
    events.sort((left, right) => left.tick - right.tick || left.order - right.order);
    const bytes: number[] = [0x00, 0xc0 | channel, midiByte(trackIndex === 0 ? 0 : (trackIndex * 8) % 96)];
    let previousTick = 0;
    for (const event of events) {
      bytes.push(...vlq(Math.max(0, event.tick - previousTick)), ...event.bytes);
      previousTick = event.tick;
    }
    bytes.push(...vlq(Math.max(0, endTick - previousTick)), 0xff, 0x2f, 0x00);
    chunks.push(midiChunk("MTrk", bytes));
  });

  const header = Buffer.alloc(14);
  header.write("MThd", 0);
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(1, 8);
  header.writeUInt16BE(chunks.length, 10);
  header.writeUInt16BE(ticks, 12);
  return Buffer.concat([header, ...chunks]);
}

function midiByte(value: number): number {
  return Math.max(0, Math.min(127, Math.round(value)));
}

let crcTable: Uint32Array | undefined;
function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(
  files: Array<{ name: string; data: Buffer }>,
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of files) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export async function renderArrangementExport(input: {
  projectName: string;
  bpm: number;
  key: string;
  meter: string;
  arrangementName: string;
  arrangementVersion: number;
  masterProfile: string;
  energy: number;
  density: number;
  harmonyComplexity: number;
  sections: Array<{ name: string; energy: number; density: number; tracks: string[] }>;
  tracks: ExportTrack[];
  songModel: SongModelData;
  plan: ArrangementPlan;
  trackModels?: TrackModel[];
  styleSpec: StyleSpec;
  seed?: number;
  generationProvider: string;
  generationModelVersion?: string;
  generationCheckpointSha256?: string;
  candidateId?: string;
  providerRequestId?: string;
  parentIds: string[];
  planArtifactId?: string;
  planParentIds?: string[];
  trackModelArtifactIds?: Record<string, string>;
  durationSeconds?: number;
  includeStems: boolean;
  includeMidi: boolean;
  mixMasterControls?: MixMasterControls;
}): Promise<GeneratedExportFile[]> {
  const [meterNumerator, meterDenominator] = input.meter.split("/").map(Number);
  const beatsPerBar = Number.isFinite(meterNumerator) && meterNumerator > 0
    ? meterNumerator
    : 4;
  const beatUnit = Number.isFinite(meterDenominator) && meterDenominator > 0
    ? meterDenominator
    : 4;
  const planEndSeconds = Math.max(
    0,
    ...input.plan.sections.map((section) =>
      section.endBar * beatsPerBar * (4 / beatUnit) * 60 / Math.max(40, input.bpm || 92)),
  );
  const authoritativeDuration = Math.max(
    input.durationSeconds ?? 0,
    input.songModel.audio.durationSeconds,
    planEndSeconds,
  );
  const hasSolo = input.tracks.some((track) => track.solo && !track.muted);
  const activeTracks = input.tracks.filter((track) =>
    !track.muted && (!hasSolo || track.solo));
  const activeTrackIds = new Set(activeTracks.map((track) => track.id));
  const selectedTrackModels = input.trackModels?.filter((track) => activeTrackIds.has(track.id));
  if (input.trackModels !== undefined && activeTracks.length > 0 && !selectedTrackModels?.length) {
    throw new Error("Saved TrackModels do not match the active project tracks");
  }
  let pipeline = renderMusicPipeline({
    songModel: input.songModel,
    plan: input.plan,
    style: input.styleSpec,
    tracks: activeTracks.map((track) => ({
      id: track.id,
      name: track.name,
      role: track.role,
      instrument: track.name,
      volume: track.volume,
    })),
    trackModels: selectedTrackModels,
    seed: input.seed,
    masterProfile: input.masterProfile,
    durationSeconds: authoritativeDuration,
    sampleRate: SAMPLE_RATE,
  });
  const playabilityErrors = validateCanonicalTrackModels(
    pipeline.tracks.map((track) => track.trackModel),
    activeTracks.map((track) => track.id),
  );
  if (playabilityErrors.length) {
    throw new Error(`Export refused unplayable TrackModels: ${playabilityErrors.join("; ")}`);
  }
  const sfizzRenderer = new SfzRenderer();
  const pedalboardRenderer = new PedalboardRenderer();
  const nativeRendererConfigured = sfizzRenderer.isConfigured() || pedalboardRenderer.isConfigured();
  const remoteTracks: RenderedTrack[] = await Promise.all(pipeline.tracks.map(async (rendered): Promise<RenderedTrack> => {
      const fallback = (reason: string): RenderedTrack => ({
        ...rendered,
        rendererStatus: "preview-only",
        fallbackReason: reason,
      });
      const capability = getInstrumentPerformanceCapability(rendered.trackModel.instrumentDefinition);
      const usePedalboard = pedalboardRenderer.isConfigured() &&
        capability.nativeRenderers.includes("PEDALBOARD_VST3");
      const useSfizz = !usePedalboard &&
        sfizzRenderer.isConfigured() &&
        capability.nativeRenderers.includes("SFIZZ_VSCO2_CE");
      if (!usePedalboard && !useSfizz) {
        return fallback(
          nativeRendererConfigured
            ? "The configured native renderer does not support this instrument family."
            : "No healthy licensed native renderer was configured for this export.",
        );
      }
      if (
        !input.parentIds.length &&
        !input.trackModelArtifactIds?.[rendered.trackModel.id]
      ) {
        return fallback("Render lineage was incomplete, so licensed native rendering was skipped.");
      }
      const renderer = usePedalboard ? pedalboardRenderer : sfizzRenderer;
      let samples: Float32Array;
      let rendererAttestation: RenderedTrack["rendererAttestation"];
      try {
        const native = await renderer.renderAttested(
          rendered.trackModel,
          SAMPLE_RATE,
          pipeline.durationSeconds,
        );
        samples = native.samples;
        rendererAttestation = native.attestation;
      } catch {
        // A configured endpoint is not proof of a licensed, compatible asset.
        // Keep the already-rendered deterministic stem and do not attribute it
        // to a native provider that failed attestation or playback validation.
        return fallback("The licensed native renderer was unavailable or failed attestation.");
      }
      const expectedLength = Math.ceil(SAMPLE_RATE * pipeline.durationSeconds) * CHANNELS;
      if (validateNativeRenderSamples(samples, expectedLength).length) {
        return fallback("The licensed native renderer returned audio that failed validation.");
      }
      const volume = activeTracks.find((track) => track.id === rendered.trackModel.id)?.volume ?? 0;
      const gain = 10 ** (volume / 20);
      if (gain !== 1) {
        for (let index = 0; index < samples.length; index += 1) samples[index] *= gain;
      }
      return {
        ...rendered,
        samples,
        renderer: renderer.providerId,
        rendererStatus: "licensed-native",
        rendererAttestation,
      };
    }));
  const controlled = input.mixMasterControls
    ? applyMixMasterControls(remoteTracks, input.mixMasterControls)
    : null;
  const mix = controlled?.mixed ?? new MixGraph().mix(remoteTracks, input.styleSpec, Math.ceil(SAMPLE_RATE * pipeline.durationSeconds));
  const mastered = controlled
    ? { premaster: mix, master: controlled.mastered }
    : new MasterEngine().process(mix, input.masterProfile);
  const quality = new QualityEngine().assess(
    remoteTracks.map((track) => track.trackModel),
    mix,
    input.plan,
    {
      lineageComplete: pipeline.quality.lineageComplete,
      renderArtifactIds: pipeline.quality.renderArtifactIds,
      evaluatedAt: pipeline.quality.evaluatedAt,
      bpm: input.bpm,
      meter: input.meter,
    },
  );
  const nativeTracks = remoteTracks.filter((track) =>
    track.rendererStatus === "licensed-native");
  const performedMaterialDigests = remoteTracks
    .map((track) => performedMaterialSha256(track.trackModel));
  const aggregatePerformedMaterialSha256 = createHash("sha256")
    .update(JSON.stringify(performedMaterialDigests))
    .digest("hex");
  const performanceMidi = createPerformanceMidi(
    remoteTracks.map((track) => track.trackModel),
    input.bpm,
    input.meter,
    pipeline.durationSeconds,
  );
  const midiOutputSha256 = createHash("sha256").update(performanceMidi).digest("hex");
  const midiAgreementSha256 = createHash("sha256").update(JSON.stringify({
    performedMaterialSha256: aggregatePerformedMaterialSha256,
    midiOutputSha256,
    bpm: input.bpm,
    meter: input.meter,
    durationSeconds: pipeline.durationSeconds,
  })).digest("hex");
  const readinessReasons = [
    ...(remoteTracks.length === 0 ? ["No active performed tracks were rendered."] : []),
    ...(nativeTracks.length !== remoteTracks.length
      ? ["Every active track must have an attested native instrument render."] : []),
    ...(!quality.lineageComplete ? ["Render lineage is incomplete."] : []),
    ...(quality.checks.silence < 0.005 ? ["Rendered audio is silent or effectively empty."] : []),
    ...(quality.checks.clipping < 0.999 ? ["Rendered audio contains excessive clipping."] : []),
    ...(quality.checks.notePlayability < 0.98 ? ["Performed notes failed playability validation."] : []),
    ...(quality.checks.timing < 0.8 ? ["Performed notes are not aligned to the canonical timeline."] : []),
    ...(quality.checks.sectionCoverage < 1 ? ["Performed material does not cover every active arrangement section."] : []),
    ...(input.songModel.tempoMap.length > 1 || input.songModel.meterMap.length > 1
      ? ["Production rendering currently requires one canonical tempo and meter segment; mapped changes remain preview-only."] : []),
    ...(input.songModel.contractVersion === "2.0" &&
      input.songModel.vocalIntelligence?.phrases.status === "detected" &&
      input.songModel.vocalIntelligence.phrases.events.some((phrase) =>
        !phrase.coordinates ||
        !Number.isFinite(phrase.coordinates.start.tick) ||
        !Number.isFinite(phrase.coordinates.end.tick) ||
        phrase.coordinates.end.tick <= phrase.coordinates.start.tick)
      ? ["Detected phrases require complete canonical coordinates for production rendering."] : []),
    ...remoteTracks.flatMap((track) =>
      track.rendererAttestation?.performedMaterialSha256 === performedMaterialSha256(track.trackModel)
        ? []
        : [`${track.trackModel.id} native render does not attest its performed material.`]),
    ...remoteTracks.flatMap((track) => {
      const evidence = track.trackModel.performanceEvidence;
      if (!evidence) return [`${track.trackModel.id} is missing deterministic performance evidence.`];
      const failures: string[] = [];
      if (evidence.canonicalTimelineSha256 !== canonicalPerformanceTimelineSha256(input.songModel)) {
        failures.push(`${track.trackModel.id} performance evidence does not match the canonical timeline.`);
      }
      if (JSON.stringify(evidence.phraseIds) !==
        JSON.stringify(canonicalPerformancePhraseIds(input.songModel))) {
        failures.push(`${track.trackModel.id} performance evidence does not match canonical phrases.`);
      }
      const expectedSectionRanges = (track.trackModel.appliedDirectives ?? []).map((item) => ({
        section: item.section,
        startBar: item.startBar,
        endBar: item.endBar,
        start: item.start,
        end: item.end,
      }));
      if (JSON.stringify(evidence.sectionRanges) !== JSON.stringify(expectedSectionRanges)) {
        failures.push(`${track.trackModel.id} performance evidence does not match canonical section ranges.`);
      }
      if (evidence.performedMaterialSha256 !== performedMaterialSha256(track.trackModel)) {
        failures.push(`${track.trackModel.id} performance evidence is stale for the performed material.`);
      }
      if (!evidence.playability.valid) {
        failures.push(`${track.trackModel.id} performance evidence reports playability violations.`);
      }
      return failures;
    }),
  ];
  const nativeQualityPassed =
    readinessReasons.length === 0;
  quality.productionReadiness = {
    ready: nativeQualityPassed,
    status: nativeQualityPassed ? "production-ready" : "preview-only",
    reasons: readinessReasons,
    performedMaterialSha256: aggregatePerformedMaterialSha256,
    midiAgreementSha256,
  };
  if (nativeQualityPassed) {
    pipeline = {
      ...pipeline,
      tracks: remoteTracks,
      mix,
      premaster: mastered.premaster,
      master: mastered.master,
      quality,
      provenance: [
        ...pipeline.provenance.filter((item) =>
          item.model !== "LOCAL_EXPRESSIVE_SYNTH"),
        ...nativeTracks.map((track) => ({
          model: track.renderer,
          version: "attested-native-asset",
          parameters: {
            sampleRate: SAMPLE_RATE,
            durationSeconds: pipeline.durationSeconds,
            trackModelId: track.trackModel.id,
            assetId: track.rendererAttestation!.assetId,
            assetIdentity: track.rendererAttestation!.assetIdentity,
            assetSha256: track.rendererAttestation!.assetSha256,
            licenseOwner: track.rendererAttestation!.licenseOwner,
            licenseReference: track.rendererAttestation!.licenseReference,
            rendererIdentity: track.rendererAttestation!.rendererIdentity,
            runtimeIdentity: track.rendererAttestation!.runtimeIdentity,
            rendererSha256: track.rendererAttestation!.rendererSha256,
            smokeOutputSha256: track.rendererAttestation!.smokeOutputSha256,
            trackModelSha256: track.rendererAttestation!.trackModelSha256,
            rendererOutputSha256: track.rendererAttestation!.rendererOutputSha256,
            performedMaterialSha256: track.rendererAttestation!.performedMaterialSha256,
          },
          parentIds: input.trackModelArtifactIds?.[track.trackModel.id]
            ? [input.trackModelArtifactIds[track.trackModel.id]]
            : input.parentIds,
          createdBy: "renderer-adapter",
        })),
      ],
    };
  } else {
    pipeline = {
      ...pipeline,
      tracks: pipeline.tracks.map((track) => {
        const attemptedTrack = remoteTracks.find((candidate) =>
          candidate.trackModel.id === track.trackModel.id);
        return {
          ...track,
          rendererStatus: "preview-only" as const,
          fallbackReason: nativeTracks.length
            ? `Production rendering was blocked: ${readinessReasons.join(" ")}`
            : attemptedTrack?.fallbackReason ??
              "No attested licensed native renderer produced this stem.",
        };
      }),
    };
  }
  const fileProvenance = (
    model: string,
    version: string,
    parameters: Record<string, number | string | boolean>,
    parentIds = input.parentIds,
  ): ArtifactProvenance => ({
    model,
    version,
    parameters: {
      ...parameters,
      generationProvider: input.generationProvider,
      generationModelVersion: input.generationModelVersion ?? "unknown",
      ...(input.generationCheckpointSha256
        ? { generationCheckpointSha256: input.generationCheckpointSha256 }
        : {}),
      seed: input.seed ?? 0,
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    },
    parentIds,
    createdBy: "export-engine",
  });
  const trackArtifactParents = Object.values(input.trackModelArtifactIds ?? {});
  const planParents = input.planParentIds ?? input.plan.provenance.parentIds;
  const trackModelParents = input.planArtifactId ? [input.planArtifactId] : planParents;
  const musicalModelStages = new Set([
    "HARMONY_ENGINE",
    "COMPOSITION_ENGINE",
    "MODULATION_ENGINE",
    "VOICE_LEADING_ENGINE",
    "PERFORMANCE_ENGINE",
  ]);
  const files: GeneratedExportFile[] = [];

  if (input.includeStems) {
    for (const [index, stem] of pipeline.tracks.entries()) {
      const track = activeTracks.find((candidate) => candidate.id === stem.trackModel.id);
      const attestation = stem.rendererAttestation;
      const stemData = encodeWav(stem.samples);
      const stemOutputSha256 = createHash("sha256").update(stemData).digest("hex");
      files.push({
        name: `stems/${String(index + 1).padStart(2, "0")}_${safeName(activeTracks[index]?.name || stem.trackModel.instrument)}.wav`,
        type: "STEM",
        format: "WAV",
        contentType: "audio/wav",
        data: stemData,
        provenance: fileProvenance(stem.renderer, "1.0.0", {
          instrument: stem.trackModel.instrument,
          trackModelVersion: stem.trackModel.version,
          sampleRate: SAMPLE_RATE,
          ...(stem.rendererAttestation ? {
            nativeModelVersion: stem.rendererAttestation.modelVersion,
            assetId: stem.rendererAttestation.assetId,
            assetIdentity: stem.rendererAttestation.assetIdentity,
            assetSha256: stem.rendererAttestation.assetSha256,
            licenseOwner: stem.rendererAttestation.licenseOwner,
            licenseReference: stem.rendererAttestation.licenseReference,
            rendererIdentity: stem.rendererAttestation.rendererIdentity,
            rendererSha256: stem.rendererAttestation.rendererSha256,
            smokeOutputSha256: stem.rendererAttestation.smokeOutputSha256,
            trackModelSha256: stem.rendererAttestation.trackModelSha256,
            rendererOutputSha256: stem.rendererAttestation.rendererOutputSha256,
            stemOutputSha256,
          } : {}),
        }, input.trackModelArtifactIds?.[stem.trackModel.id]
          ? [input.trackModelArtifactIds[stem.trackModel.id]]
          : input.parentIds),
        rendererEvidence: {
          trackName: track?.name ?? stem.trackModel.instrument,
          role: track?.role ?? stem.trackModel.role,
          rendererStatus: stem.rendererStatus ?? "preview-only",
          rendererProvider: attestation?.provider ?? stem.renderer,
          performedMaterialSha256: performedMaterialSha256(stem.trackModel),
          midiAgreementSha256,
          productionReady: nativeQualityPassed,
          ...(attestation ? {
            rendererProduct: attestation.assetIdentity,
            nativeHost: attestation.rendererIdentity,
            runtimeIdentity: attestation.runtimeIdentity,
            licenseOwner: attestation.licenseOwner,
            licenseReference: attestation.licenseReference,
            assetSha256: attestation.assetSha256,
            rendererSha256: attestation.rendererSha256,
            smokeOutputSha256: attestation.smokeOutputSha256,
            trackModelSha256: attestation.trackModelSha256,
            rendererOutputSha256: attestation.rendererOutputSha256,
            stemOutputSha256,
          } : {}),
          ...(!attestation ? { stemOutputSha256 } : {}),
          ...(stem.fallbackReason ? { fallbackReason: stem.fallbackReason } : {}),
        },
      });
    }
  }
  files.push(
    {
      name: "mix/full_mix.wav",
      type: exportAudioRole("mix"),
      format: "WAV",
      contentType: "audio/wav",
      data: encodeWav(mix),
      provenance: fileProvenance("MIX_GRAPH", "1.0.0", {
        trackCount: pipeline.tracks.length,
        arrangementAware: true,
      }),
    },
    {
      name: "mix/premaster.wav",
      type: exportAudioRole("premaster"),
      format: "WAV",
      contentType: "audio/wav",
      data: encodeWav(mastered.premaster),
      provenance: fileProvenance("MASTER_ENGINE", "1.0.0", {
        stage: "premaster",
        profile: "DYNAMIC",
      }),
    },
    {
      name: "mix/master.wav",
      type: exportAudioRole("master"),
      format: "WAV",
      contentType: "audio/wav",
      data: encodeWav(mastered.master),
      provenance: fileProvenance("MASTER_ENGINE", "1.0.0", {
        stage: "master",
        profile: input.masterProfile,
      }),
    },
  );
  if (input.includeMidi) {
    files.push({
      name: "midi/full_arrangement.mid",
      type: "MIDI",
      format: "MIDI",
      contentType: "audio/midi",
      data: performanceMidi,
      provenance: fileProvenance("PERFORMANCE_ENGINE", "1.0.0", {
        expressiveControls: true,
        humanized: true,
        seed: input.seed ?? 0,
        performedMaterialSha256: aggregatePerformedMaterialSha256,
        midiOutputSha256,
        midiAgreementSha256,
      }, Object.values(input.trackModelArtifactIds ?? {}).length
        ? Object.values(input.trackModelArtifactIds ?? {})
        : input.parentIds),
    });
  }
  const metadata = {
    project: input.projectName,
    arrangement: input.arrangementName,
    version: input.arrangementVersion,
    tempoMap: [{ bar: 1, bpm: input.bpm }],
    meterMap: [{ bar: 1, meter: input.meter }],
    keyMap: [{ bar: 1, key: input.key }],
    sampleRate: SAMPLE_RATE,
    bitDepth: 16,
    durationSeconds: pipeline.durationSeconds,
    masterProfile: input.masterProfile,
    creativeControls: {
      energy: input.energy,
      density: input.density,
      harmonyComplexity: input.harmonyComplexity,
    },
    sections: input.sections,
    tracks: activeTracks.map(({ id, name, role }) => ({ id, name, role })),
    trackModels: pipeline.tracks.map(({ trackModel, renderer, rendererStatus, fallbackReason, rendererAttestation }) => ({
      ...trackModel,
      provenance: {
        ...trackModel.provenance,
        parentIds: trackModelParents,
      },
      renderer,
      rendererStatus: rendererStatus ?? "preview-only",
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(rendererAttestation ? {
        rendererAttestation,
      } : {}),
    })),
    styleSpec: input.styleSpec,
    arrangementPlan: {
      ...input.plan,
      provenance: {
        ...input.plan.provenance,
        parentIds: planParents,
      },
    },
    quality: pipeline.quality,
    productionReadiness: pipeline.quality.productionReadiness,
    provenance: pipeline.provenance.map((item) => {
      const parentIds = item.model === "ARRANGEMENT_DIRECTOR"
        ? planParents
        : musicalModelStages.has(item.model)
          ? trackModelParents
          : trackArtifactParents.length
            ? trackArtifactParents
            : input.parentIds;
      return {
        ...item,
        parameters: {
          ...item.parameters,
          upstreamParentRefs: item.parentIds.join(","),
        },
        parentIds,
      };
    }),
    generation: {
      provider: input.generationProvider,
      modelVersion: input.generationModelVersion ?? null,
      ...(input.generationCheckpointSha256
        ? { checkpointSha256: input.generationCheckpointSha256 }
        : {}),
      candidateId: input.candidateId ?? null,
      providerRequestId: input.providerRequestId ?? null,
      seed: input.seed ?? null,
      parentArtifactIds: input.parentIds,
      planArtifactId: input.planArtifactId ?? null,
      trackModelArtifactIds: input.trackModelArtifactIds ?? {},
    },
    generationProvider: input.generationProvider,
  };
  files.push({
    name: "project/manifest.json",
    type: "METADATA",
    format: "JSON",
    contentType: "application/json",
    data: Buffer.from(JSON.stringify(metadata, null, 2)),
    provenance: fileProvenance("EXPORT_ENGINE", "2.0.0", {
      qualityScore: pipeline.quality.score,
      arrangementVersion: input.arrangementVersion,
    }),
  });
  return files;
}
