import assert from "node:assert/strict";
import test from "node:test";
import type { SongModelData } from "@workspace/db";
import {
  buildTrackModels,
  createArrangementPlan,
  createStyleSpec,
  getInstrumentDefinition,
  HarmonyEngine,
} from "../src/lib/musicEngines";
import { fuseHarmonyEvidence, parseHarmony } from "../src/lib/analysisProviders";

const song = (overrides: Partial<SongModelData> = {}): SongModelData => ({
  contractVersion: "1.0",
  validation: { status: "accepted", issues: [] },
  fusion: { selectedProvider: null, confidence: 0, decisions: [] },
  audio: {
    name: "test.wav", contentType: "audio/wav", size: 1, durationSeconds: 16,
    sampleRate: 44_100, channels: 2, proxyObjectPath: null,
    proxyContentType: null, analysisStartSeconds: 0, analysisDurationSeconds: 16,
    analysisCoverage: "full",
  },
  analysisStartSeconds: 0, analysisDurationSeconds: 16, analysisCoverage: 1,
  beats: [], bars: [], dynamics: [], waveform: [], stems: [], sourceStems: [],
  lyrics: [], confidenceByField: {}, providerProvenance: [],
  tempoMap: [{ time: 0, bpm: 120, confidence: 1 }],
  meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
  keyMap: [{ time: 0, key: "C major", confidence: 1 }],
  melody: [], chords: [],
  sections: [{ name: "Verse", startBar: 1, endBar: 2, energy: .6 }],
  energy: [.6],
  ...overrides,
});

const planFor = (model: SongModelData, version = 7, controls: Record<string, number> = {}) => createArrangementPlan({
  arrangementId: "arrangement-stable",
  version: 1,
  songModel: model,
  style: createStyleSpec("cinematic pop", { density: .65, harmonyComplexity: 6, energy: .7 }),
  tracks: [
    { id: "piano", name: "Piano", role: "harmony" },
    { id: "bass", name: "Bass", role: "bass" },
    { id: "drums", name: "Drums", role: "rhythm" },
    { id: "voice", name: "Voice", role: "vocal" },
  ],
  parameters: { songModelVersion: version, ...controls },
});

test("harmony is deterministic by Song Model version and retains supplied chord evidence", () => {
  const model = song({
    chords: [{
      start: 0, end: 2, symbol: "C", roman: "I", confidence: .9,
      quality: "major",
    }],
  });
  const plan = planFor(model, 11);
  const engine = new HarmonyEngine();
  assert.deepEqual(engine.generate(model, plan), engine.generate(model, plan));
  const [evidence] = engine.generate(model, plan);
  assert.equal(evidence.symbol, "C");
  assert.deepEqual(evidence.tones.map((pitch) => pitch % 12), [0, 4, 7]);
  assert.equal(evidence.tones.some((pitch) => pitch % 12 === 11), false);
});

test("legacy chord symbols retain sevenths, extensions, alterations, and slash voicings in harmony and TrackModels", () => {
  const symbols = [
    ["Cmaj7", [0, 4, 7, 11]],
    ["C7", [0, 4, 7, 10]],
    ["Am7", [9, 0, 4, 7]],
    ["C9#11", [0, 4, 7, 2, 5, 6, 10]],
    ["C/E", [4, 7, 0]],
  ] as const;
  for (const [symbol, expected] of symbols) {
    const model = song({
      chords: [{ start: 0, end: 8, symbol, roman: "I", confidence: .9 }],
      sections: [{ name: "Verse", startBar: 1, endBar: 4, energy: .7 }],
    });
    const plan = planFor(model);
    plan.sections[0].trackDirectives!.piano.harmonicActivity = .9;
    const [harmony] = new HarmonyEngine().generate(model, plan);
    assert.deepEqual(harmony.tones.map((pitch) => pitch % 12), expected);
    const [track] = buildTrackModels({
      songModel: model, plan, style: plan.style, seed: 14,
      tracks: [{ id: "piano", name: "Piano", role: "harmony" }],
    });
    const soundingPcs = new Set(track.notes.map((note) => note.pitch % 12));
    assert.ok(expected.every((pitch) => soundingPcs.has(pitch)), `${symbol} tones were not rendered`);
  }
});

test("generated harmony scores reliable melody fit and creates functional dominant-tonic cadence", () => {
  const melodyFit = song({
    melody: [{ start: 0, end: 1, pitch: 65, velocity: 90, confidence: .9, source: "verified" }],
  });
  const melodyPlan = planFor(melodyFit);
  melodyPlan.parameters.harmonyComplexity = 8;
  const harmony = new HarmonyEngine().generate(melodyFit, melodyPlan);
  assert.equal(harmony[0].tones.some((pitch) => pitch % 12 === 5), true);

  const cadenceModel = song();
  const cadencePlan = planFor(cadenceModel);
  cadencePlan.parameters.harmonyComplexity = 8;
  const cadence = new HarmonyEngine().generate(cadenceModel, cadencePlan);
  assert.equal(cadence.at(-2)?.symbol, "V");
  assert.equal(cadence.at(-1)?.symbol, "I");
  assert.notEqual(cadence.at(-1)?.decision?.voiceLeading, undefined);
});

test("generated harmony uses absolute non-C evidence and correct major/minor diatonic triads", () => {
  const degreeModel = (key: string, scaleRoots: number[], expectedFunctions: string[]) => {
    const model = song({
      keyMap: [{ time: 0, key, confidence: 1 }],
      sections: [{ name: "Verse", startBar: 1, endBar: 8, energy: .6 }],
      bass: scaleRoots.map((pitch, bar) => ({ start: bar * 2, end: bar * 2 + 1.8, pitch, confidence: .9 })),
    });
    const plan = planFor(model, 7, { harmonyComplexity: 8 });
    const harmony = new HarmonyEngine().generate(model, plan);
    assert.deepEqual(harmony.map((chord) => chord.function), expectedFunctions);
    return harmony;
  };
  // D major: I ii iii IV V vi vii°; the first six are root-selected by
  // absolute bass evidence and the final tonic is the cadence.
  const major = degreeModel("D major", [50, 52, 54, 55, 57, 59, 61, 50],
    ["I", "ii", "iii", "IV", "V", "vi", "vii°", "I"]);
  assert.deepEqual(major[5].tones.map((pitch) => pitch % 12), [11, 2, 6]); // B minor, not a major vi
  assert.deepEqual(major[6].tones.map((pitch) => pitch % 12), [1, 4, 7]);

  const minor = degreeModel("A minor", [57, 59, 60, 62, 64, 65, 67, 57],
    ["i", "ii°", "III", "iv", "v", "VI", "VII", "i"]);
  assert.deepEqual(minor[1].tones.map((pitch) => pitch % 12), [11, 2, 5]);
  assert.deepEqual(minor[4].tones.slice(0, 3).map((pitch) => pitch % 12), [4, 7, 11]);

  const melodyModel = song({
    keyMap: [{ time: 0, key: "D major", confidence: 1 }],
    melody: [{ start: 0, end: 1, pitch: 61, velocity: 90, confidence: .9, source: "provider" }],
  });
  const melodyPlan = planFor(melodyModel, 7, { harmonyComplexity: 8 });
  const [melodySelected] = new HarmonyEngine().generate(melodyModel, melodyPlan);
  assert.ok(melodySelected.tones.some((pitch) => pitch % 12 === 1));
  assert.ok(Number(melodySelected.decision?.melodyFit) > 0);
});

test("canonical provider chord fields survive parsing and fusion", () => {
  const parsed = parseHarmony("SHEETSAGE", {
    version: "1", confidence: .9,
    chords: [{
      start: 0, end: 2, symbol: "G7", roman: "V7", confidence: .8,
      root: "G", quality: "dominant", extensions: ["7"], alterations: ["b9"],
      inversion: 1, bass: "B", function: "dominant",
      timing: { startSeconds: 0, endSeconds: 2 },
      melodyConflictEvidence: [{ pitch: 61, conflict: "avoid_note", severity: .5 }],
      candidateProvenance: [{ candidateId: "p-1", provider: "SHEETSAGE", selected: true }],
    }],
  }, 4);
  const [chord] = fuseHarmonyEvidence([parsed]).chords;
  assert.equal(chord.root, "G");
  assert.deepEqual(chord.extensions, ["7"]);
  assert.equal(chord.bass, "B");
  assert.equal(chord.function, "dominant");
  assert.equal(chord.candidateProvenance?.[0]?.candidateId, "p-1");
});

test("bass evidence and complexity alter deterministic candidate scoring and harmonic rhythm", () => {
  const fourBars = song({ sections: [{ name: "Verse", startBar: 1, endBar: 4, energy: .6 }] });
  const lowPlan = planFor(fourBars);
  lowPlan.parameters.harmonyComplexity = 3;
  const highPlan = planFor(fourBars);
  highPlan.parameters.harmonyComplexity = 8;
  const low = new HarmonyEngine().generate(fourBars, lowPlan);
  const high = new HarmonyEngine().generate(fourBars, highPlan);
  assert.equal(low.length, 1);
  assert.equal(high.length, 4);
  assert.ok(high.some((chord) => chord.tones.length === 4));

  const bassProvider = parseHarmony("BASS", {
    version: "1", confidence: .9,
    bass: [{ start: 0, end: 2, pitch: 53, confidence: .9 }],
  }, 4);
  const bassModel = song({ bass: bassProvider.bass.map((note) => ({ ...note, provider: bassProvider.providerId })) });
  const bassPlan = planFor(bassModel);
  bassPlan.parameters.harmonyComplexity = 8;
  const bassHarmony = new HarmonyEngine().generate(bassModel, bassPlan);
  assert.equal(bassHarmony[0].root % 12, 5);
  assert.ok(Number(bassHarmony[0].decision?.bassFit) > 0);
});

test("orchestra size and rhythm intensity deterministically alter layers and rhythmic events", () => {
  const model = song({ sections: [{ name: "Verse", startBar: 1, endBar: 4, energy: .6 }] });
  const small = planFor(model, 7, { orchestraSize: .1, rhythmIntensity: .2 });
  const large = planFor(model, 7, { orchestraSize: .95, rhythmIntensity: .95 });
  assert.ok((large.sections[0].activeTracks?.length ?? 0) > (small.sections[0].activeTracks?.length ?? 0));
  const drumInput = [{ id: "drums", name: "Drums", role: "rhythm" }];
  const sparse = buildTrackModels({ songModel: model, plan: small, style: small.style, tracks: drumInput, seed: 4 })[0];
  const busy = buildTrackModels({ songModel: model, plan: large, style: large.style, tracks: drumInput, seed: 4 })[0];
  assert.ok(busy.notes.length > sparse.notes.length);
  assert.deepEqual(
    buildTrackModels({ songModel: model, plan: large, style: large.style, tracks: drumInput, seed: 4 }),
    buildTrackModels({ songModel: model, plan: large, style: large.style, tracks: drumInput, seed: 4 }),
  );
});

test("director membership/directives drive composition without fabricating an absent melody", () => {
  const model = song({ sections: [
    { name: "Verse", startBar: 1, endBar: 1, energy: .6 },
    { name: "Chorus", startBar: 2, endBar: 2, energy: .85 },
  ] });
  const plan = planFor(model);
  const section = plan.sections[0];
  assert.deepEqual(section.activeTracks?.sort(), ["bass", "drums", "piano"].sort());
  assert.equal(section.trackDirectives?.drums.fill, true);
  assert.equal(section.trackDirectives?.bass.register, "low");
  assert.ok(section.trackDirectives?.piano.entry?.bar === 1);

  const tracks = buildTrackModels({
    songModel: model, plan, style: plan.style, seed: 123,
    tracks: [
      { id: "piano", name: "Piano", role: "harmony" },
      { id: "voice", name: "Voice", role: "vocal" },
    ],
  });
  assert.equal(tracks.find((track) => track.id === "voice")?.notes.length, 0);
  const piano = tracks.find((track) => track.id === "piano")!;
  assert.equal(piano.directive?.register, "middle");
  assert.ok(piano.mapping?.articulationMap && piano.mapping?.controlMap);
  assert.ok(piano.cc.some((event) => event.controller === 11));
});

test("vocal evidence obeys ID and legacy-name section activation and clips at boundaries", () => {
  const model = song({
    melody: [{ start: 1.5, end: 2.5, pitch: 69, velocity: 90, confidence: .9, source: "provider" }],
    sections: [
      { name: "Verse", startBar: 1, endBar: 1, energy: .5 },
      { name: "Chorus", startBar: 2, endBar: 2, energy: .8 },
    ],
  });
  const plan = planFor(model);
  plan.sections[0].activeTracks = ["voice"];
  plan.sections[1].activeTracks = [];
  plan.sections[0].tracks.Voice = "main_harmony";
  plan.sections[1].tracks.Voice = "main_harmony";
  const vocalInput = { songModel: model, plan, style: plan.style, seed: 3,
    tracks: [{ id: "voice", name: "Voice", role: "vocal" }] };
  const [firstOnly] = buildTrackModels(vocalInput);
  assert.deepEqual(firstOnly.notes.map((note) => [note.start, note.duration]), [[1.5, .5]]);

  plan.sections[0].activeTracks = [];
  plan.sections[1].activeTracks = ["Voice"]; // legacy persisted name key
  const [legacyNamed] = buildTrackModels(vocalInput);
  assert.deepEqual(legacyNamed.notes.map((note) => [note.start, note.duration]), [[2, .5]]);

  plan.sections[1].activeTracks = [];
  const [fullyInactive] = buildTrackModels(vocalInput);
  assert.equal(fullyInactive.notes.length, 0);

  plan.sections[1].activeTracks = ["Voice"];
  plan.sections[1].tracks.Voice = "none";
  const [operationDisabled] = buildTrackModels(vocalInput);
  assert.equal(operationDisabled.notes.length, 0);
});

test("legacy name-keyed directives remain readable while ID directives control activation and expression", () => {
  const model = song();
  const plan = planFor(model);
  plan.sections[0].activeTracks = ["Piano"]; // old persisted membership
  plan.sections[0].trackDirectives = {
    Piano: {
      register: "high", rhythmicActivity: .2, harmonicActivity: .8,
      dynamicTarget: .9, articulationFamily: "accent",
      entry: { bar: 1, mode: "downbeat" }, exit: { bar: 2, mode: "release" },
      transition: "build", fill: false,
    },
  };
  const [piano, bass] = buildTrackModels({
    songModel: model, plan, style: plan.style, seed: 99,
    tracks: [
      { id: "p", name: "Piano", role: "harmony" },
      { id: "b", name: "Bass", role: "bass" },
    ],
  });
  assert.ok(piano.notes.length > 0);
  assert.equal(bass.notes.length, 0);
  assert.ok(piano.notes[0].velocity > 90); // target + entry influence
  assert.ok(piano.articulations.some((event) => event.name === "hard"));
  assert.ok(piano.notes.some((note) => note.duration < .9)); // exit release
});

test("ID-keyed directive categories produce mapped, audible orchestration changes", () => {
  const model = song({ sections: [
    { name: "Verse", startBar: 1, endBar: 1, energy: .6 },
    { name: "Chorus", startBar: 2, endBar: 2, energy: .8 },
  ] });
  const plan = planFor(model);
  const drums = buildTrackModels({
    songModel: model, plan, style: plan.style, seed: 2,
    tracks: [{ id: "drums", name: "Drums", role: "rhythm" }],
  })[0];
  assert.equal(drums.directive?.rhythmicActivity, plan.sections[0].trackDirectives?.drums.rhythmicActivity);
  assert.equal(drums.mapping?.midiChannel, 9);
  assert.ok(drums.notes.some((note) => note.id.endsWith("-fill")));
  assert.ok(drums.articulations.every((event) => drums.instrumentDefinition.articulations.includes(event.name)));
});

test("performance remains byte/event stable and every generated pitch is playable", () => {
  const model = song();
  const plan = planFor(model, 23);
  const input = {
    songModel: model, plan, style: plan.style, seed: 456,
    tracks: [
      { id: "bass", name: "Bass", role: "bass" },
      { id: "strings", name: "Strings", role: "countermelody" },
      { id: "drums", name: "Drums", role: "rhythm" },
    ],
  };
  const first = buildTrackModels(input);
  const second = buildTrackModels(input);
  assert.deepEqual(first, second);
  for (const track of first) {
    const range = getInstrumentDefinition(track.instrument, track.role).playableRange;
    assert.ok(track.notes.every((note) => note.pitch >= range.min && note.pitch <= range.max));
    assert.ok(track.cc.length > 0);
    assert.equal(track.notes.length, track.articulations.length);
  }
});