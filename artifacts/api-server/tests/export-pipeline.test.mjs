import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundlePath = `/tmp/music-export-pipeline-test-${process.pid}.mjs`;
await build({
  entryPoints: [new URL("../src/lib/export-pipeline.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
});
const {
  createExportBundle,
  createTrackPerformance,
  tickToSeconds,
} = await import(pathToFileURL(bundlePath).href);
after(() => unlink(bundlePath).catch(() => undefined));

function openStoredZip(zip) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0, "test expects stored ZIP entries");
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zip.toString("utf8", nameStart, nameStart + nameLength);
    entries.set(name, zip.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

function readVariableLength(buffer, initialOffset) {
  let offset = initialOffset;
  let value = 0;
  let byte;
  do {
    byte = buffer[offset];
    offset += 1;
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return { value, offset };
}

function lastMidiTick(midi) {
  assert.equal(midi.toString("ascii", 0, 4), "MThd");
  const trackCount = midi.readUInt16BE(10);
  let offset = 8 + midi.readUInt32BE(4);
  let finalTick = 0;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    assert.equal(midi.toString("ascii", offset, offset + 4), "MTrk");
    const end = offset + 8 + midi.readUInt32BE(offset + 4);
    offset += 8;
    let tick = 0;
    while (offset < end) {
      const delta = readVariableLength(midi, offset);
      tick += delta.value;
      offset = delta.offset;
      const status = midi[offset];
      offset += 1;
      assert.ok(status >= 0x80, "running MIDI status is not emitted by this writer");
      if (status === 0xff) {
        offset += 1;
        const length = readVariableLength(midi, offset);
        offset = length.offset + length.value;
      } else if (status === 0xf0 || status === 0xf7) {
        const length = readVariableLength(midi, offset);
        offset = length.offset + length.value;
      } else {
        const message = status & 0xf0;
        offset += message === 0xc0 || message === 0xd0 ? 1 : 2;
      }
      finalTick = Math.max(finalTick, tick);
    }
  }
  return finalTick;
}

function wavDuration(wav) {
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  const dataSize = wav.readUInt32LE(40);
  return dataSize / (sampleRate * channels * (bits / 8));
}

function peakAfter(wav, seconds) {
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const start = 44 + Math.floor(seconds * sampleRate) * channels * 2;
  let peak = 0;
  for (let offset = start; offset + 1 < wav.length; offset += 2) {
    peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
  }
  return peak;
}

function peakBefore(wav, seconds) {
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const end = Math.min(wav.length, 44 + Math.floor(seconds * sampleRate) * channels * 2);
  let peak = 0;
  for (let offset = 44; offset + 1 < end; offset += 2) {
    peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
  }
  return peak;
}

test("export ZIP keeps MIDI and WAV timelines aligned with section activation", () => {
  const project = {
    id: "timeline-project",
    name: "Timeline Test",
    duration: "0:01",
    bpm: 60,
    meter: "4/4",
    key: "C major",
    sourceType: "PROMPT",
    sections: [
      { name: "First", startBar: 1, endBar: 2, energy: 0.5 },
      { name: "Second", startBar: 3, endBar: 4, energy: 0.8 },
      { name: "Silent Outro", startBar: 5, endBar: 6, energy: 0.2 },
    ],
    energy: [0.5, 0.8],
    providers: [],
  };
  const arrangement = {
    id: "timeline-arrangement",
    projectId: project.id,
    name: "Alternating parts",
    style: "Test",
    mode: "STUDIO",
    version: 1,
    harmonyComplexity: 5,
    energy: 0.7,
    density: 0.6,
    orchestraSize: 0.5,
    rhythmIntensity: 0.5,
    sections: [
      { name: "First", energy: 0.5, density: 0.5, tracks: ["Bass"] },
      { name: "Second", energy: 0.8, density: 0.8, tracks: ["Piano"] },
      { name: "Silent Outro", energy: 0.2, density: 0.1, tracks: ["Drums"] },
    ],
  };
  const emptyPerformance = {
    tempoMap: [],
    meterMap: [],
    notes: [],
    expression: [],
    articulations: [],
  };
  const bass = {
    id: "bass",
    name: "Electric Bass",
    role: "bass",
    kind: "midi",
    volume: 0,
    muted: false,
    solo: false,
    performance: emptyPerformance,
  };
  const piano = {
    id: "piano",
    name: "Grand Piano",
    role: "harmony",
    kind: "midi",
    volume: 0,
    muted: false,
    solo: false,
    performance: emptyPerformance,
  };
  const sectionTwoTick = 2 * 4 * 480;
  bass.performance = createTrackPerformance(bass, project, arrangement, 0);
  piano.performance = createTrackPerformance(piano, project, arrangement, 1);

  assert.ok(bass.performance.notes.length > 0);
  assert.ok(bass.performance.notes.every((note) => note.startTick < sectionTwoTick));
  assert.ok(piano.performance.notes.length > 0);
  assert.ok(piano.performance.notes.every((note) => note.startTick >= sectionTwoTick));

  const muted = { ...bass, muted: true, performance: emptyPerformance };
  assert.equal(createTrackPerformance(muted, project, arrangement, 0).notes.length, 0);
  assert.equal(createTrackPerformance(piano, project, arrangement, 1, true).notes.length, 0);
  const horn = {
    ...piano,
    id: "horn",
    name: "French Horns",
    role: "lift",
    performance: emptyPerformance,
  };
  const brassOutro = {
    ...arrangement,
    sections: arrangement.sections.map((section) => (
      section.name === "Silent Outro" ? { ...section, tracks: ["Brass"] } : section
    )),
  };
  const hornPerformance = createTrackPerformance(horn, project, brassOutro, 2);
  assert.ok(hornPerformance.notes.some((note) => note.startTick >= 4 * 4 * 480));

  const result = createExportBundle(
    project,
    arrangement,
    [bass, piano],
    { includeStems: true, includeMidi: true, includeMix: true, includeMetadata: true },
    1,
    "",
    "timeline-export",
  );
  const entries = openStoredZip(result.zip);
  const midi = entries.get("midi/timeline-test-arrangement.mid");
  const master = entries.get("mix/mastered.wav");
  const bassStem = entries.get("stems/electric-bass.wav");
  const pianoStem = entries.get("stems/grand-piano.wav");
  assert.ok(midi && master && bassStem && pianoStem);

  const midiEndTick = lastMidiTick(midi);
  assert.equal(midiEndTick, 6 * 4 * 480);
  const midiEndSeconds = tickToSeconds(midiEndTick, bass.performance.tempoMap);
  assert.ok(
    wavDuration(master) >= midiEndSeconds,
    `master WAV ${wavDuration(master)}s ended before MIDI ${midiEndSeconds}s`,
  );
  assert.ok(wavDuration(master) > 20, "render duration must include the silent trailing section, not 1-second display metadata");

  const sectionTwoSeconds = tickToSeconds(sectionTwoTick, bass.performance.tempoMap);
  const outroSeconds = tickToSeconds(4 * 4 * 480, bass.performance.tempoMap);
  assert.equal(peakAfter(bassStem, sectionTwoSeconds + 0.5), 0);
  assert.equal(peakBefore(pianoStem, sectionTwoSeconds - 0.1), 0);
  assert.equal(peakAfter(pianoStem, outroSeconds + 0.5), 0);
});