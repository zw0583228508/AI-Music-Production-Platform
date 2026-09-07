import { strict as assert } from "node:assert";
import { unlink } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = `/tmp/music-expressive-export-${process.pid}.mjs`;

await build({
  stdin: {
    contents: `
      export { renderArrangementExport } from "./src/lib/exportEngine";
      export { applyArrangementEditorChanges, buildTrackModels, createStyleSpec } from "./src/lib/musicEngines";
      export { validateCanonicalTrackModels } from "./src/lib/musicProviders";
    `,
    resolveDir: apiDirectory,
    sourcefile: "expressive-export-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: harnessPath,
  external: ["pg-native", "@google-cloud/*", "@google/*"],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});

const {
  applyArrangementEditorChanges,
  buildTrackModels,
  createStyleSpec,
  renderArrangementExport,
  validateCanonicalTrackModels,
} = await import(harnessPath);

const vlq = (value) => {
  const output = [value & 0x7f];
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) {
    output.unshift((rest & 0x7f) | 0x80);
  }
  return Buffer.from(output);
};

test("expressive export preserves a silent trailing 6/8 section in WAV and MIDI", async () => {
  const provenance = {
    model: "TEST",
    version: "1",
    parameters: {},
    parentIds: ["artifact-plan"],
    createdBy: "test",
  };
  const instrumentDefinition = {
    id: "grand_piano",
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
    id: "track-piano",
    instrument: "grand_piano",
    instrumentDefinition,
    role: "harmony",
    notes: [{ id: "note-1", start: 0, duration: 1, pitch: 60, velocity: 90 }],
    cc: [],
    articulations: [],
    automation: [],
    source: "PERFORMANCE_ENGINE",
    version: 1,
    provenance,
  };
  const plan = {
    id: "arrangement-test",
    version: 1,
    sections: [
      { section: "intro", startBar: 1, endBar: 2, energy: 0.5, density: 0.5, tracks: { Piano: "main_harmony" }, operations: ["phrase"] },
      { section: "silent_outro", startBar: 3, endBar: 4, energy: 0.1, density: 0, tracks: { Piano: "none" }, operations: ["break"] },
    ],
    style: {
      genre: "pop", subgenre: "test", era: "modern", tempoCharacter: "steady",
      rhythm: { swing: 0, syncopation: 0, subdivision: "8th" },
      harmony: { complexity: 5, tension: 0.4, voicing: "close" },
      instrumentation: { preferredFamilies: ["keys"], avoid: [] },
      orchestration: { density: 0.5, registerSpread: 0.5, dynamics: "arc" },
      production: { stereoWidth: 0.5, room: "studio", mixProfile: "streaming" },
      dynamics: { range: 0.5, accentStrength: 0.5 },
    },
    songModelVersion: 1,
    parameters: {},
    provenance,
  };
  const files = await renderArrangementExport({
    projectName: "Timeline",
    bpm: 120,
    key: "C major",
    meter: "6/8",
    arrangementName: "Silent outro",
    arrangementVersion: 1,
    masterProfile: "STREAMING",
    energy: 0.5,
    density: 0.5,
    harmonyComplexity: 5,
    sections: [],
    tracks: [{ id: "track-piano", name: "Piano", role: "harmony", volume: 0, muted: false, solo: false }],
    songModel: {
      contractVersion: "2.0",
      timebase: { ppq: 960, originSeconds: 0, coordinateSystem: "seconds+ticks" },
      audio: { name: "test.wav", contentType: "audio/wav", size: 1, durationSeconds: 6, sampleRate: 44_100, channels: 2 },
      tempoMap: [{ time: 0, bpm: 120, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "6/8", confidence: 1 }],
      keyMap: [{ time: 0, key: "C major", confidence: 1 }],
      melody: [], chords: [], sections: [], energy: [], beats: [], bars: [], dynamics: [],
      sourceStems: [], lyrics: [], confidenceByField: {}, provenance: [],
    },
    plan,
    trackModels: [trackModel],
    styleSpec: plan.style,
    generationProvider: "TEST",
    generationModelVersion: "test-model@2.1",
    candidateId: "candidate-17",
    providerRequestId: "provider-request-18",
    seed: 42,
    parentIds: ["artifact-track-model"],
    planArtifactId: "artifact-plan",
    planParentIds: ["artifact-song-model"],
    trackModelArtifactIds: { "track-piano": "artifact-track-model" },
    includeStems: false,
    includeMidi: true,
  });

  const master = files.find((file) => file.type === "MASTER");
  const midi = files.find((file) => file.type === "MIDI");
  const manifest = files.find((file) => file.type === "METADATA");
  assert.ok(master && midi && manifest);
  assert.equal(master.data.length, 44 + 44_100 * 6 * 2 * 2);
  const manifestData = JSON.parse(manifest.data.toString());
  assert.equal(manifestData.durationSeconds, 6);
  assert.deepEqual(manifestData.generation, {
    provider: "TEST",
    modelVersion: "test-model@2.1",
    candidateId: "candidate-17",
    providerRequestId: "provider-request-18",
    seed: 42,
    parentArtifactIds: ["artifact-track-model"],
    planArtifactId: "artifact-plan",
    trackModelArtifactIds: { "track-piano": "artifact-track-model" },
  });
  assert.equal(master.provenance.parameters.generationProvider, "TEST");
  assert.equal(master.provenance.parameters.generationModelVersion, "test-model@2.1");
  assert.equal(master.provenance.parameters.seed, 42);
  assert.equal(master.provenance.parameters.candidateId, "candidate-17");
  assert.deepEqual(master.provenance.parentIds, ["artifact-track-model"]);
  const expectedFinalDelta = vlq(6 * 960 - 960);
  assert.notEqual(
    midi.data.indexOf(Buffer.concat([expectedFinalDelta, Buffer.from([0xff, 0x2f, 0x00])])),
    -1,
  );
});

test("saved editor MIDI and CC replace persisted performance data", () => {
  const edited = applyArrangementEditorChanges({
    trackModels: [{
      id: "track-piano",
      instrument: "piano",
      instrumentDefinition: {
        id: "piano", family: "keys",
        playableRange: { min: 21, max: 108 }, comfortableRange: { min: 36, max: 96 },
        registers: [{ name: "full", min: 21, max: 108, character: "balanced" }],
        polyphonic: true, maxVoices: 10, articulations: ["sustain"],
        constraints: { maxLeap: 24, minNoteDuration: 0.05, maxSimultaneousNotes: 10 },
        controls: { dynamics: [1], expression: [11], sustain: 64, pitchBend: false, aftertouch: true },
      },
      role: "harmony",
      notes: [{ id: "old", start: 0, duration: 1, pitch: 60, velocity: 80 }],
      cc: [], articulations: [], automation: [], source: "PERFORMANCE_ENGINE", version: 1,
      provenance: { model: "TEST", version: "1", parameters: {}, parentIds: ["plan"], createdBy: "test" },
    }],
    sections: [{
      name: "intro", energy: 0.5, density: 0.5, tracks: ["Piano"], startBar: 1, endBar: 1,
      midiTracks: {
        Piano: {
          notes: [{ id: "edited", pitch: 65, start: 1, duration: 0.5, velocity: 100, articulation: "accent" }],
          cc: [24, 96],
        },
      },
    }],
    tracks: [{ id: "track-piano", name: "Piano", role: "harmony" }],
    bpm: 120,
    meter: "4/4",
  });
  assert.deepEqual(edited[0].notes.map((note) => note.id), ["edited"]);
  assert.equal(edited[0].notes[0].start, 0.5);
  assert.equal(edited[0].notes[0].pitch, 65);
  assert.deepEqual(edited[0].cc.map((event) => event.value), [24, 96]);
  assert.equal(edited[0].articulations[0].name, "sustain");
  assert.equal(edited[0].source, "ARRANGEMENT_EDITOR");
  assert.deepEqual(validateCanonicalTrackModels(edited, ["track-piano"]), []);
});

test("export rejects unplayable saved TrackModels instead of synthesizing them", async () => {
  const invalidTrack = {
    id: "track-bass",
    instrument: "bass",
    instrumentDefinition: {
      id: "bass", family: "strings", playableRange: { min: 28, max: 67 },
      comfortableRange: { min: 36, max: 60 },
      registers: [{ name: "full", min: 28, max: 67, character: "balanced" }],
      polyphonic: false, maxVoices: 1, articulations: ["finger"],
      constraints: { maxLeap: 12, minNoteDuration: 0.08, maxSimultaneousNotes: 1 },
      controls: { dynamics: [1], expression: [11], pitchBend: true, aftertouch: false },
    },
    role: "bass",
    notes: [{ id: "impossible", start: 0, duration: 1, pitch: 80, velocity: 90 }],
    cc: [], articulations: [], automation: [], source: "TEST", version: 1,
    provenance: { model: "TEST", version: "1", parameters: {}, parentIds: ["plan"], createdBy: "test" },
  };
  await assert.rejects(() => renderArrangementExport({
    projectName: "No fake audio", bpm: 120, key: "C", meter: "4/4",
    arrangementName: "Invalid", arrangementVersion: 1, masterProfile: "STREAMING",
    energy: 0.5, density: 0.5, harmonyComplexity: 5, sections: [],
    tracks: [{ id: "track-bass", name: "Bass", role: "bass", volume: 0, muted: false }],
    songModel: {
      audio: { name: "test.wav", contentType: "audio/wav", size: 1, durationSeconds: 2, sampleRate: 44_100, channels: 2 },
      tempoMap: [{ time: 0, bpm: 120, confidence: 1 }], meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
      keyMap: [{ time: 0, key: "C", confidence: 1 }], melody: [], chords: [], sections: [],
      energy: [], beats: [], bars: [], dynamics: [], sourceStems: [], lyrics: [], confidenceByField: {}, provenance: [],
    },
    plan: { id: "invalid", version: 1, sections: [], style: createStyleSpec("pop", { density: 0.5, harmonyComplexity: 5, energy: 0.5 }), songModelVersion: 1, parameters: {}, provenance: invalidTrack.provenance },
    trackModels: [invalidTrack], styleSpec: createStyleSpec("pop", { density: 0.5, harmonyComplexity: 5, energy: 0.5 }),
    generationProvider: "UNAVAILABLE_PROVIDER", parentIds: ["track-artifact"],
    includeStems: false, includeMidi: false,
  }), /Export refused unplayable TrackModels/);
});

test("local generation satisfies every declared instrument constraint", () => {
  const style = createStyleSpec("cinematic orchestra", {
    density: 0.7, harmonyComplexity: 6, energy: 0.8,
  });
  const songModel = {
    audio: { name: "test.wav", contentType: "audio/wav", size: 1, durationSeconds: 8, sampleRate: 44_100, channels: 2 },
    tempoMap: [{ time: 0, bpm: 120, confidence: 1 }],
    meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    keyMap: [{ time: 0, key: "C major", confidence: 1 }],
    melody: [], chords: [], sections: [{ name: "Full", startBar: 1, endBar: 4, energy: 0.8 }],
    energy: [], beats: [], bars: [], dynamics: [], sourceStems: [], lyrics: [],
    confidenceByField: {}, provenance: [],
  };
  const tracks = [
    { id: "drums", name: "Drums", role: "rhythm" },
    { id: "bass", name: "Bass", role: "bass" },
    { id: "strings", name: "Strings", role: "countermelody" },
    { id: "brass", name: "French Horn", role: "lift" },
    { id: "guitar", name: "Guitar", role: "harmony" },
    { id: "synth", name: "Synth Pad", role: "harmony" },
    { id: "piano", name: "Piano", role: "harmony" },
  ];
  const plan = {
    id: "all-families", version: 1,
    sections: [{
      section: "full", startBar: 1, endBar: 4, energy: 0.8, density: 0.7,
      tracks: Object.fromEntries(tracks.map((track) => [track.name, "main_harmony"])),
      operations: ["phrase"],
    }],
    style, songModelVersion: 1, parameters: {},
    provenance: { model: "TEST", version: "1", parameters: {}, parentIds: ["song"], createdBy: "test" },
  };
  const models = buildTrackModels({ songModel, plan, tracks, style, seed: 42 });
  assert.deepEqual(validateCanonicalTrackModels(models, tracks.map((track) => track.id)), []);
});

process.on("exit", () => {
  void unlink(harnessPath).catch(() => undefined);
});