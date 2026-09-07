import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundlePath = `/tmp/music-export-pipeline-test-${process.pid}.mjs`;
await build({
  stdin: {
    contents: `
      export { createExportBundle, createTrackPerformance, normalizeMidiTick, tickToSeconds } from "./src/lib/export-pipeline";
      export { createStyleSpec } from "./src/lib/musicEngines";
      export { renderArrangementExport, rendererEvidenceTechnicalMetadata } from "./src/lib/exportEngine";
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "export-pipeline-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
  external: ["pg-native", "@google-cloud/*", "@google/*"],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});
const {
  createStyleSpec,
  createExportBundle,
  createTrackPerformance,
  renderArrangementExport,
  rendererEvidenceTechnicalMetadata,
  normalizeMidiTick,
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("mixed legacy and v2 PPQ ticks normalize to one MIDI timeline", () => {
  assert.equal(normalizeMidiTick(480, 480), 960);
  assert.equal(normalizeMidiTick(960, 960), 960);
  assert.equal(normalizeMidiTick(720, 480), 1440);
});

test("persisted stem bytes match the checksum in authorized artifact metadata", async () => {
  const provenance = {
    model: "TEST",
    version: "1",
    parameters: {},
    parentIds: ["track-model-artifact"],
    createdBy: "test",
  };
  const instrumentDefinition = {
    id: "piano",
    family: "keys",
    playableRange: { min: 21, max: 108 },
    comfortableRange: { min: 36, max: 96 },
    registers: [{ name: "full", min: 21, max: 108, character: "balanced" }],
    polyphonic: true,
    maxVoices: 10,
    articulations: ["sustain"],
    constraints: { maxLeap: 24, minNoteDuration: 0.05, maxSimultaneousNotes: 10 },
    controls: { dynamics: [1], expression: [11], sustain: 64, pitchBend: false, aftertouch: true },
  };
  const trackModel = {
    id: "stem-piano",
    instrument: "piano",
    instrumentDefinition,
    role: "harmony",
    notes: [{ id: "note-1", start: 0, duration: 1, pitch: 60, velocity: 96 }],
    cc: [],
    articulations: [],
    automation: [],
    source: "PERFORMANCE_ENGINE",
    version: 1,
    provenance,
  };
  const style = createStyleSpec("pop", {
    energy: 0.6,
    density: 0.5,
    harmonyComplexity: 4,
  });
  const plan = {
    id: "stem-plan",
    version: 1,
    sections: [{
      section: "verse",
      startBar: 1,
      endBar: 2,
      energy: 0.6,
      density: 0.5,
      tracks: { Piano: "main_harmony" },
      operations: ["phrase"],
    }],
    style,
    songModelVersion: 1,
    parameters: {},
    provenance,
  };
  const songModel = {
    audio: {
      name: "source.wav",
      contentType: "audio/wav",
      size: 1,
      durationSeconds: 2,
      sampleRate: 44_100,
      channels: 2,
    },
    tempoMap: [{ time: 0, bpm: 120, confidence: 1 }],
    meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    keyMap: [{ time: 0, key: "C major", confidence: 1 }],
    melody: [],
    chords: [],
    sections: [],
    energy: [],
    beats: [],
    bars: [],
    dynamics: [],
    sourceStems: [],
    lyrics: [],
    confidenceByField: {},
    provenance: [],
  };
  const tracks = [{
    id: "stem-piano",
    name: "Piano",
    role: "harmony",
    volume: -6,
    muted: false,
    solo: false,
  }];
  const renderedFiles = await renderArrangementExport({
    projectName: "Stem Evidence",
    bpm: 120,
    key: "C major",
    meter: "4/4",
    arrangementName: "Evidence check",
    arrangementVersion: 1,
    masterProfile: "STREAMING",
    energy: 0.6,
    density: 0.5,
    harmonyComplexity: 4,
    sections: [{ name: "Verse", energy: 0.6, density: 0.5, tracks: ["Piano"] }],
    tracks,
    songModel,
    plan,
    trackModels: [trackModel],
    styleSpec: style,
    generationProvider: "TEST",
    parentIds: ["track-model-artifact"],
    planArtifactId: "plan-artifact",
    planParentIds: ["song-model-artifact"],
    trackModelArtifactIds: { "stem-piano": "track-model-artifact" },
    includeStems: true,
    includeMidi: false,
  });
  const project = {
    id: "stem-evidence-project",
    name: "Stem Evidence",
    duration: "0:02",
    bpm: 120,
    meter: "4/4",
    key: "C major",
    sourceType: "PROMPT",
    sections: [{ name: "Verse", startBar: 1, endBar: 2, energy: 0.6 }],
    energy: [0.6],
    providers: [],
  };
  const arrangement = {
    id: "stem-evidence-arrangement",
    projectId: project.id,
    name: "Evidence check",
    style: "Pop",
    mode: "STUDIO",
    version: 1,
    harmonyComplexity: 4,
    energy: 0.6,
    density: 0.5,
    orchestraSize: 0.5,
    rhythmIntensity: 0.5,
    sections: [{ name: "Verse", startBar: 1, endBar: 2, energy: 0.6, density: 0.5, tracks: ["Piano"] }],
  };
  const bundle = createExportBundle(
    project,
    arrangement,
    [{
      ...tracks[0],
      kind: "midi",
      performance: {
        tempoMap: [{ tick: 0, bpm: 120 }],
        meterMap: [{ tick: 0, numerator: 4, denominator: 4 }],
        notes: [],
        expression: [],
        articulations: [],
      },
    }],
    { includeStems: true, includeMidi: false, includeMix: false, includeMetadata: false },
    1,
    "",
    "stem-evidence-export",
    renderedFiles,
  );
  const stem = renderedFiles.find((file) => file.type === "STEM");
  const premaster = renderedFiles.find((file) => file.name === "mix/premaster.wav");
  assert.ok(stem?.rendererEvidence);
  assert.equal(premaster?.type, "PREMASTER");
  const manifest = JSON.parse(
    openStoredZip(bundle.zip).get("metadata/export-manifest.json").toString("utf8"),
  );
  assert.equal(
    manifest.files.find((file) => file.name === "mix/premaster.wav")?.type,
    "PREMASTER",
  );
  const artifactMetadata = {
    trackName: stem.rendererEvidence.trackName,
    role: stem.rendererEvidence.role,
    ...rendererEvidenceTechnicalMetadata(stem.rendererEvidence),
  };
  const persistedStem = openStoredZip(bundle.zip).get(stem.name);
  assert.ok(persistedStem);
  assert.equal(
    sha256(persistedStem),
    artifactMetadata.stemOutputSha256,
    "authorized stem metadata must attest the exact persisted/downloadable WAV",
  );
});

test("downloadable export reports exclude private evaluation fingerprints", () => {
  const privateSentinel = "PRIVATE-FINGERPRINT-SENTINEL";
  const futurePrivateSentinel = "FUTURE-PRIVATE-EVALUATION-SENTINEL";
  const project = {
    id: "private-evaluation-project",
    name: "Private Evaluation",
    duration: "0:04",
    bpm: 120,
    meter: "4/4",
    key: "C major",
    sourceType: "PROMPT",
    sections: [{ name: "Verse", startBar: 1, endBar: 1, energy: 0.6 }],
    energy: [0.6],
    providers: [],
  };
  const arrangement = {
    id: "private-evaluation-arrangement",
    projectId: project.id,
    name: "Safe report",
    style: "Pop",
    mode: "STUDIO",
    version: 1,
    harmonyComplexity: 4,
    energy: 0.6,
    density: 0.5,
    orchestraSize: 0.5,
    rhythmIntensity: 0.5,
    sections: [{
      name: "Verse",
      startBar: 1,
      endBar: 1,
      energy: 0.6,
      density: 0.5,
      tracks: [],
    }],
    generationProvenance: {
      provider: "TEST",
      modelVersion: "1",
      reportedModelVersion: "1",
      checkpointSha256: null,
      candidateId: "candidate-safe",
      providerRequestId: "request-safe",
      seed: 17,
      parentArtifactIds: ["parent-safe"],
      evaluation: {
        status: "evaluated",
        providerScore: 0.77,
        futureInternalEvaluation: {
          detail: futurePrivateSentinel,
        },
        renderArtifactIds: ["audio-safe"],
        artifacts: [],
        qualityReport: null,
        musicCritic: {
          score: 0.91,
          dimensions: {},
          strengths: ["clear structure"],
          weaknesses: [],
          coverage: { availableDimensions: 1, totalDimensions: 8, sparse: true },
        },
        error: null,
        diversity: {
          fingerprint: {
            sectionCount: privateSentinel,
            privateVector: [privateSentinel],
          },
          comparedToCandidateId: "candidate-baseline",
          distance: 0.42,
          threshold: 0.25,
          rejected: false,
          reason: "distinct",
        },
      },
    },
  };
  const bundle = createExportBundle(
    project,
    arrangement,
    [],
    { includeStems: false, includeMidi: false, includeMix: false, includeMetadata: true },
    1,
    "",
    "private-evaluation-export",
  );
  const jsonReports = [...openStoredZip(bundle.zip)]
    .filter(([name]) => name.endsWith(".json"));
  assert.ok(jsonReports.length >= 3);
  for (const [name, data] of jsonReports) {
    const serialized = data.toString("utf8");
    assert.equal(serialized.includes('"fingerprint"'), false, `${name} exposed a fingerprint key`);
    assert.equal(serialized.includes(privateSentinel), false, `${name} exposed private fingerprint data`);
    assert.equal(
      serialized.includes(futurePrivateSentinel),
      false,
      `${name} exposed an unknown evaluation field`,
    );
  }
  const arrangementReport = JSON.parse(
    openStoredZip(bundle.zip).get("metadata/arrangement.json").toString("utf8"),
  );
  const evaluation = arrangementReport.arrangement.generationProvenance.evaluation;
  assert.equal(evaluation.musicCritic.score, 0.91);
  assert.equal("futureInternalEvaluation" in evaluation, false);
  assert.deepEqual(evaluation.diversity, {
    comparedToCandidateId: "candidate-baseline",
    distance: 0.42,
    threshold: 0.25,
    rejected: false,
    reason: "distinct",
  });
});

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
  const sectionTwoTick = 2 * 4 * 960;
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
  assert.ok(hornPerformance.notes.some((note) => note.startTick >= 4 * 4 * 960));
  const compoundPerformance = createTrackPerformance(
    bass,
    {
      ...project,
      meter: "6/8",
      sections: [{ ...project.sections[0], startBar: 1, endBar: 2 }],
    },
    {
      ...arrangement,
      sections: [{ ...arrangement.sections[0], startBar: 1, endBar: 2 }],
    },
    0,
  );
  assert.deepEqual(compoundPerformance.meterMap[0], {
    tick: 0,
    numerator: 6,
    denominator: 8,
  });
  assert.ok(compoundPerformance.notes.some((note) => note.startTick === 2880));
  assert.ok(!compoundPerformance.notes.some((note) => note.startTick === 5760));
  const lateBeatPerformance = createTrackPerformance(
    piano,
    {
      ...project,
      meter: "6/8",
      sections: [{ ...project.sections[0], startBar: 1, endBar: 1 }],
    },
    {
      ...arrangement,
      sections: [{
        ...arrangement.sections[0],
        startBar: 1,
        endBar: 1,
        tracks: ["Piano"],
        chords: [{
          startBeat: 5,
          durationBeats: 1,
          symbol: "C",
          quality: "major",
          inversion: 0,
        }],
      }],
    },
    1,
  );
  assert.ok(lateBeatPerformance.notes.some((note) => note.startTick === 2400));
  assert.ok(lateBeatPerformance.notes.every((note) => note.startTick + note.durationTicks <= 2880));

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
  const manifest = JSON.parse(entries.get("metadata/export-manifest.json").toString("utf8"));
  const bassStem = entries.get("stems/electric-bass.wav");
  const pianoStem = entries.get("stems/grand-piano.wav");
  assert.ok(midi && master && bassStem && pianoStem);
  assert.equal(
    manifest.files.find((file) => file.name === "mix/premaster.wav")?.type,
    "PREMASTER",
  );
  assert.equal(
    manifest.files.find((file) => file.name === "mix/instrumental.wav")?.type,
    "MIX",
  );
  assert.equal(
    manifest.files.find((file) => file.name === "mix/mastered.wav")?.type,
    "MASTER",
  );

  const midiEndTick = lastMidiTick(midi);
  assert.equal(midiEndTick, 6 * 4 * 960);
  const midiEndSeconds = tickToSeconds(
    midiEndTick,
    bass.performance.tempoMap,
    bass.performance.ppq,
  );
  assert.ok(
    wavDuration(master) >= midiEndSeconds,
    `master WAV ${wavDuration(master)}s ended before MIDI ${midiEndSeconds}s`,
  );
  assert.ok(wavDuration(master) > 20, "render duration must include the silent trailing section, not 1-second display metadata");

  const sectionTwoSeconds = tickToSeconds(
    sectionTwoTick,
    bass.performance.tempoMap,
    bass.performance.ppq,
  );
  const outroSeconds = tickToSeconds(
    4 * 4 * 960,
    bass.performance.tempoMap,
    bass.performance.ppq,
  );
  assert.equal(peakAfter(bassStem, sectionTwoSeconds + 0.5), 0);
  assert.equal(peakBefore(pianoStem, sectionTwoSeconds - 0.1), 0);
  assert.equal(peakAfter(pianoStem, outroSeconds + 0.5), 0);
});

test("versioned piano, chord, CC, articulation, and transpose edits drive exported performance", () => {
  const project = {
    id: "edited-project",
    name: "Edited Project",
    duration: "0:08",
    bpm: 120,
    meter: "4/4",
    key: "C major",
    sourceType: "PROMPT",
    sections: [{ name: "Intro", startBar: 1, endBar: 2, energy: 0.6 }],
    energy: [0.6],
    providers: [],
  };
  const arrangement = {
    id: "edited-arrangement",
    projectId: project.id,
    name: "Local edits",
    style: "Test",
    mode: "STUDIO",
    version: 7,
    harmonyComplexity: 6,
    energy: 0.6,
    density: 0.5,
    orchestraSize: 0.5,
    rhythmIntensity: 0.5,
    sections: [{
      name: "Intro",
      startBar: 1,
      endBar: 2,
      energy: 0.6,
      density: 0.5,
      tracks: ["Bass", "Piano"],
      transposeSemitones: 2,
      automation: [{ bar: 1, value: 0.25 }, { bar: 2, value: 0.75 }],
      chords: [{
        startBeat: 0,
        durationBeats: 4,
        symbol: "Dm",
        quality: "minor",
        inversion: 1,
        bass: "A",
      }],
      midiTracks: {
        "Electric Bass": {
          notes: [{
            pitch: 45,
            start: 1,
            duration: 2,
            velocity: 101,
            articulation: "staccato",
          }],
          cc: [10, 100],
        },
      },
    }],
  };
  const emptyPerformance = {
    tempoMap: [],
    meterMap: [],
    notes: [],
    expression: [],
    articulations: [],
  };
  const bass = {
    id: "edited-bass",
    name: "Electric Bass",
    role: "bass",
    kind: "midi",
    volume: 0,
    muted: false,
    solo: false,
    performance: emptyPerformance,
  };
  const piano = {
    ...bass,
    id: "edited-piano",
    name: "Grand Piano",
    role: "harmony",
  };
  const editedBass = createTrackPerformance(bass, project, arrangement, 0);
  const editedPiano = createTrackPerformance(piano, project, arrangement, 1);

  assert.deepEqual(editedBass.notes, [{
    startTick: 960,
    durationTicks: 1920,
    pitch: 47,
    velocity: 101,
  }]);
  assert.ok(editedBass.expression.some((event) => event.value === 10));
  assert.ok(editedBass.expression.some((event) => event.value === 100));
  assert.ok(editedBass.expression.some((event) => event.value === 32));
  assert.ok(editedBass.articulations.some((event) =>
    event.tick === 960 && event.type === "staccato" && event.keyswitch === 25));
  assert.deepEqual(
    editedPiano.notes.map((note) => note.pitch).sort((left, right) => left - right),
    [47, 55, 59, 64],
  );

  const baselineArrangement = {
    ...arrangement,
    sections: [{
      ...arrangement.sections[0],
      transposeSemitones: 0,
      chords: [{
        startBeat: 0,
        durationBeats: 4,
        symbol: "C",
        quality: "major",
        inversion: 0,
      }],
      midiTracks: {
        "Electric Bass": {
          notes: [{
            pitch: 40,
            start: 0,
            duration: 1,
            velocity: 70,
            articulation: "sustain",
          }],
          cc: [64],
        },
      },
    }],
  };
  const baselineBass = createTrackPerformance(bass, project, baselineArrangement, 0);
  const editedBundle = createExportBundle(
    project,
    arrangement,
    [{ ...bass, performance: editedBass }, { ...piano, performance: editedPiano }],
    { includeStems: false, includeMidi: true, includeMix: false, includeMetadata: false },
    1,
    "",
    "edited-export",
  );
  const baselineBundle = createExportBundle(
    project,
    baselineArrangement,
    [{ ...bass, performance: baselineBass }],
    { includeStems: false, includeMidi: true, includeMix: false, includeMetadata: false },
    1,
    "",
    "baseline-export",
  );
  const editedMidi = openStoredZip(editedBundle.zip).get("midi/edited-project-arrangement.mid");
  const baselineMidi = openStoredZip(baselineBundle.zip).get("midi/edited-project-arrangement.mid");
  assert.ok(editedMidi && baselineMidi);
  assert.notDeepEqual(editedMidi, baselineMidi);

  const extendedArrangement = {
    ...arrangement,
    sections: [{ ...arrangement.sections[0], endBar: 4 }],
  };
  const extendedBass = createTrackPerformance(bass, project, extendedArrangement, 0);
  const extendedBundle = createExportBundle(
    project,
    extendedArrangement,
    [{ ...bass, performance: extendedBass }],
    { includeStems: false, includeMidi: true, includeMix: false, includeMetadata: false },
    1,
    "",
    "extended-export",
  );
  const extendedMidi = openStoredZip(extendedBundle.zip).get("midi/edited-project-arrangement.mid");
  assert.ok(extendedMidi);
  assert.equal(
    lastMidiTick(extendedMidi),
    4 * 4 * 960,
    "MIDI endpoint must follow the arrangement's edited section boundary",
  );
});