import assert from "node:assert/strict";
import test from "node:test";
import type { SongModelData } from "@workspace/db";
import {
  buildArrangementBrain,
  buildTrackModels,
  canonicalMotifFingerprint,
  applyCompositionIntelligence,
  createArrangementPlan,
  createStyleSpec,
  ensureArrangementPlanHierarchy,
  getInstrumentPerformanceCapability,
  getInstrumentDefinition,
  measureVoicingMotion,
  performedMaterialSha256,
  HarmonyEngine,
} from "../src/lib/musicEngines";
import {
  fuseHarmonyEvidence,
  fuseVerifiedBassEvidence,
  parseHarmony,
} from "../src/lib/analysisProviders";
import { fuseProviderSongModels } from "../src/lib/songModelValidation";
import { estimateTruePeak4x } from "../src/lib/audioMeter";
import { repeatedFormSongModel } from "../src/lib/__fixtures__/songModelValidation";

test("4x windowed-sinc true peak meter detects an inter-sample over", () => {
  const samples = Float32Array.from({ length: 128 }, (_, index) =>
    .82 * Math.sin(2 * Math.PI * .47 * index + .38));
  const samplePeak = Math.max(...samples.map(Math.abs));
  const truePeak = estimateTruePeak4x(samples);
  assert.ok(truePeak > samplePeak + .001, `${truePeak} must exceed sample peak ${samplePeak}`);
  assert.ok(Number.isFinite(truePeak) && truePeak < 2);
});

test("style grammar and approved producer preferences alter later TrackModels reproducibly", () => {
  const model = song({
    contractVersion: "2.0",
    sections: [
      { name: "Verse", startBar: 1, endBar: 4, energy: .6 },
      { name: "Chorus", startBar: 5, endBar: 8, energy: .75 },
    ],
  });
  const tracks = [
    { id: "drums", name: "Drums", role: "rhythm" },
    { id: "bass", name: "Bass", role: "foundation" },
    { id: "piano", name: "Piano", role: "harmony" },
    { id: "strings", name: "Strings", role: "counterline" },
  ];
  const preference = (version: number, direction: "restrained" | "progressive") => ({
    contractVersion: "1.0" as const,
    calibrationId: `calibration-${version}`,
    calibrationVersion: version,
    heldOutAgreement: .8,
    baselineAgreement: .7,
    heldOutExamples: 6,
    evaluationSha256: direction === "progressive" ? "c".repeat(64) : "d".repeat(64),
    evidenceSha256: direction === "progressive" ? "a".repeat(64) : "b".repeat(64),
    effects: direction === "progressive"
      ? {
          orchestrationDensity: .18, responseFrequency: .75,
          roleEmphasis: "counterline" as const, voicingCharacter: "wide" as const,
          development: "progressive" as const, transitionIntensity: .75,
        }
      : {
          orchestrationDensity: -.18, responseFrequency: .25,
          roleEmphasis: "foundation" as const, voicingCharacter: "close" as const,
          development: "restrained" as const, transitionIntensity: .25,
        },
  });
  const materialize = (
    styleName: string,
    approvedPreference: ReturnType<typeof preference>,
  ) => {
    const style = createStyleSpec(styleName, {
      density: .35, harmonyComplexity: 6, energy: .6,
      orchestraSize: .35, rhythmIntensity: .7,
    }, approvedPreference);
    const plan = createArrangementPlan({
      arrangementId: "grammar-preference-regression",
      version: 2,
      songModel: model,
      style,
      tracks,
      parameters: {
        seed: 9182, songModelVersion: 3, density: .35, energy: .6,
        orchestraSize: .35, rhythmIntensity: .7, styleGrammarVersion: "1.0",
      },
      compositionVersion: "2.0",
      generationPreference: approvedPreference,
    });
    return {
      style,
      plan,
      models: buildTrackModels({ songModel: model, plan, tracks, style, seed: 9182 }),
    };
  };

  const jazz = materialize("jazz quartet", preference(1, "restrained"));
  const repeatedJazz = materialize("jazz quartet", preference(1, "restrained"));
  const electronic = materialize("electronic house", preference(1, "restrained"));
  const preferred = materialize("jazz quartet", preference(2, "progressive"));

  assert.equal(jazz.style.grammar?.version, "1.0");
  assert.equal(jazz.style.grammar?.vocabulary.groove, "swung");
  assert.equal(electronic.style.grammar?.vocabulary.groove, "four_on_floor");
  assert.notDeepEqual(jazz.style.grammar?.vocabulary, electronic.style.grammar?.vocabulary);
  assert.deepEqual(jazz.models, repeatedJazz.models);
  assert.notDeepEqual(
    jazz.models.map((track) => track.notes),
    electronic.models.map((track) => track.notes),
  );
  assert.notDeepEqual(
    jazz.models.map((track) => track.notes),
    preferred.models.map((track) => track.notes),
  );
  assert.notDeepEqual(jazz.plan.sections, preferred.plan.sections);
  assert.equal(preferred.plan.generationPreference?.calibrationVersion, 2);
  assert.equal(
    preferred.plan.provenance.parameters.generationPreferenceEvidenceSha256,
    preference(2, "progressive").evidenceSha256,
  );
  assert.equal(
    preferred.plan.provenance.parameters.styleGrammarEvidenceSha256,
    preferred.style.grammar?.evidenceSha256,
  );

  const semanticMaterialize = (
    vocabulary: NonNullable<typeof jazz.style.grammar>["vocabulary"],
    approvedPreference: Parameters<typeof createStyleSpec>[2] =
      preference(1, "restrained"),
  ) => {
    const style = structuredClone(jazz.style);
    style.grammar = {
      version: "1.0",
      // Deliberately fixed so each assertion proves semantic consumption
      // rather than a different performance seed.
      evidenceSha256: "f".repeat(64),
      vocabulary,
    };
    style.harmony.voicing = vocabulary.voicing;
    const plan = createArrangementPlan({
      arrangementId: "isolated-grammar-sensitivity",
      version: 1,
      songModel: model,
      style,
      tracks,
      parameters: {
        seed: 9182, songModelVersion: 3, density: .35, energy: .6,
        orchestraSize: .35, rhythmIntensity: .7, styleGrammarVersion: "1.0",
      },
      compositionVersion: "2.0",
      generationPreference: approvedPreference,
    });
    return buildTrackModels({ songModel: model, plan, tracks, style, seed: 9182 });
  };
  const grammarBaseline = {
    ...jazz.style.grammar!.vocabulary,
    voicing: "close" as const,
  };
  const grammarVariants = [
    { key: "groove", value: "straight" },
    { key: "voicing", value: "wide" },
    { key: "articulation", value: "legato" },
    { key: "instrumentation", value: "electronic" },
    { key: "phraseBehavior", value: "continuous" },
    { key: "fills", value: "none" },
    { key: "transitions", value: "riser" },
    { key: "development", value: "repetition" },
  ] as const;
  const baselineModels = semanticMaterialize(grammarBaseline, null);
  for (const variant of grammarVariants) {
    assert.notDeepEqual(
      semanticMaterialize(
        { ...grammarBaseline, [variant.key]: variant.value },
        null,
      ),
      baselineModels,
      `${variant.key} must alter generated TrackModels`,
    );
  }

  const preferenceBaseline = preference(1, "restrained");
  const preferenceVariants = [
    { orchestrationDensity: .18 },
    { responseFrequency: .75 },
    { roleEmphasis: "counterline" as const },
    { voicingCharacter: "wide" as const },
    { development: "progressive" as const },
    { transitionIntensity: .75 },
  ];
  const preferenceBaselineModels = semanticMaterialize(
    grammarBaseline,
    preferenceBaseline,
  );
  for (const effects of preferenceVariants) {
    const variant = {
      ...preferenceBaseline,
      effects: { ...preferenceBaseline.effects, ...effects },
    };
    assert.notDeepEqual(
      semanticMaterialize(grammarBaseline, variant),
      preferenceBaselineModels,
      `${Object.keys(effects)[0]} must alter generated TrackModels`,
    );
  }
});

test("historical v2 fill directives preserve their original drum vocabulary", () => {
  const model = song({
    contractVersion: "2.0",
    sections: [
      { name: "A", startBar: 1, endBar: 2, energy: .7 },
      { name: "B", startBar: 3, endBar: 4, energy: .7 },
    ],
  });
  const historicalStyle = createStyleSpec("pop", {
    density: .7, harmonyComplexity: 5, energy: .7, rhythmIntensity: .7,
  });
  delete historicalStyle.grammar;
  const plan = createArrangementPlan({
    arrangementId: "historical-fill-replay",
    version: 1,
    songModel: model,
    style: historicalStyle,
    tracks: [{ id: "drums", name: "Drums", role: "rhythm" }],
    parameters: {
      seed: 44, songModelVersion: 2, density: .7, energy: .7,
      orchestraSize: 1, rhythmIntensity: .7,
    },
    compositionVersion: "2.0",
  });
  plan.sections[0].activeTracks = ["drums"];
  plan.sections[0].trackDirectives!.drums.fill = true;
  const [drums] = buildTrackModels({
    songModel: model,
    plan,
    tracks: [{ id: "drums", name: "Drums", role: "rhythm" }],
    style: historicalStyle,
    seed: 44,
  });
  assert.deepEqual(
    drums.notes.slice(0, 4).map((note) => note.pitch),
    [72, 66, 74, 66],
  );
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

const planFor = (
  model: SongModelData,
  version = 7,
  controls: Record<string, number> = {},
  styleGrammarVersion?: "1.0",
  compositionVersion?: "2.0",
) => createArrangementPlan({
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
  parameters: { songModelVersion: version, ...controls, styleGrammarVersion },
  compositionVersion,
});

test("Composition Intelligence v2 reuses motifs and changes performed events reproducibly", () => {
  const model = song({
    audio: {
      ...song().audio,
      durationSeconds: repeatedFormSongModel.audio.durationSeconds,
      analysisDurationSeconds: repeatedFormSongModel.audio.durationSeconds,
    },
    sections: repeatedFormSongModel.sections,
    energy: repeatedFormSongModel.energy,
    chords: [{ start: 0, end: 32, symbol: "C", roman: "I", confidence: .9 }],
  });
  const style = createStyleSpec("cinematic pop", {
    density: .65, harmonyComplexity: 6, energy: .7,
  });
  const tracks = [
    { id: "piano", name: "Piano", role: "harmony" },
    { id: "drums", name: "Drums", role: "rhythm" },
  ];
  const create = (compositionVersion: "1.0" | "2.0") => createArrangementPlan({
    arrangementId: "composition-v2-fixture",
    version: 1,
    songModel: model,
    style,
    tracks,
    parameters: { songModelVersion: 12, seed: 4401, energy: .7, density: .65 },
    compositionVersion,
  });
  const legacy = create("1.0");
  const v2 = create("2.0");
  const firstChorus = v2.compositionIntelligence!.phrases.find((phrase) =>
    phrase.sectionId === v2.hierarchy.sections[1].id)!;
  const repeatedChorus = v2.compositionIntelligence!.phrases.find((phrase) =>
    phrase.sectionId === v2.hierarchy.sections[3].id)!;

  assert.equal(v2.compositionIntelligence?.mode, "reasoning_core");
  assert.equal(v2.provenance.version, "2.0.0");
  assert.equal(repeatedChorus.sourceMotifRef, firstChorus.motifRef);
  assert.notEqual(repeatedChorus.motifRef, firstChorus.motifRef);
  assert.equal(v2.compositionIntelligence?.instrumentRoles.find((role) =>
    role.trackId === "drums")?.function, "pulse");

  const materialize = (plan: ReturnType<typeof create>) => buildTrackModels({
    songModel: model, plan, tracks, style, seed: 4401,
  });
  const first = materialize(v2);
  const second = materialize(create("2.0"));
  const old = materialize(legacy);
  const historical = structuredClone(legacy);
  delete historical.compositionIntelligence;
  const historicalOutput = materialize(historical);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first.map((track) => track.notes), old.map((track) => track.notes));
  assert.deepEqual(historicalOutput.map((track) => track.notes), old.map((track) => track.notes));
  assert.equal(old[0].provenance.parameters.compositionVersion, "1.0");
  assert.equal(first[0].provenance.parameters.compositionVersion, "2.0");
  assert.equal(first[0].provenance.parameters.compositionSeed, 4401);
  assert.equal(first[0].performanceEvidence?.compositionSeed, 4401);
  assert.equal(
    first[0].performanceEvidence?.performanceSeed,
    first[0].performanceEvidence?.seed,
  );

  const arcVariant = structuredClone(v2);
  const finalSectionId = arcVariant.hierarchy.sections[3].id;
  const finalArc = arcVariant.compositionIntelligence!.tensionRelease.find((arc) =>
    arc.sectionId === finalSectionId)!;
  finalArc.tension = Math.max(0, finalArc.tension - .3);
  const varied = materialize(arcVariant);
  const finalSectionStart = 24;
  assert.deepEqual(
    varied.map((track) => track.notes.filter((note) => note.start < finalSectionStart)),
    first.map((track) => track.notes.filter((note) => note.start < finalSectionStart)),
  );
  assert.notDeepEqual(
    varied.map((track) => track.notes.filter((note) => note.start >= finalSectionStart)),
    first.map((track) => track.notes.filter((note) => note.start >= finalSectionStart)),
  );

  assert.throws(() => buildTrackModels({
    songModel: model, plan: v2, tracks, style, seed: 4402,
  }), /seed does not match/);
  const changedEvidence = structuredClone(model);
  changedEvidence.chords[0].symbol = "Dm";
  assert.throws(() => buildTrackModels({
    songModel: changedEvidence, plan: v2, tracks, style, seed: 4401,
  }), /evidence does not match/);
  for (const mutate of [
    (value: SongModelData) => { value.energy = [.01]; },
    (value: SongModelData) => { value.bars = [{ bar: 1, start: 0, end: 2, beats: 4, confidence: 1 }]; },
    (value: SongModelData) => { value.beats = [{ time: 0, beat: 1, bar: 1, confidence: 1 }]; },
    (value: SongModelData) => { value.audio.name = "different-source.wav"; },
  ]) {
    const altered = structuredClone(model);
    mutate(altered);
    assert.throws(() => buildTrackModels({
      songModel: altered, plan: v2, tracks, style, seed: 4401,
    }), /evidence does not match/);
  }

  const phrasePlan = structuredClone(v2);
  const firstSection = phrasePlan.hierarchy.sections[0];
  phrasePlan.compositionIntelligence!.phrases =
    phrasePlan.compositionIntelligence!.phrases.filter((phrase) =>
      phrase.sectionId !== firstSection.id);
  phrasePlan.compositionIntelligence!.phrases.push(
    {
      id: "phrase:first",
      sectionId: firstSection.id,
      startBar: 1,
      endBar: 2,
      intent: "state",
      tension: .1,
      motifRef: "motif:first",
      sourceMotifRef: null,
    },
    {
      id: "phrase:second",
      sectionId: firstSection.id,
      startBar: 3,
      endBar: 4,
      intent: "answer",
      tension: .8,
      motifRef: "motif:second",
      sourceMotifRef: "motif:first",
    },
  );
  const phraseVariant = structuredClone(phrasePlan);
  phraseVariant.compositionIntelligence!.phrases.find((phrase) =>
    phrase.id === "phrase:second")!.tension = .2;
  const phraseOutput = materialize(phrasePlan);
  const phraseVariantOutput = materialize(phraseVariant);
  assert.deepEqual(
    phraseOutput.map((track) => track.notes.filter((note) => note.start < 3.5)),
    phraseVariantOutput.map((track) => track.notes.filter((note) => note.start < 3.5)),
  );
  assert.notDeepEqual(
    phraseOutput.map((track) => track.notes.filter((note) => note.start >= 3.9 && note.start < 8)),
    phraseVariantOutput.map((track) => track.notes.filter((note) => note.start >= 3.9 && note.start < 8)),
  );

  const providerReasoned = applyCompositionIntelligence(old, v2, model);
  assert.ok(providerReasoned.every((track) =>
    track.source === "COMPOSITION_INTELLIGENCE" &&
    track.provenance.parameters.compositionEvidenceSha256 ===
      v2.compositionIntelligence!.evidenceSha256));
  assert.ok(providerReasoned.every((track) =>
    track.performanceEvidence?.performedMaterialSha256 === performedMaterialSha256(track)));
  assert.notDeepEqual(
    providerReasoned.map((track) => track.notes),
    old.map((track) => track.notes),
  );
  assert.throws(
    () => applyCompositionIntelligence(old, v2, changedEvidence),
    /evidence does not match/,
  );
});

test("canonical motif fingerprints retain rhythmic and interval identity across transposition", () => {
  const source = [
    { start: 1, duration: .25, pitch: 60 },
    { start: 1.5, duration: .5, pitch: 64 },
    { start: 2.25, duration: .25, pitch: 67 },
  ];
  assert.equal(canonicalMotifFingerprint(source), canonicalMotifFingerprint(
    source.map((note) => ({ ...note, start: note.start + 12, pitch: note.pitch + 7 })),
  ));
  assert.notEqual(canonicalMotifFingerprint(source), canonicalMotifFingerprint(
    source.map((note, index) => ({ ...note, duration: index === 1 ? .25 : note.duration })),
  ));
});

test("shared groove coordinates bass and drums across phrase boundaries without mechanical unison", () => {
  const model = song({
    contractVersion: "2.0",
    timebase: { ppq: 960, originSeconds: 0, coordinateSystem: "seconds+ticks" },
    bars: Array.from({ length: 8 }, (_, index) => ({
      bar: index + 1, start: index * 2, end: (index + 1) * 2, beats: 4, confidence: 1,
    })),
    sections: [
      { name: "Verse", startBar: 1, endBar: 4, energy: .5 },
      { name: "Chorus", startBar: 5, endBar: 8, energy: .9 },
    ],
    energy: [.5, .9],
    chords: [{ start: 0, end: 16, symbol: "C", roman: "I", confidence: .9 }],
  });
  const tracks = [
    { id: "bass", name: "Bass", role: "bass" },
    { id: "drums", name: "Drums", role: "rhythm" },
    { id: "piano", name: "Piano", role: "harmony" },
  ];
  const create = () => createArrangementPlan({
    arrangementId: "groove-plan",
    version: 1,
    songModel: model,
    style: createStyleSpec("pop", { density: .7, harmonyComplexity: 5, energy: .8 }),
    tracks,
    parameters: {
      songModelVersion: 3,
      seed: 991,
      energy: .8,
      density: .7,
      rhythmIntensity: .8,
      styleGrammarVersion: "1.0",
    },
    compositionVersion: "2.0",
  });
  const firstPlan = create();
  const secondPlan = create();
  const groove = firstPlan.compositionIntelligence!.groove!;
  assert.deepEqual(groove, secondPlan.compositionIntelligence!.groove);
  assert.equal(groove.version, "1.0");
  assert.ok(groove.roles.some((role) => role.trackId === "bass" && role.responsibility === "foundation"));
  assert.ok(groove.roles.some((role) => role.trackId === "drums" && role.responsibility === "pulse"));
  assert.ok(groove.events.some((event) => event.gesture === "push" || event.gesture === "anticipation" || event.gesture === "fill"));
  assert.ok(groove.events.every((event) =>
    event.coordinate.tick >= 0 && event.coordinate.bar >= 1 && event.durationTicks > 0));

  const outputs = buildTrackModels({
    songModel: model, plan: firstPlan, tracks, style: firstPlan.style, seed: 991,
  });
  for (const trackId of ["bass", "drums"]) {
    const output = outputs.find((track) => track.id === trackId)!;
    const events = groove.events.filter((event) => event.trackId === trackId);
    const eventById = new Map(events.map((event) => [event.id, event]));
    assert.ok(output.notes.every((note) =>
      eventById.has(note.id) || note.motif?.intention === "response"),
    "grammar must not add fallback events outside the coordinated schedule");
    assert.ok(output.notes.every((note, index, notes) =>
      index === 0 || note.start >= notes[index - 1].start),
    "grammar must preserve canonical event order");
    assert.ok(output.notes.every((note) => {
      const event = eventById.get(note.id)!;
      const section = firstPlan.hierarchy.sections.find((candidate) =>
        candidate.id === event.sectionId)!;
      return note.start >= (section.startBar - 1) * 2 &&
        note.start < section.endBar * 2;
    }), "grammar must keep each coordinated event inside its source section");
  }
  const bassStarts = outputs.find((track) => track.id === "bass")!.notes.map((note) => note.start);
  const drumStarts = outputs.find((track) => track.id === "drums")!.notes.map((note) => note.start);
  const shared = drumStarts.filter((start) =>
    bassStarts.some((bassStart) => Math.abs(bassStart - start) <= .025)).length;
  const independentBass = bassStarts.filter((start) =>
    !drumStarts.some((drumStart) => Math.abs(drumStart - start) <= .025)).length;
  assert.ok(shared > 0, "shared accents should coordinate bass and drums");
  assert.ok(shared < drumStarts.length, "coordination must not collapse into mechanical unison");
  assert.ok(independentBass > 0, "bass must retain complementary motion outside the drum pulse");
  assert.deepEqual(outputs, buildTrackModels({
    songModel: model, plan: secondPlan, tracks, style: secondPlan.style, seed: 991,
  }));
});

test("shared groove selects fills from observed vocal space and breaks for release sections", () => {
  const base = song();
  const model = song({
    contractVersion: "2.0",
    timebase: { ppq: 960, originSeconds: 0, coordinateSystem: "seconds+ticks" },
    audio: { ...base.audio, durationSeconds: 12, analysisDurationSeconds: 12 },
    bars: Array.from({ length: 6 }, (_, index) => ({
      bar: index + 1, start: index * 2, end: (index + 1) * 2, beats: 4, confidence: 1,
    })),
    sections: [
      { name: "Chorus", startBar: 1, endBar: 4, energy: .9 },
      { name: "Outro", startBar: 5, endBar: 6, energy: .3 },
    ],
    energy: [.9, .3],
    vocalEvidence: {
      status: "detected",
      reason: null,
      provenance: null,
      sampleRate: 44_100,
      channels: 1,
      frameSizeSamples: 1024,
      thresholds: { rms: .1, peak: .1, activitySample: .1, activityRatio: .1 },
      observedVoicedWindows: [{
        start: 6,
        end: 7,
        coordinates: {
          start: { seconds: 6, tick: 11_520, beat: 13, bar: 4, beatInBar: 1, beatFraction: 0 },
          end: { seconds: 7, tick: 13_440, beat: 15, bar: 4, beatInBar: 3, beatFraction: 0 },
        },
      }],
      observedSilentWindows: [{
        start: 7.1,
        end: 7.4,
        coordinates: {
          start: { seconds: 7.1, tick: 13_632, beat: 15, bar: 4, beatInBar: 3, beatFraction: .2 },
          end: { seconds: 7.4, tick: 14_208, beat: 15, bar: 4, beatInBar: 3, beatFraction: .8 },
        },
      }],
    },
    vocalIntelligence: {
      version: "1.0",
      provenance: null,
      phrases: { status: "not_available", reason: "fixture", events: [] },
      breaths: { status: "not_available", reason: "fixture", events: [] },
      lyricAlignment: { status: "not_available", reason: "fixture", alignments: [] },
      melodyAlignment: { status: "not_available", reason: "fixture", alignments: [] },
      arrangementSpace: {
        status: "detected",
        reason: null,
        windows: [{
          id: "chorus-end-space",
          start: 7.1,
          end: 7.4,
          confidence: .95,
          phraseBeforeId: null,
          phraseAfterId: null,
          bars: [4],
          sections: ["Chorus"],
          coordinates: {
            start: { seconds: 7.1, tick: 13_632, beat: 15, bar: 4, beatInBar: 3, beatFraction: .2 },
            end: { seconds: 7.4, tick: 14_208, beat: 15, bar: 4, beatInBar: 3, beatFraction: .8 },
          },
        }],
      },
    },
  });
  const tracks = [
    { id: "bass", name: "Bass", role: "bass" },
    { id: "drums", name: "Drums", role: "rhythm" },
  ];
  const plan = createArrangementPlan({
    arrangementId: "groove-boundaries",
    version: 1,
    songModel: model,
    style: createStyleSpec("pop", { density: .7, harmonyComplexity: 5, energy: .75 }),
    tracks,
    parameters: { songModelVersion: 4, seed: 122, energy: .75, density: .7, rhythmIntensity: .8 },
    compositionVersion: "2.0",
  });
  const events = plan.compositionIntelligence!.groove!.events;
  const fills = events.filter((event) => event.trackId === "drums" && event.gesture === "fill");
  assert.ok(fills.length);
  assert.ok(fills.every((event) => event.coordinate.seconds >= 7.1 &&
    event.coordinate.seconds + event.durationTicks * 60 / (120 * 960) <= 7.4));
  assert.ok(events.some((event) => event.gesture === "break"));
  assert.equal(new Set(events.map((event) =>
    `${event.trackId}:${event.coordinate.tick}`)).size, events.length);
  const output = buildTrackModels({
    songModel: model, plan, tracks, style: plan.style, seed: 122,
  });
  assert.ok(output.flatMap((track) => track.notes).every((note) =>
    !(note.start < 7 && note.start + note.duration > 6)));
});

test("shared groove follows canonical tempo and meter changes with explicit overlap precedence", () => {
  const model = song({
    contractVersion: "2.0",
    timebase: { ppq: 960, originSeconds: 0, coordinateSystem: "seconds+ticks" },
    tempoMap: [
      { time: 0, bpm: 120, confidence: 1 },
      { time: 4, bpm: 60, confidence: 1 },
    ],
    meterMap: [
      { bar: 1, meter: "4/4", confidence: 1 },
      { bar: 3, meter: "6/8", confidence: 1 },
    ],
    bars: [
      { bar: 1, start: 0, end: 2, beats: 4, confidence: 1 },
      { bar: 2, start: 2, end: 4, beats: 4, confidence: 1 },
      { bar: 3, start: 4, end: 7, beats: 6, confidence: 1 },
      { bar: 4, start: 7, end: 10, beats: 6, confidence: 1 },
    ],
    sections: [
      { name: "Verse", startBar: 1, endBar: 2, energy: .5 },
      { name: "Chorus", startBar: 3, endBar: 4, energy: .85 },
    ],
    energy: [.5, .85],
    vocalIntelligence: {
      version: "1.0",
      provenance: null,
      phrases: {
        status: "detected",
        reason: null,
        events: [
          {
            id: "wide", start: 4, end: 10, confidence: .9,
            coordinates: {
              start: { seconds: 4, tick: 7680, beat: 9, bar: 3, beatInBar: 1, beatFraction: 0 },
              end: { seconds: 10, tick: 19200, beat: 21, bar: 5, beatInBar: 1, beatFraction: 0 },
            },
          },
          {
            id: "narrow", start: 4, end: 6.5, confidence: .9,
            coordinates: {
              start: { seconds: 4, tick: 7680, beat: 9, bar: 3, beatInBar: 1, beatFraction: 0 },
              end: { seconds: 6.5, tick: 12480, beat: 14, bar: 3, beatInBar: 6, beatFraction: 0 },
            },
          },
        ],
      },
      breaths: { status: "not_available", reason: "fixture", events: [] },
      lyricAlignment: { status: "not_available", reason: "fixture", alignments: [] },
      melodyAlignment: { status: "not_available", reason: "fixture", alignments: [] },
      arrangementSpace: { status: "not_available", reason: "fixture", windows: [] },
    },
  });
  const tracks = [
    { id: "bass", name: "Bass", role: "bass" },
    { id: "drums", name: "Drums", role: "rhythm" },
  ];
  const plan = createArrangementPlan({
    arrangementId: "mixed-meter-groove",
    version: 1,
    songModel: model,
    style: createStyleSpec("pop", { density: .7, harmonyComplexity: 5, energy: .75 }),
    tracks,
    parameters: { songModelVersion: 5, seed: 811, energy: .75, density: .7 },
    compositionVersion: "2.0",
  });
  const events = plan.compositionIntelligence!.groove!.events;
  assert.ok(events.some((event) => event.coordinate.bar === 3 &&
    event.coordinate.beatInBar === 6));
  assert.equal(events.find((event) => event.coordinate.tick === 7680)?.coordinate.seconds, 4);
  assert.ok(events.filter((event) => event.coordinate.bar === 3)
    .every((event) => event.phraseId.endsWith(":narrow")));
  assert.deepEqual(buildTrackModels({
    songModel: model, plan, tracks, style: plan.style, seed: 811,
  }), buildTrackModels({
    songModel: model, plan, tracks, style: plan.style, seed: 811,
  }));
});

test("multi-bar answer phrases place a deterministic pickup before phrase entry", () => {
  const model = song({
    sections: [
      { name: "Verse", startBar: 1, endBar: 2, energy: .5 },
      { name: "Chorus", startBar: 3, endBar: 4, energy: .8 },
      { name: "Verse", startBar: 5, endBar: 6, energy: .55 },
      { name: "Chorus", startBar: 7, endBar: 8, energy: .86 },
      { name: "Verse", startBar: 9, endBar: 10, energy: .5 },
      { name: "Chorus", startBar: 11, endBar: 14, energy: .9 },
    ],
    energy: [.5, .8, .55, .86, .5, .9],
  });
  const tracks = [
    { id: "bass", name: "Bass", role: "bass" },
    { id: "drums", name: "Drums", role: "rhythm" },
  ];
  const plan = createArrangementPlan({
    arrangementId: "answer-pickup",
    version: 1,
    songModel: model,
    style: createStyleSpec("pop", { density: .7, harmonyComplexity: 5, energy: .8 }),
    tracks,
    parameters: { songModelVersion: 8, seed: 411, energy: .8, density: .7 },
    compositionVersion: "2.0",
  });
  const finalSection = plan.hierarchy.sections[5];
  const answer = plan.compositionIntelligence!.phrases.find((phrase) =>
    phrase.sectionId === finalSection.id)!;
  assert.equal(answer.intent, "answer");
  assert.ok(answer.endBar > answer.startBar);
  const phraseStartTick = (answer.startBar - 1) * 4 * 960;
  const pickups = plan.compositionIntelligence!.groove!.events.filter((event) =>
    event.phraseId === answer.id && event.gesture === "pickup");
  assert.equal(pickups.length, tracks.length);
  assert.ok(pickups.every((event) => event.coordinate.tick === phraseStartTick - 480));
});

test("historical v2 plans without groove remain readable and nested groove identity is fenced", () => {
  const model = song({
    sections: [
      { name: "Verse", startBar: 1, endBar: 2, energy: .5 },
      { name: "Chorus", startBar: 3, endBar: 4, energy: .8 },
    ],
  });
  const tracks = [{ id: "drums", name: "Drums", role: "rhythm" }];
  const plan = createArrangementPlan({
    arrangementId: "groove-compatibility",
    version: 1,
    songModel: model,
    style: createStyleSpec("pop", { density: .6, harmonyComplexity: 4, energy: .7 }),
    tracks,
    parameters: { songModelVersion: 6, seed: 44, energy: .7, density: .6 },
    compositionVersion: "2.0",
  });
  const historical = structuredClone(plan);
  delete historical.compositionIntelligence!.groove;
  assert.doesNotThrow(() => buildTrackModels({
    songModel: model, plan: historical, tracks, style: historical.style, seed: 44,
  }));
  const tampered = structuredClone(plan);
  tampered.compositionIntelligence!.groove!.seed += 1;
  assert.throws(() => buildTrackModels({
    songModel: model, plan: tampered, tracks, style: tampered.style, seed: 44,
  }), /Shared groove identity/);
});

test("orchestration assigns unique functions, deterministic handoffs, and distinct climax/release behavior", () => {
  const model = song({
    contractVersion: "2.0",
    timebase: { ppq: 960, originSeconds: 0, coordinateSystem: "seconds+ticks" },
    audio: { ...song().audio, durationSeconds: 48, analysisDurationSeconds: 48 },
    sections: [
      { name: "Verse", startBar: 1, endBar: 4, energy: .45 },
      { name: "Build", startBar: 5, endBar: 8, energy: .72 },
      { name: "Chorus", startBar: 9, endBar: 12, energy: .95 },
      { name: "Outro", startBar: 13, endBar: 16, energy: .25 },
    ],
    energy: [.45, .72, .95, .25],
    chords: [{ start: 0, end: 48, symbol: "C", roman: "I", confidence: .9 }],
    bars: Array.from({ length: 16 }, (_, index) => {
      const bar = index + 1;
      return {
        bar, start: index * 2, end: bar * 2, beats: 4, confidence: 1,
        coordinates: {
          start: { seconds: index * 2, tick: index * 3840, beat: index * 4, bar, beatInBar: 1, beatFraction: 0 },
          end: { seconds: bar * 2, tick: bar * 3840, beat: bar * 4, bar: bar + 1, beatInBar: 1, beatFraction: 0 },
        },
      };
    }),
  });
  const style = createStyleSpec("cinematic pop", {
    density: .78, harmonyComplexity: 6, energy: .8, orchestraSize: .9,
  });
  const tracks = [
    { id: "bass", name: "Bass", role: "bass" },
    { id: "drums", name: "Drums", role: "rhythm" },
    { id: "piano", name: "Piano", role: "melody" },
    { id: "guitar", name: "Guitar", role: "lead" },
    { id: "strings", name: "Strings", role: "support" },
    { id: "pad", name: "Synth Pad", role: "texture" },
  ];
  const create = () => createArrangementPlan({
    arrangementId: "orchestration-fixture",
    version: 1,
    songModel: model,
    style,
    tracks,
    parameters: {
      songModelVersion: 3, seed: 992, energy: .8, density: .78,
      orchestraSize: .9, rhythmIntensity: .7,
    },
    compositionVersion: "2.0",
  });
  const plan = create();
  const assignments = plan.compositionIntelligence?.orchestrationAssignments ?? [];
  assert.ok(assignments.length > 0);
  for (const section of plan.hierarchy.sections) {
    const sectionAssignments = assignments.filter((item) => item.sectionId === section.id);
    for (const phraseId of new Set(sectionAssignments.map((item) => item.phraseId))) {
      const occupied = sectionAssignments
        .filter((item) => item.phraseId === phraseId && item.role !== "doubling")
        .map((item) => `${item.role}:${item.register}`);
      assert.equal(new Set(occupied).size, occupied.length);
    }
  }
  assert.deepEqual(assignments, create().compositionIntelligence?.orchestrationAssignments);
  assert.ok(assignments.some((item) => item.handoffFromTrackId &&
    item.handoffFromTrackId !== item.trackId));
  const chorusSectionId = plan.hierarchy.sections[2].id;
  const chorusHooks = assignments.filter((item) =>
    item.sectionId === chorusSectionId && item.role === "hook");
  assert.equal(chorusHooks.length, 2);
  assert.notEqual(chorusHooks[0].trackId, chorusHooks[1].trackId);
  assert.equal(chorusHooks[1].handoffFromTrackId, chorusHooks[0].trackId);

  const climax = plan.sections[2];
  const release = plan.sections[3];
  assert.ok(climax.activeTracks!.length > release.activeTracks!.length);
  assert.notDeepEqual(
    Object.values(climax.trackDirectives!).map((directive) => directive.musicalFunction),
    Object.values(release.trackDirectives!).map((directive) => directive.musicalFunction),
  );
  const rendered = buildTrackModels({ songModel: model, plan, tracks, style, seed: 992 });
  const performedFunctions = (start: number, end: number) => [...new Set(rendered.flatMap((track) =>
    track.notes.filter((note) => note.start >= start && note.start < end)
      .map((note) => note.voice)))].sort();
  assert.notDeepEqual(performedFunctions(8, 16), performedFunctions(16, 24));
  assert.notDeepEqual(performedFunctions(16, 24), performedFunctions(24, 32));
  const performedShape = (start: number, end: number) => rendered.flatMap((track) =>
    track.notes.filter((note) => note.start >= start && note.start < end)
      .map((note) => `${track.id}:${note.voice}:${note.pitch}:${note.duration}`));
  assert.notDeepEqual(performedShape(8, 16), performedShape(16, 24));
  assert.notDeepEqual(performedShape(16, 24), performedShape(24, 32));
  const hookCarrier = (start: number, end: number) => rendered.find((track) =>
    track.notes.some((note) => note.start >= start && note.start < end && note.voice === "hook"))?.id;
  assert.notEqual(hookCarrier(16, 20), hookCarrier(20, 24));
  assert.ok(rendered.some((track) => track.notes.some((note) =>
    ["foundation", "pulse", "groove", "harmonic_support", "texture", "countermelody",
      "hook", "response", "lift", "transition", "accent", "pad"].includes(note.voice ?? ""))));

  const providerPlan = createArrangementPlan({
    arrangementId: "orchestration-provider-source",
    version: 1,
    songModel: model,
    style,
    tracks,
    parameters: {
      songModelVersion: 3, seed: 992, energy: .8, density: .78,
      orchestraSize: .9, rhythmIntensity: .7,
    },
    compositionVersion: "1.0",
  });
  const providerSource = buildTrackModels({
    songModel: model, plan: providerPlan, tracks, style, seed: 992,
  });
  const providerOrchestrated = applyCompositionIntelligence(providerSource, plan, model);
  const providerHookCarrier = (start: number, end: number) => providerOrchestrated.find((track) =>
    track.notes.some((note) => note.start >= start && note.start < end && note.voice === "hook"))?.id;
  assert.notEqual(providerHookCarrier(16, 20), providerHookCarrier(20, 24));
  assert.ok(providerOrchestrated.every((track) => track.notes.every((note) => {
    const sectionIndex = Math.min(3, Math.floor(note.start / 8));
    const sectionId = plan.hierarchy.sections[sectionIndex].id;
    const assignmentsAtTrack = assignments.filter((item) =>
      item.sectionId === sectionId && item.trackId === track.id);
    return assignmentsAtTrack.some((item) => item.role === note.voice);
  })));
  const phraseExitPlan = structuredClone(plan);
  const secondChorusPhrase = phraseExitPlan.compositionIntelligence!.phrases
    .filter((phrase) => phrase.sectionId === chorusSectionId)
    .sort((left, right) => left.startBar - right.startBar)[1];
  const exitingTrackId = phraseExitPlan.compositionIntelligence!.orchestrationAssignments!
    .find((item) => item.phraseId === secondChorusPhrase.id)!.trackId;
  phraseExitPlan.compositionIntelligence!.orchestrationAssignments =
    phraseExitPlan.compositionIntelligence!.orchestrationAssignments!.filter((item) =>
      item.phraseId !== secondChorusPhrase.id || item.trackId !== exitingTrackId);
  const phraseExitOutput = applyCompositionIntelligence(providerSource, phraseExitPlan, model);
  assert.equal(
    phraseExitOutput.find((track) => track.id === exitingTrackId)?.notes
      .filter((note) => note.start >= 20 && note.start < 24).length,
    0,
  );
});

test("same-function same-register duplication requires an explicit doubling role", () => {
  const model = song({
    sections: [
      { name: "Verse", startBar: 1, endBar: 2, energy: .5 },
      { name: "Chorus", startBar: 3, endBar: 4, energy: .9 },
    ],
    energy: [.5, .9],
  });
  const style = createStyleSpec("pop", {
    density: 1, harmonyComplexity: 5, energy: .8, orchestraSize: 1,
  });
  const make = (secondRole: string) => createArrangementPlan({
    arrangementId: `redundancy-${secondRole}`,
    version: 1,
    songModel: model,
    style,
    tracks: [
      { id: "piano-a", name: "Piano A", role: "harmony" },
      { id: "piano-b", name: "Piano B", role: secondRole },
    ],
    parameters: { songModelVersion: 1, seed: 7, density: 1, orchestraSize: 1 },
    compositionVersion: "2.0",
  });
  const ordinary = make("harmony").compositionIntelligence!.orchestrationAssignments!;
  assert.ok(ordinary.every((left, index) => ordinary.every((right, otherIndex) =>
    index === otherIndex || left.sectionId !== right.sectionId ||
    left.role !== right.role || left.register !== right.register)));
  const doubled = make("doubling").compositionIntelligence!.orchestrationAssignments!;
  assert.ok(doubled.some((item) => item.role === "doubling" && item.doublingTrackId));
  const doubledPlan = make("doubling");
  const doubledTracks = buildTrackModels({
    songModel: model,
    plan: doubledPlan,
    tracks: [
      { id: "piano-a", name: "Piano A", role: "harmony" },
      { id: "piano-b", name: "Piano B", role: "doubling" },
    ],
    style,
    seed: 7,
  });
  const target = doubledTracks.find((track) => track.id === "piano-a")!;
  const copy = doubledTracks.find((track) => track.id === "piano-b")!;
  assert.ok(copy.notes.length > 0);
  assert.deepEqual(
    copy.notes.map((note) => [note.start, note.duration, note.pitch]),
    target.notes.map((note) => [note.start, note.duration, note.pitch]),
  );
  assert.ok(copy.notes.every((note) => note.voice === "doubling"));
});

test("ordinary drum functions produce complementary rather than duplicate parts", () => {
  const model = song({
    sections: [
      { name: "Verse", startBar: 1, endBar: 4, energy: .6 },
      { name: "Chorus", startBar: 5, endBar: 8, energy: .9 },
    ],
    energy: [.6, .9],
  });
  const style = createStyleSpec("pop", {
    density: 1, harmonyComplexity: 4, energy: .8, orchestraSize: 1,
  });
  const tracks = [
    { id: "kit-a", name: "Drums A", role: "rhythm" },
    { id: "kit-b", name: "Drums B", role: "percussion" },
  ];
  const plan = createArrangementPlan({
    arrangementId: "complementary-drums",
    version: 1,
    songModel: model,
    style,
    tracks,
    parameters: { songModelVersion: 1, seed: 22, density: 1, orchestraSize: 1 },
    compositionVersion: "2.0",
  });
  const output = buildTrackModels({ songModel: model, plan, tracks, style, seed: 22 });
  const events = (trackId: string) => output.find((track) => track.id === trackId)!.notes
    .map((note) => [note.start, note.duration, note.pitch]);
  assert.notDeepEqual(events("kit-a"), events("kit-b"));
  const duplicateProviderTracks = output.map((track, index) => ({
    ...track,
    notes: output[0].notes.map((note) => ({
      ...note,
      id: `${track.id}-provider-${note.id}`,
      voice: undefined,
    })),
    source: `PROVIDER_${index}`,
  }));
  const orchestratedProviderTracks = applyCompositionIntelligence(
    duplicateProviderTracks,
    plan,
    model,
  );
  const providerEvents = (trackId: string) => orchestratedProviderTracks
    .find((track) => track.id === trackId)!.notes
    .map((note) => [note.start, note.duration, note.pitch]);
  assert.notDeepEqual(providerEvents("kit-a"), providerEvents("kit-b"));
  assert.ok(orchestratedProviderTracks.flatMap((track) => track.notes)
    .every((note) => duplicateProviderTracks[0].notes.some((source) =>
      source.pitch === note.pitch)));
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

test("v2 selects lower-motion inversions while v1 keeps its deterministic baseline", () => {
  const model = song({
    chords: [
      { start: 0, end: 2, symbol: "C", roman: "I", confidence: .9 },
      { start: 2, end: 4, symbol: "G/B", roman: "V6", confidence: .9 },
      { start: 4, end: 6, symbol: "Am7", roman: "vi7", confidence: .9 },
      { start: 6, end: 8, symbol: "F", roman: "IV", confidence: .9 },
    ],
    sections: [{ name: "Verse", startBar: 1, endBar: 4, energy: .7 }],
  });
  const tracks = [{ id: "piano", name: "Piano", role: "harmony" }];
  const style = createStyleSpec("cinematic pop", {
    density: .6, harmonyComplexity: 8, energy: .7,
  });
  const create = (compositionVersion: "1.0" | "2.0") => createArrangementPlan({
    arrangementId: "voicing-ab",
    version: 1,
    songModel: model,
    style,
    tracks,
    parameters: { songModelVersion: 2, seed: 812, harmonyComplexity: 8 },
    compositionVersion,
  });
  const v1 = buildTrackModels({ songModel: model, plan: create("1.0"), tracks, style, seed: 812 })[0];
  const v2 = buildTrackModels({ songModel: model, plan: create("2.0"), tracks, style, seed: 812 })[0];
  assert.equal(v1.notes.some((note) => note.id.includes(":voicing:")), false);
  assert.ok(v2.notes.filter((note) => note.id.includes(":voicing:")).length >= 9);
  assert.ok(
    Number(v2.harmonyEvidence?.selectedMotion) <=
      Number(v2.harmonyEvidence?.baselineMotion),
  );
  assert.equal(measureVoicingMotion([[48, 52, 55], [47, 50, 55], [48, 52, 57]]).transitions, 2);
  assert.equal(v2.harmonyEvidence?.melodyEvidencePreserved, true);
  assert.equal(v2.harmonyEvidence?.bassEvidencePreserved, true);
});

test("v2 countermelody records motif lineage, phrase shape, harmony, and resolution", () => {
  const model = song({
    contractVersion: "2.0",
    chords: [
      { start: 0, end: 4, symbol: "Cmaj7", roman: "Imaj7", confidence: .9 },
      { start: 4, end: 8, symbol: "G7", roman: "V7", confidence: .9 },
    ],
    bars: Array.from({ length: 4 }, (_, index) => ({
      bar: index + 1,
      start: index * 2,
      end: index * 2 + 2,
      beats: 4,
      confidence: 1,
    })),
    sections: [{ name: "Chorus", startBar: 1, endBar: 4, energy: .9 }],
  });
  const tracks = [{ id: "strings", name: "Strings", role: "countermelody" }];
  const style = createStyleSpec("cinematic pop", {
    density: .7, harmonyComplexity: 8, energy: .9,
  });
  const plan = createArrangementPlan({
    arrangementId: "counterline-fixture",
    version: 1,
    songModel: model,
    style,
    tracks,
    parameters: { songModelVersion: 3, seed: 455, harmonyComplexity: 8 },
    compositionVersion: "2.0",
  });
  const first = buildTrackModels({ songModel: model, plan, tracks, style, seed: 455 })[0];
  const second = buildTrackModels({ songModel: model, plan, tracks, style, seed: 455 })[0];
  assert.deepEqual(first.notes, second.notes);
  assert.ok(first.notes.length >= 3);
  assert.ok(first.notes.every((note) => note.voice === "countermelody"));
  assert.ok(first.notes.every((note) => note.id.includes("motif:")));
  assert.ok(first.notes.some((note) => note.id.includes(":approach:resolve-next")));
  assert.ok(first.notes.some((note) => note.id.includes(":resolution-of-")));
  assert.ok(new Set(first.notes.map((note) => note.pitch)).size >= 3);
  const chordPcs = new Set([0, 4, 7, 11, 2, 5]);
  assert.ok(first.notes.filter((note) => note.id.includes(":chord:") || note.id.includes(":pedal:"))
    .every((note) => chordPcs.has(note.pitch % 12)));
  assert.ok((first.harmonyEvidence?.motifRefs?.length ?? 0) >= 1);
  assert.ok((first.harmonyEvidence?.resolutionObligations ?? 0) >= 1);
  assert.equal(first.performanceEvidence?.performedMaterialSha256, performedMaterialSha256(first));
});

test("v2 preserves observed bass pitches and rejects voicings that collide with verified melody", () => {
  const model = song({
    melody: [{ start: 0, end: 2, pitch: 60, velocity: .8, confidence: .95, source: "verified" }],
    bass: [{ start: 0, end: 2, pitch: 43, confidence: .95 }],
    chords: [{ start: 0, end: 4, symbol: "Cmaj7", roman: "Imaj7", confidence: .95 }],
    sections: [{ name: "Verse", startBar: 1, endBar: 2, energy: .7 }],
  });
  const tracks = [
    { id: "piano", name: "Piano", role: "harmony" },
    { id: "bass", name: "Bass", role: "bass" },
  ];
  const style = createStyleSpec("cinematic pop", {
    density: .6, harmonyComplexity: 8, energy: .7,
  });
  const plan = createArrangementPlan({
    arrangementId: "observed-parts-hard-constraints",
    version: 1,
    songModel: model,
    style,
    tracks,
    parameters: { songModelVersion: 5, seed: 923, harmonyComplexity: 8 },
    compositionVersion: "2.0",
  });
  const [piano, bass] = buildTrackModels({ songModel: model, plan, tracks, style, seed: 923 });
  assert.ok(bass.notes.some((note) =>
    note.id.includes(":observed-bass:") && note.pitch === 43));
  assert.ok(piano.notes.filter((note) => note.start < 2)
    .every((note) => Math.abs(note.pitch - 60) > 1 && note.pitch > 47));
  assert.equal(piano.harmonyEvidence?.melodyEvidencePreserved, true);
  assert.equal(piano.harmonyEvidence?.bassEvidencePreserved, true);
  assert.equal(piano.performanceEvidence?.performedMaterialSha256, performedMaterialSha256(piano));
  assert.equal(bass.performanceEvidence?.performedMaterialSha256, performedMaterialSha256(bass));

  const modulatedPlan = structuredClone(plan);
  modulatedPlan.sections[0].operations.push("modulate:2");
  const [modulatedPiano] = buildTrackModels({
    songModel: model, plan: modulatedPlan, tracks, style, seed: 923,
  });
  assert.equal(modulatedPiano.harmonyEvidence?.selectedMotion, undefined);
  assert.equal(modulatedPiano.harmonyEvidence?.baselineMotion, undefined);
  assert.equal(
    modulatedPiano.performanceEvidence?.performedMaterialSha256,
    performedMaterialSha256(modulatedPiano),
  );
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
  const plan = planFor(model, 7, { seed: 3 }, "1.0", "2.0");
  assert.ok(plan.compositionIntelligence?.groove);
  plan.sections[0].activeTracks = ["voice"];
  plan.sections[1].activeTracks = [];
  plan.sections[0].tracks.Voice = "main_harmony";
  plan.sections[1].tracks.Voice = "main_harmony";
  const vocalInput = { songModel: model, plan, style: plan.style, seed: 3,
    tracks: [{ id: "voice", name: "Voice", role: "vocal" }] };
  const [firstOnly] = buildTrackModels(vocalInput);
  assert.deepEqual(firstOnly.notes.map((note) => [note.start, note.duration, note.pitch]), [[1.5, .5, 69]]);

  plan.sections[0].activeTracks = [];
  plan.sections[1].activeTracks = ["Voice"]; // legacy persisted name key
  const [legacyNamed] = buildTrackModels(vocalInput);
  assert.deepEqual(legacyNamed.notes.map((note) => [note.start, note.duration, note.pitch]), [[2, .5, 69]]);

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
  const responsePlan = createArrangementPlan({
    arrangementId: "vocal-response-v2",
    version: 1,
    songModel: detected,
    style: detectedPlan.style,
    tracks,
    parameters: { songModelVersion: detectedPlan.songModelVersion, seed: 81 },
    compositionVersion: "2.0",
  });
  const responseModels = buildTrackModels(input(detected, responsePlan));
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
  const responsePhrase = responsePlan.compositionIntelligence?.phrases.find((phrase) =>
    phrase.intention === "response");
  assert.ok(responsePhrase);
  assert.equal(responsePhrase?.transformation, "answering_gesture");
  const responseNotes = responseModels.flatMap((track) => track.notes)
    .filter((note) => note.motif?.phraseId === responsePhrase?.id);
  assert.ok(responseNotes.length > 0);
  assert.equal(new Set(responseModels.flatMap((track) => track.notes.map((note) => note.id))).size,
    responseModels.flatMap((track) => track.notes).length);
  assert.ok(responseNotes.every((note) =>
    note.start + note.duration <= (responsePhrase?.endSeconds ?? 0) + .0001));
  assert.equal(responseNotes[0].motif?.fingerprint,
    canonicalMotifFingerprint(responseNotes));
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