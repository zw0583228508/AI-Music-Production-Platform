import assert from "node:assert/strict";
import test from "node:test";
import type { SongModelData } from "@workspace/db";
import {
  buildArrangementBrain,
  buildTrackModels,
  createArrangementPlan,
  createStyleSpec,
  ensureArrangementPlanHierarchy,
  getInstrumentPerformanceCapability,
  getInstrumentDefinition,
  HarmonyEngine,
} from "../src/lib/musicEngines";
import {
  fuseHarmonyEvidence,
  fuseVerifiedBassEvidence,
  parseHarmony,
} from "../src/lib/analysisProviders";
import { fuseProviderSongModels } from "../src/lib/songModelValidation";
import { estimateTruePeak4x } from "../src/lib/audioMeter";

test("4x windowed-sinc true peak meter detects an inter-sample over", () => {
  const samples = Float32Array.from({ length: 128 }, (_, index) =>
    .82 * Math.sin(2 * Math.PI * .47 * index + .38));
  const samplePeak = Math.max(...samples.map(Math.abs));
  const truePeak = estimateTruePeak4x(samples);
  assert.ok(truePeak > samplePeak + .001, `${truePeak} must exceed sample peak ${samplePeak}`);
  assert.ok(Number.isFinite(truePeak) && truePeak < 2);
});

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

test("verified bass fusion preserves stem lineage and resolves pitch conflicts deterministically", () => {
  const bass = fuseVerifiedBassEvidence({
    providerId: "BASIC_PITCH",
    version: "0.4.0",
    confidence: 0.8,
    notes: [{
      start: 1,
      end: 2,
      pitch: 40,
      velocity: 90,
      confidence: 0.75,
      source: "BASIC_PITCH",
    }],
  }, {
    provider: "TORCHCREPE",
    version: "0.0.24",
    sourceStem: "/objects/analysis/project/job/bass.wav",
    frames: [
      { time: 1.1, frequencyHz: 110, midiPitch: 45, periodicity: 0.9, voiced: true, confidence: 0.9 },
      { time: 1.2, frequencyHz: 110, midiPitch: 45, periodicity: 0.9, voiced: true, confidence: 0.9 },
    ],
  }, {
    sourceStem: "/objects/analysis/project/job/bass.wav",
    sourceStemProvider: "BS_ROFORMER",
  });
  assert.equal(bass.length, 1);
  assert.equal(bass[0].pitch, 45);
  assert.equal(bass[0].sourceStemProvider, "BS_ROFORMER");
  assert.deepEqual(bass[0].providers, ["BS_ROFORMER", "TORCHCREPE", "BASIC_PITCH"]);
});

test("verified bass fusion never creates notes without overlapping voiced evidence", () => {
  const bass = fuseVerifiedBassEvidence({
    providerId: "BASIC_PITCH",
    version: "0.4.0",
    confidence: 1,
    notes: [{
      start: 1,
      end: 2,
      pitch: 40,
      velocity: 90,
      confidence: 1,
      source: "BASIC_PITCH",
    }],
  }, {
    provider: "TORCHCREPE",
    version: "0.0.24",
    sourceStem: "/objects/analysis/project/job/bass.wav",
    frames: [
      { time: 1.1, frequencyHz: 0, midiPitch: null, periodicity: 0.1, voiced: false, confidence: 0.1 },
    ],
  }, {
    sourceStem: "/objects/analysis/project/job/bass.wav",
    sourceStemProvider: "BS_ROFORMER",
  });
  assert.deepEqual(bass, []);
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
  const rationale = cadence.at(-1)?.decision?.candidateRationale;
  assert.ok(Array.isArray(rationale));
  assert.ok(rationale.length >= 2);
  assert.equal(rationale.filter((candidate: { selected: boolean }) => candidate.selected).length, 1);
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

test("provider bass evidence survives canonical fusion and changes harmony rationale", () => {
  const bassEvidence = [{
    start: 0,
    end: 2,
    pitch: 67,
    confidence: .95,
    provider: "BASS",
  }];
  const fused = fuseProviderSongModels([{
    provider: "BASS",
    confidence: .95,
    output: {
      ...song({ keyMap: [{ time: 0, key: "C major", confidence: 1 }] }),
      bass: bassEvidence,
    },
  }]);
  assert.equal(fused.accepted, true);
  assert.deepEqual(
    fused.model.bass?.map(({ coordinates: _coordinates, ...event }) => event),
    bassEvidence,
  );
  assert.deepEqual(fused.model.bass?.[0]?.coordinates, {
    start: { seconds: 0, tick: 0, beat: 1, bar: 1, beatInBar: 1, beatFraction: 0 },
    end: { seconds: 2, tick: 3840, beat: 5, bar: 2, beatInBar: 1, beatFraction: 0 },
  });
  const [decision] = new HarmonyEngine().generate(
    fused.model,
    planFor(fused.model, 7, { harmonyComplexity: 8 }),
  );
  assert.ok(Number(decision.decision?.bassFit) > 0);
  const rationale = decision.decision?.candidateRationale as Array<{
    function: string;
    bassFit: number;
  }>;
  assert.ok(rationale.some((candidate) =>
    candidate.function === "V" && candidate.bassFit > 0));
});

test("separate chord and bass providers preserve observed bass support in chord rationale", () => {
  const chordProvider = parseHarmony("SHEETSAGE", {
    version: "1",
    confidence: .9,
    chords: [{ start: 0, end: 2, symbol: "C", roman: "I", confidence: .9 }],
  }, 2);
  const bassProvider = parseHarmony("BASS", {
    version: "1",
    confidence: .95,
    bass: [{ start: 0, end: 2, pitch: 48, confidence: .92 }],
  }, 2);
  const [fusedChord] = fuseHarmonyEvidence([chordProvider, bassProvider]).chords;
  assert.deepEqual(fusedChord.bassSupportEvidence, [{
    start: 0,
    end: 2,
    pitch: 48,
    confidence: .92,
    provider: "BASS",
  }]);
  const [harmony] = new HarmonyEngine().generate(
    song({ chords: [fusedChord], bass: bassProvider.bass.map((note) => ({ ...note, provider: "BASS" })) }),
    planFor(song()),
  );
  assert.deepEqual(harmony.decision?.bassSupportEvidence, fusedChord.bassSupportEvidence);
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

test("arrangement brain establishes a bounded whole-song arc before local planning", () => {
  const model = song({ sections: [
    { name: "Intro", startBar: 1, endBar: 2, energy: .15 },
    { name: "Verse", startBar: 3, endBar: 6, energy: .42 },
    { name: "Pre-Chorus", startBar: 7, endBar: 8, energy: .6 },
    { name: "Chorus", startBar: 9, endBar: 12, energy: .88 },
    { name: "Bridge", startBar: 13, endBar: 14, energy: .3 },
    { name: "Chorus", startBar: 15, endBar: 18, energy: .78 },
    { name: "Outro", startBar: 19, endBar: 20, energy: .35 },
  ] });
  const brain = buildArrangementBrain({ songModel: model, controls: { energy: .7, density: .65 } });
  assert.equal(brain.enabled, true);
  assert.deepEqual(brain.sections.map((section) => section.function),
    ["intro", "verse", "prechorus", "chorus", "bridge", "chorus", "outro"]);
  assert.equal(brain.sections[5].development, "development");
  assert.ok(brain.sections[5].targetEnergy >= brain.sections[3].targetEnergy);
  assert.ok(brain.sections.every((section, index) => index === 0 ||
    Math.abs(section.targetEnergy - brain.sections[index - 1].targetEnergy) <= .28));
  assert.ok(brain.sections.every((section, index) => index === 0 ||
    Math.abs(section.targetDensity - brain.sections[index - 1].targetDensity) <= .18));
  const plan = planFor(model, 9, { energy: .7, density: .65, seed: 44 });
  assert.deepEqual(plan, planFor(model, 9, { energy: .7, density: .65, seed: 44 }));
  assert.ok(plan.sections.every((section, index) => index === 0 ||
    Math.abs((section.activeTracks?.length ?? 0) - (plan.sections[index - 1].activeTracks?.length ?? 0)) <= 1));
  assert.equal(plan.hierarchy.status, "applied");
  assert.deepEqual(plan.hierarchy.precedence, ["song", "section", "phrase", "bar", "event"]);
  assert.equal(plan.hierarchy.song.climaxSectionId, "section:chorus:6");
  assert.equal(plan.hierarchy.sections[5].development, "development");
  assert.ok(plan.hierarchy.sections[4].targetEnergy < plan.hierarchy.sections[5].targetEnergy);
  assert.equal(plan.hierarchy.events.every((event) =>
    plan.hierarchy.sections.some((section) => section.id === event.sectionId) &&
    plan.hierarchy.bars.some((bar) => bar.id === event.barId)), true);
  const allIds = [
    ...plan.hierarchy.sections.map((value) => value.id),
    ...plan.hierarchy.phrases.map((value) => value.id),
    ...plan.hierarchy.bars.map((value) => value.id),
    ...plan.hierarchy.events.map((value) => value.id),
  ];
  assert.equal(new Set(allIds).size, allIds.length);
});

test("hierarchy records reprise, canonical meter, phrases, and vocal-space event precedence", () => {
  const coordinate = (seconds: number, bar: number) => ({
    seconds, tick: seconds * 1920, beat: seconds * 2 + 1, bar, beatInBar: 1, beatFraction: 0,
  });
  const model = song({
    contractVersion: "2.0",
    meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }, { bar: 3, meter: "3/4", confidence: 1 }],
    sections: [
      { name: "Verse", startBar: 1, endBar: 2, energy: .4 },
      { name: "Chorus", startBar: 3, endBar: 4, energy: .8 },
      { name: "Chorus", startBar: 5, endBar: 6, energy: .85 },
      { name: "Chorus", startBar: 7, endBar: 8, energy: .82 },
    ],
    vocalIntelligence: {
      version: "1.0", provenance: null,
      phrases: {
        status: "detected", reason: null,
        events: [{
          id: "lead-1", start: 8, end: 10, confidence: .9,
          coordinates: { start: coordinate(8, 3), end: coordinate(10, 4) },
        }],
      },
      breaths: { status: "not_available", reason: null, events: [] },
      lyricAlignment: { status: "not_available", reason: null, alignments: [] },
      melodyAlignment: { status: "not_available", reason: null, alignments: [] },
      arrangementSpace: {
        status: "detected", reason: null,
        windows: [{
          id: "space-1", start: 10, end: 12, confidence: .9,
          phraseBeforeId: "lead-1", phraseAfterId: null, bars: [4], sections: ["Chorus"],
          coordinates: { start: coordinate(10, 4), end: coordinate(12, 4) },
        }],
      },
    },
  });
  const plan = planFor(model);
  assert.deepEqual(plan.hierarchy.sections.slice(1).map((section) => section.development),
    ["initial", "development", "reprise"]);
  assert.equal(plan.hierarchy.bars.find((bar) => bar.bar === 3)?.meter, "3/4");
  assert.equal(plan.hierarchy.phrases[0].intent, "protect_vocal_phrase");
  assert.equal(plan.hierarchy.bars.find((bar) => bar.bar === 3)?.vocalSpace, "occupied");
  assert.equal(plan.hierarchy.bars.find((bar) => bar.bar === 4)?.vocalSpace, "occupied");
  assert.ok(plan.hierarchy.events.some((event) =>
    event.barId === "bar:section:chorus:2:3" && event.intent === "support_vocal" && event.source === "vocal_phrase"));
});

test("arrangement brain is a neutral no-op for weak observed structure and keeps unusual meters compatible", () => {
  const weak = song({ meterMap: [{ bar: 1, meter: "7/8", confidence: 1 }], sections: [
    { name: "A", startBar: 1, endBar: 1, energy: .5 },
    { name: "B", startBar: 2, endBar: 2, energy: .5 },
  ] });
  const brain = buildArrangementBrain({ songModel: weak, controls: { energy: .7, density: .6 } });
  assert.equal(brain.enabled, false);
  const plan = planFor(weak);
  assert.equal(plan.hierarchy.status, "no_op");
  assert.equal(plan.hierarchy.reason, "insufficient_structural_evidence");
  assert.deepEqual(plan.hierarchy.sections, []);
  assert.deepEqual(plan.sections.map((section) => section.energy), [.5, .5]);
  const vocal = { ...weak, contractVersion: "2.0" as const, vocalEvidence: {
    status: "detected" as const, reason: null, provenance: null, sampleRate: 44_100,
    channels: 1, frameSizeSamples: 1024, thresholds: { rms: .1, peak: .1, activitySample: .1, activityRatio: .1 },
    observedVoicedWindows: [], observedSilentWindows: [],
  } };
  assert.doesNotThrow(() => buildTrackModels({
    songModel: vocal, plan, style: plan.style, seed: 44,
    tracks: [{ id: "piano", name: "Piano", role: "harmony" }],
  }));
});

test("legacy persisted plans are upgraded to an explicit readable no-op hierarchy", () => {
  const current = planFor(song());
  const { hierarchy: _removed, ...legacy } = current;
  const upgraded = ensureArrangementPlanHierarchy(legacy as typeof current);
  assert.equal(upgraded.hierarchy.status, "no_op");
  assert.equal(upgraded.hierarchy.reason, "legacy_plan_without_hierarchy");
  assert.equal(upgraded.hierarchy.song.id, current.id);
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
  assert.equal(piano.appliedDirectives?.[0].directive.register, "middle");
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
  assert.deepEqual(fullyInactive.appliedDirectives, []);

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
  assert.equal(drums.directive, undefined);
  assert.deepEqual(drums.appliedDirectives?.map((item) => item.section), ["verse", "chorus"]);
  assert.equal(drums.appliedDirectives?.[0].directive.rhythmicActivity, plan.sections[0].trackDirectives?.drums.rhythmicActivity);
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
    assert.equal(track.performanceEvidence?.playability.valid, true);
    assert.equal(track.performanceEvidence?.playability.checkedNotes, track.notes.length);
    assert.match(track.performanceEvidence?.performedMaterialSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.match(track.performanceEvidence?.canonicalTimelineSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(track.performanceEvidence?.sectionRanges));
  }
});

test("every supported instrument family declares native performance capabilities", () => {
  const instruments = [
    ["Piano", "harmony"],
    ["Strings", "harmony"],
    ["Brass", "accent"],
    ["Drums", "rhythm"],
    ["Guitar", "harmony"],
    ["Voice", "vocal"],
    ["Synth Pad", "pad"],
  ] as const;
  for (const [name, role] of instruments) {
    const definition = getInstrumentDefinition(name, role);
    const capability = getInstrumentPerformanceCapability(definition);
    assert.equal(capability.family, definition.family);
    assert.ok(capability.nativeRenderers.length > 0);
    assert.ok(capability.articulationProfile);
    assert.ok(capability.timingProfile);
    assert.ok(capability.dynamicsProfile);
  }
});

test("detected canonical vocal occupancy leaves accompaniment space without changing vocals", () => {
  const coordinates = (start: number, end: number) => ({
    start: { seconds: start, tick: start * 1920, beat: start * 2 + 1, bar: 1, beatInBar: 1 },
    end: { seconds: end, tick: end * 1920, beat: end * 2 + 1, bar: 1, beatInBar: 1 },
  });
  const base = song({
    contractVersion: "2.0",
    melody: [{ start: .25, end: 1.75, pitch: 69, velocity: .8, confidence: .9, source: "provider" }],
    sections: [
      { name: "Verse", startBar: 1, endBar: 1, energy: .55 },
      { name: "Chorus", startBar: 2, endBar: 2, energy: .8 },
    ],
  });
  const detected = {
    ...base,
    vocalEvidence: {
      status: "detected" as const,
      reason: null,
      provenance: null,
      sampleRate: 44_100,
      channels: 1,
      frameSizeSamples: 1024,
      thresholds: { rms: .1, peak: .1, activitySample: .1, activityRatio: .1 },
      observedVoicedWindows: [{ start: .25, end: 1.75, coordinates: coordinates(.25, 1.75) }],
      observedSilentWindows: [{ start: 1.75, end: 4, coordinates: coordinates(1.75, 4) }],
    },
    vocalIntelligence: {
      version: "1.0" as const,
      provenance: null,
      phrases: {
        status: "detected" as const,
        reason: null,
        events: [{
          id: "phrase-1", start: .25, end: 1.75, confidence: .95,
          coordinates: coordinates(.25, 1.75),
        }],
      },
      breaths: { status: "not_available" as const, reason: null, events: [] },
      lyricAlignment: { status: "not_available" as const, reason: null, alignments: [] },
      melodyAlignment: { status: "not_available" as const, reason: null, alignments: [] },
      arrangementSpace: {
        status: "detected" as const,
        reason: null,
        windows: [{
          id: "space-1", start: 1.75, end: 4, confidence: .9,
          phraseBeforeId: "phrase-1", phraseAfterId: null,
          bars: [1], sections: ["Verse"], coordinates: coordinates(1.75, 4),
        }],
      },
    },
  };
  const tracks = [
    { id: "piano", name: "Piano", role: "harmony" },
    { id: "drums", name: "Drums", role: "rhythm" },
    { id: "voice", name: "Voice", role: "vocal" },
  ];
  const baselinePlan = planFor(base);
  baselinePlan.sections[0].activeTracks = tracks.map((track) => track.id);
  const detectedPlan = planFor(detected);
  detectedPlan.sections[0].activeTracks = tracks.map((track) => track.id);
  const input = (songModel: SongModelData, plan: ReturnType<typeof planFor>) => ({
    songModel, plan, style: plan.style, tracks, seed: 81,
  });
  const baseline = buildTrackModels(input(base, baselinePlan));
  const first = buildTrackModels(input(detected, detectedPlan));
  const second = buildTrackModels(input(detected, detectedPlan));
  const localOverridePlan = structuredClone(detectedPlan);
  localOverridePlan.hierarchy.events = localOverridePlan.hierarchy.events.map((event) => ({
    ...event,
    intent: event.intent === "support_vocal" ? "follow_section" : event.intent,
    source: event.source === "vocal_phrase" ? "section" : event.source,
  }));
  const locallyAllowed = buildTrackModels(input(detected, localOverridePlan));
  const overlaps = (models: typeof first) => models
    .filter((track) => track.id !== "voice")
    .flatMap((track) => track.notes)
    .filter((note) => note.start < 1.75 && note.start + note.duration > .25).length;
  assert.ok(overlaps(first) < overlaps(baseline));
  assert.equal(overlaps(first), 0);
  assert.ok(overlaps(locallyAllowed) > overlaps(first));
  assert.deepEqual(first.find((track) => track.id === "voice")?.notes,
    baseline.find((track) => track.id === "voice")?.notes);
  assert.deepEqual(locallyAllowed.find((track) => track.id === "voice")?.notes,
    first.find((track) => track.id === "voice")?.notes);
  assert.deepEqual(first, second);
});

test("vocal space mapping is a no-op without detected canonical v2 observations", () => {
  const coordinates = {
    start: { seconds: 0, tick: 0, beat: 1, bar: 1, beatInBar: 1 },
    end: { seconds: 1, tick: 1920, beat: 3, bar: 1, beatInBar: 3 },
  };
  const model = song({ contractVersion: "2.0" });
  const unavailable = {
    ...model,
    vocalEvidence: {
      status: "low_confidence" as const, reason: "weak stem", provenance: null,
      sampleRate: null, channels: null, frameSizeSamples: null, thresholds: null,
      observedVoicedWindows: [{ start: 0, end: 1, coordinates }],
      observedSilentWindows: [],
    },
  };
  const tracks = [{ id: "piano", name: "Piano", role: "harmony" }];
  const plainPlan = planFor(model);
  const unavailablePlan = planFor(unavailable);
  assert.deepEqual(
    buildTrackModels({ songModel: model, plan: plainPlan, style: plainPlan.style, tracks, seed: 12 }),
    buildTrackModels({ songModel: unavailable, plan: unavailablePlan, style: unavailablePlan.style, tracks, seed: 12 }),
  );
});

test("canonical vocal windows clip independently at unusual-meter section boundaries", () => {
  const coordinate = (seconds: number, tick: number, bar: number) => ({
    seconds, tick, beat: tick / 960 + 1, bar, beatInBar: 1,
  });
  const model = song({
    contractVersion: "2.0",
    meterMap: [{ bar: 1, meter: "7/8", confidence: 1 }],
    sections: [
      { name: "A", startBar: 1, endBar: 1, energy: .7 },
      { name: "B", startBar: 2, endBar: 2, energy: .7 },
    ],
    vocalEvidence: {
      status: "detected", reason: null, provenance: null, sampleRate: 44_100,
      channels: 1, frameSizeSamples: 1024,
      thresholds: { rms: .1, peak: .1, activitySample: .1, activityRatio: .1 },
      // 120 BPM 7/8 bars are 1.75 seconds. This observation crosses, rather
      // than assumes, that non-4/4 arrangement boundary.
      observedVoicedWindows: [{
        start: 1.7, end: 1.8,
        coordinates: { start: coordinate(1.7, 3264, 1), end: coordinate(1.8, 3456, 2) },
      }],
      observedSilentWindows: [{
        start: 0, end: 1.7,
        coordinates: { start: coordinate(0, 0, 1), end: coordinate(1.7, 3264, 1) },
      }],
    },
  });
  const plan = planFor(model);
  plan.sections[0].activeTracks = ["piano"];
  plan.sections[1].activeTracks = ["piano"];
  const [piano] = buildTrackModels({
    songModel: model, plan, style: plan.style, seed: 4,
    tracks: [{ id: "piano", name: "Piano", role: "harmony" }],
  });
  assert.equal(piano.notes.some((note) => note.start < 1.8 && note.start + note.duration > 1.7), false);
  assert.ok(piano.notes.some((note) => note.start < 1.7)); // observed silence remains usable
});