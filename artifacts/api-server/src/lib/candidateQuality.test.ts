import assert from "node:assert/strict";
import test from "node:test";
import type { ArrangementPlan, HarmonyDecisionEvidence, SongModelData, TrackModel } from "@workspace/db";
import { evaluateCandidateMusicalFit } from "./candidateQuality";
import { HarmonyEngine } from "./musicEngines";

const plan = {
  id: "plan",
  version: 1,
  sections: [
    {
      section: "verse",
      startBar: 1,
      endBar: 4,
      energy: 0.4,
      density: 0.4,
      tracks: { piano: "harmony", bass: "bass" },
      activeTracks: ["piano", "bass"],
      operations: [],
    },
    {
      section: "chorus",
      startBar: 5,
      endBar: 8,
      energy: 0.5,
      density: 0.5,
      tracks: { piano: "harmony", bass: "bass" },
      activeTracks: ["piano", "bass"],
      operations: [],
    },
  ],
  style: {
    orchestration: { density: 0.5 },
  },
  songModelVersion: 2,
  parameters: {},
  provenance: {},
} as unknown as ArrangementPlan;

const instrumentDefinition = {
  playableRange: { min: 24, max: 96 },
  constraints: { minNoteDuration: 0.05 },
};

const track = (id: string, instrument: string, pitch: number): TrackModel => ({
  id,
  instrument,
  role: id,
  notes: [
    { id: `${id}-1`, start: 17, duration: 1, pitch, velocity: 80 },
    { id: `${id}-2`, start: 19, duration: 1, pitch: pitch + 2, velocity: 80 },
    { id: `${id}-3`, start: 21, duration: 1, pitch: pitch + 4, velocity: 80 },
    { id: `${id}-4`, start: 23, duration: 1, pitch: pitch + 6, velocity: 80 },
  ],
  cc: [],
  articulations: [],
  automation: [],
  instrumentDefinition,
  source: "generated",
  version: 1,
  provenance: {},
} as unknown as TrackModel);

test("critic localizes a register collision to its bar and implicated tracks", () => {
  const report = evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan,
    tracks: [track("piano", "piano", 60), track("bass", "bass", 61)],
    harmonyDecisions: [],
  });

  const [finding] = report.dimensions.registerCollisions.findings;
  assert.ok(finding);
  assert.deepEqual(finding.affectedSections, ["chorus"]);
  assert.equal(finding.startBar, 5);
  assert.equal(finding.endBar, 5);
  assert.deepEqual(finding.affectedTrackIds, ["bass", "piano"]);
  assert.match(finding.musicalReason, /close-register collision/);
  assert.match(finding.id, /^music-critic-v2:registerCollisions:chorus:5-5:/);
  assert.deepEqual(finding.canonicalScope, { startBar: 5, endBar: 5 });
  assert.deepEqual(finding.affectedRoles, ["bass", "piano"]);
  assert.ok(finding.evidenceReferences?.length);
  assert.deepEqual(finding.permissibleRepairOperations, ["adjust_notes", "adjust_directive"]);
});

test("v2 capability-specific domains abstain without their required evidence", () => {
  const report = evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan,
    tracks: [track("piano", "piano", 60)],
    harmonyDecisions: [],
  });
  assert.equal(report.version, "music-critic-v2");
  for (const dimension of [
    "motifContinuityAndDevelopment", "phraseIntent", "vocalInteraction",
    "roleDuplication", "orchestralBalance", "grooveCoordination", "voiceLeading", "countermelodyShape",
    "dramaticTrajectory",
  ] as const) {
    assert.equal(report.dimensions[dimension].status, "unavailable");
    assert.equal(report.dimensions[dimension].score, null);
  }
});

test("critic permits close-register overlap only when the part explicitly doubles its target", () => {
  const piano = track("piano", "piano", 60);
  const strings = {
    ...track("strings", "strings", 61),
    appliedDirectives: [{
      section: "chorus",
      startBar: 5,
      endBar: 8,
      start: 16,
      end: 32,
      directive: {
        musicalFunction: "doubling",
        register: "middle",
        doublingTrackId: "piano",
      },
    }],
  } as TrackModel;
  const evaluate = (tracks: TrackModel[]) => evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan,
    tracks,
    harmonyDecisions: [],
  }).dimensions.registerCollisions;
  const intentional = evaluate([piano, strings]);
  assert.equal(intentional.findings.length, 0);
  const undeclared = structuredClone(strings);
  delete undeclared.appliedDirectives;
  assert.ok(evaluate([piano, undeclared]).findings.length > 0);
});

test("critic returns separate non-overlapping findings in one dimension", () => {
  const separatedTrack = (id: string, instrument: string, pitch: number): TrackModel => ({
    ...track(id, instrument, pitch),
    notes: [
      { id: `${id}-verse`, start: 1, duration: 1, pitch, velocity: 80 },
      { id: `${id}-chorus`, start: 17, duration: 1, pitch, velocity: 80 },
      { id: `${id}-3`, start: 19, duration: 1, pitch: pitch + 6, velocity: 80 },
      { id: `${id}-4`, start: 21, duration: 1, pitch: pitch + 12, velocity: 80 },
    ],
  } as TrackModel);
  const report = evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan,
    tracks: [
      separatedTrack("piano", "piano", 60),
      separatedTrack("bass", "bass", 61),
    ],
    harmonyDecisions: [],
  });

  const findings = report.dimensions.registerCollisions.findings;
  assert.ok(findings.length >= 2);
  assert.ok(findings.some((finding) =>
    finding.affectedSections[0] === "verse" && finding.startBar === 1));
  assert.ok(findings.some((finding) =>
    finding.affectedSections[0] === "chorus" && finding.startBar === 5));
  assert.ok(findings.every((finding, index) =>
    findings.every((other, otherIndex) =>
      index === otherIndex || finding.endBar < other.startBar || other.endBar < finding.startBar)));
});

test("critic localizes findings on both sides of a tempo change", () => {
  const tempoPlan = {
    ...plan,
    sections: [
      { ...plan.sections[0], section: "before", startBar: 1, endBar: 2 },
      { ...plan.sections[1], section: "after", startBar: 3, endBar: 4 },
    ],
  } as ArrangementPlan;
  const timedTrack = (
    id: string,
    instrument: string,
    notes: TrackModel["notes"],
  ): TrackModel => ({
    ...track(id, instrument, 48),
    notes,
  });
  const songModel = {
    tempoMap: [
      { time: 0, bpm: 60, confidence: 1 },
      { time: 8, bpm: 120, confidence: 1 },
    ],
    meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
  } as unknown as SongModelData;

  const before = evaluateCandidateMusicalFit({
    songModel,
    plan: tempoPlan,
    tracks: [
      timedTrack("piano", "piano", [
        { id: "piano-before", start: 4.25, duration: 0.5, pitch: 60, velocity: 80 },
      ]),
      timedTrack("bass", "bass", [
        { id: "bass-before", start: 4.25, duration: 0.5, pitch: 61, velocity: 80 },
      ]),
    ],
    harmonyDecisions: [],
  });
  const after = evaluateCandidateMusicalFit({
    songModel,
    plan: tempoPlan,
    tracks: [
      timedTrack("piano", "piano", [
        { id: "piano-after", start: 8.25, duration: 0.5, pitch: 60, velocity: 80 },
      ]),
      timedTrack("bass", "bass", [
        { id: "bass-after", start: 8.25, duration: 0.5, pitch: 61, velocity: 80 },
      ]),
    ],
    harmonyDecisions: [],
  });

  assert.deepEqual(before.dimensions.registerCollisions.findings[0]?.affectedSections, ["before"]);
  assert.equal(before.dimensions.registerCollisions.findings[0]?.startBar, 2);
  assert.deepEqual(after.dimensions.registerCollisions.findings[0]?.affectedSections, ["after"]);
  assert.equal(after.dimensions.registerCollisions.findings[0]?.startBar, 3);
});

test("critic keeps 6/8 harmony findings inclusive, section-bounded, and track-scoped", () => {
  const meterPlan = {
    ...plan,
    sections: [
      { ...plan.sections[0], section: "verse", startBar: 1, endBar: 4 },
      {
        ...plan.sections[1],
        section: "bridge",
        startBar: 5,
        endBar: 6,
        tracks: { piano: "harmony" },
        activeTracks: ["piano"],
      },
      {
        ...plan.sections[1],
        section: "",
        startBar: 7,
        endBar: 8,
        tracks: { bass: "bass" },
        activeTracks: ["bass"],
      },
    ],
  } as ArrangementPlan;
  const report = evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [
        { time: 0, bpm: 60, confidence: 1 },
        { time: 8, bpm: 120, confidence: 1 },
      ],
      meterMap: [
        { bar: 1, meter: "4/4", confidence: 1 },
        { bar: 5, meter: "6/8", confidence: 1 },
      ],
    } as unknown as SongModelData,
    plan: meterPlan,
    tracks: [
      track("piano", "piano", 48),
      track("bass", "bass", 36),
      track("drums", "drums", 40),
    ],
    harmonyDecisions: [{
      start: 12.25,
      end: 15.25,
      symbol: "Dm",
      source: "deterministic_candidate_scoring",
      melodyFit: 0.2,
      bassFit: 0.3,
    }],
  });

  const [finding] = report.dimensions.harmony.findings;
  assert.ok(finding);
  assert.deepEqual(finding.affectedSections, ["bridge"]);
  assert.equal(finding.startBar, 5);
  assert.equal(finding.endBar, 6);
  assert.deepEqual(finding.affectedTrackIds, ["piano"]);
  assert.doesNotMatch(finding.id, /::/);
});

test("dense collisions retain one deterministic finding per separate trouble spot", () => {
  const denseTrack = (id: string, pitch: number): TrackModel => ({
    ...track(id, id, pitch),
    notes: Array.from({ length: 200 }, (_, index) => {
      const inChorus = index >= 100;
      return {
        id: `${id}-${index}`,
        start: (inChorus ? 17 : 1) + (index % 100) * 0.001,
        duration: 1,
        pitch: pitch + (index % 2),
        velocity: 80,
      };
    }),
  } as TrackModel);
  const input = {
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan,
    tracks: [
      denseTrack("z-piano", 60),
      denseTrack("a-bass", 61),
      denseTrack("m-strings", 62),
    ],
    harmonyDecisions: [],
  };

  const findings = evaluateCandidateMusicalFit(input).dimensions.registerCollisions.findings;
  const repeatedFindings =
    evaluateCandidateMusicalFit(input).dimensions.registerCollisions.findings;

  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(({ startBar }) => startBar), [1, 5]);
  assert.deepEqual(findings.map(({ affectedTrackIds }) => affectedTrackIds), [
    ["a-bass", "m-strings"],
    ["a-bass", "m-strings"],
  ]);
  assert.deepEqual(repeatedFindings.map(({ id }) => id), findings.map(({ id }) => id));
});

test("register-collision scoring preserves exact counts for dense symbolic notes", () => {
  const dense = (id: string, pitch: number): TrackModel => ({
    ...track(id, id, pitch),
    notes: Array.from({ length: 40 }, (_, index) => ({
      id: `${id}-${index}`,
      start: index * 0.01,
      duration: 1,
      pitch,
      velocity: 80,
    })),
  } as TrackModel);

  const result = evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan,
    tracks: [dense("piano", 60), dense("strings", 62), dense("bass", 48)],
    harmonyDecisions: [],
  }).dimensions.registerCollisions;

  assert.equal(result.evidence[0]?.observations.crossTrackOverlaps, 4_800);
  assert.equal(result.evidence[0]?.observations.closeRegisterCollisions, 1_600);
  assert.equal(result.score, 0.667);
});

test("register-collision scoring scales across sparse long-form arrangements", {
  timeout: 2_000,
}, () => {
  const sparse = (id: string, pitch: number, offset: number): TrackModel => ({
    ...track(id, id, pitch),
    notes: Array.from({ length: 10_000 }, (_, index) => ({
      id: `${id}-${index}`,
      start: index * 2 + offset,
      duration: 0.25,
      pitch,
      velocity: 80,
    })),
  } as TrackModel);

  const result = evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan,
    tracks: [sparse("piano", 60, 0), sparse("bass", 61, 1)],
    harmonyDecisions: [],
  }).dimensions.registerCollisions;

  assert.equal(result.evidence[0]?.observations.crossTrackOverlaps, 0);
  assert.equal(result.evidence[0]?.observations.closeRegisterCollisions, 0);
  assert.equal(result.score, 1);
});

test("critic v2 deterministically localizes all nine composition-intelligence dimensions", () => {
  const richPlan = structuredClone(plan) as ArrangementPlan;
  richPlan.sections[1].activeTracks = ["piano", "strings"];
  richPlan.sections[1].tracks = { piano: "harmony", strings: "counterline" };
  richPlan.sections[1].trackDirectives = {
    piano: { musicalFunction: "harmonic_support", register: "high" },
    strings: { musicalFunction: "harmonic_support", register: "high" },
  };
  richPlan.hierarchy = {
    version: "1.0", status: "applied", reason: null,
    precedence: ["song", "section", "phrase", "bar", "event"],
    song: { id: "plan", intent: "development_arc", climaxSectionId: "section:chorus" },
    sections: [
      { id: "section:verse", sourceSection: "verse", startBar: 1, endBar: 4, function: "verse", development: "initial", targetEnergy: .4, targetDensity: .4, phraseIds: [], barIds: [] },
      { id: "section:chorus", sourceSection: "chorus", startBar: 5, endBar: 8, function: "chorus", development: "development", targetEnergy: .5, targetDensity: .5, phraseIds: [], barIds: [] },
    ],
    phrases: [{
      id: "other-phrase", sectionId: "section:chorus", startBar: 5, endBar: 5,
      confidence: .9, intent: "protect_vocal_phrase",
    }], bars: [], events: [],
  };
  richPlan.compositionIntelligence = {
    version: "2.0", mode: "reasoning_core",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: 1, evidenceSha256: "evidence", songIntent: "develop_observed_form",
    motifs: [{
      id: "source", fingerprint: "source-fingerprint", sourceSectionId: "section:verse",
      sourcePhraseId: "source-phrase", parentMotifId: null, transformation: "repetition",
      ownerTrackId: "strings", evidenceSha256: "evidence",
    }, {
      id: "motif", fingerprint: "private-fingerprint", sourceSectionId: "section:chorus",
      sourcePhraseId: "phrase", parentMotifId: "source", transformation: "rhythmic_variation",
      ownerTrackId: "strings", evidenceSha256: "evidence",
    }],
    phrases: [{
      id: "phrase", sectionId: "section:chorus", startBar: 5, endBar: 5,
      intent: "protect_vocal", tension: .5, motifRef: "motif", sourceMotifRef: "source",
      intention: "foreground", transformation: "rhythmic_variation", responseToPhraseId: null,
      ownerTrackId: "strings",
    }],
    instrumentRoles: [
      { trackId: "piano", function: "harmony", authority: "project_track" },
      { trackId: "strings", function: "counterline", authority: "project_track" },
    ],
    groove: {
      version: "1.0", seed: 1, evidenceSha256: "evidence", subdivision: "8th",
      roles: [
        { trackId: "piano", responsibility: "pulse" },
        { trackId: "strings", responsibility: "syncopation" },
      ],
      motifs: [], events: [],
    },
    tensionRelease: [
      { sectionId: "section:verse", tension: .8, release: .1 },
      { sectionId: "section:chorus", tension: .4, release: .1 },
    ],
  };
  const piano = track("piano", "piano", 74);
  const strings = track("strings", "strings", 74);
  strings.notes = strings.notes.slice(0, 3).map((note, index) => ({
    ...note,
    start: note.start + .3,
    pitch: 70 + index,
    motif: {
      id: "motif", fingerprint: "stale-rendered-fingerprint", parentMotifId: "source",
      transformation: "rhythmic_variation", phraseId: "phrase", intention: "foreground",
      evidenceSha256: "evidence",
    },
  }));
  piano.appliedDirectives = [{
    section: "chorus", startBar: 5, endBar: 8, start: 16, end: 32,
    directive: richPlan.sections[1].trackDirectives!.piano,
  }];
  piano.notes[0] = { ...piano.notes[0], duration: 7, pitch: 76 };
  strings.appliedDirectives = [{
    section: "chorus", startBar: 5, endBar: 8, start: 16, end: 32,
    directive: richPlan.sections[1].trackDirectives!.strings,
  }];
  const input = {
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
      vocalEvidence: {
        status: "detected", reason: null, provenance: null, sampleRate: 48_000, channels: 1,
        frameSizeSamples: 1024, thresholds: { rms: .1, peak: .1, activitySample: .1, activityRatio: .1 },
        observedVoicedWindows: [{ start: 16, end: 22 }], observedSilentWindows: [],
      },
      rhythmEvidence: [{ provider: "test", version: "1", beats: [16, 18, 20, 22], downbeats: [16], tempoBpm: 60 }],
    } as unknown as SongModelData,
    plan: richPlan,
    tracks: [piano, strings],
    harmonyDecisions: [{
      start: 17, end: 18, symbol: "C", source: "deterministic_candidate_scoring" as const,
      voiceLeading: .2, candidateRationale: [
        { symbol: "C", function: "tonic", score: .2, melodyFit: .5, bassFit: .5, voiceLeading: .2, selected: true },
      ],
    }],
  };
  const first = evaluateCandidateMusicalFit(input);
  const second = evaluateCandidateMusicalFit(input);
  const expected = {
    motifContinuityAndDevelopment: { tracks: ["strings"], roles: ["strings"], operations: ["adjust_notes", "adjust_rhythm"] },
    phraseIntent: { tracks: ["strings"], roles: ["strings"], operations: ["adjust_notes", "adjust_rhythm", "adjust_dynamics", "adjust_directive"] },
    vocalInteraction: { tracks: ["piano"], roles: ["piano"], operations: ["adjust_register", "adjust_dynamics", "adjust_notes"] },
    roleDuplication: { tracks: ["piano", "strings"], roles: ["harmonic_support"], operations: ["adjust_directive", "adjust_notes"] },
    orchestralBalance: { tracks: ["strings"], roles: ["strings"], operations: ["adjust_directive", "adjust_dynamics", "adjust_notes"] },
    grooveCoordination: { tracks: ["piano"], roles: ["piano"], operations: ["adjust_rhythm", "adjust_notes"] },
    voiceLeading: { tracks: ["piano", "strings"], roles: ["piano", "strings"], operations: ["adjust_voicing"] },
    countermelodyShape: { tracks: ["strings"], roles: ["strings"], operations: ["adjust_notes", "adjust_rhythm"] },
    dramaticTrajectory: { tracks: ["piano"], roles: ["piano"], operations: ["adjust_notes", "adjust_dynamics", "adjust_directive"] },
  } as const;
  for (const [name, contract] of Object.entries(expected) as Array<[keyof typeof expected, typeof expected[keyof typeof expected]]>) {
    const result = first.dimensions[name];
    assert.equal(result.status, "available", name);
    assert.equal(result.score, second.dimensions[name].score, `${name} deterministic score`);
    const finding = result.findings[0];
    assert.ok(finding, `${name} localized finding`);
    assert.deepEqual(finding.canonicalScope, name === "dramaticTrajectory"
      ? { startBar: 1, endBar: 4 }
      : name === "grooveCoordination"
        ? { startBar: 6, endBar: 6 }
      : name === "vocalInteraction"
        ? { startBar: 5, endBar: 5 }
      : { startBar: 5, endBar: name === "roleDuplication" || name === "orchestralBalance" ? 8 : 5 }, name);
    assert.deepEqual(finding.affectedTrackIds, contract.tracks, name);
    assert.deepEqual(finding.affectedRoles, contract.roles, name);
    assert.deepEqual(finding.permissibleRepairOperations, contract.operations, name);
    assert.ok(finding.evidenceReferences?.every((reference) =>
      !JSON.stringify(reference).includes("private-fingerprint")), `${name} safe evidence`);
  }
  const crossing = track("piano", "piano", 76);
  crossing.notes = [{ id: "crossing-vocal-boundary", start: 15, duration: 2, pitch: 76, velocity: 80 }];
  const crossingReport = evaluateCandidateMusicalFit({ ...input, tracks: [crossing] });
  assert.equal(crossingReport.dimensions.vocalInteraction.score, 0);
  assert.deepEqual(crossingReport.dimensions.vocalInteraction.findings, []);
});

test("voice-leading critic normalizes actual HarmonyEngine negative motion penalties", () => {
  const songModel = {
    chords: [], keyMap: [{ key: "C major" }], melody: [], bass: [],
    tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
    meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
  } as unknown as SongModelData;
  const harmonyPlan = { ...plan, parameters: { harmonyComplexity: 8 } } as ArrangementPlan;
  const generated = new HarmonyEngine().generate(songModel, harmonyPlan);
  const decisions = generated.map((item) => ({
    start: item.start, end: item.end, symbol: item.symbol,
    ...(item.decision as Omit<HarmonyDecisionEvidence, "start" | "end" | "symbol">),
  })) as HarmonyDecisionEvidence[];
  assert.ok(decisions.some((decision) => (decision.voiceLeading ?? 0) < 0));
  const result = evaluateCandidateMusicalFit({
    songModel, plan: harmonyPlan, tracks: [track("piano", "piano", 60)],
    harmonyDecisions: decisions,
  }).dimensions.voiceLeading;
  assert.equal(result.status, "available");
  assert.ok(result.score! > 0 && result.score! <= 1);
  assert.equal(result.score, evaluateCandidateMusicalFit({
    songModel, plan: harmonyPlan, tracks: [track("piano", "piano", 60)],
    harmonyDecisions: decisions,
  }).dimensions.voiceLeading.score);
});

const voiceLeadingTrack = (
  events: Array<{ start: number; pitches: number[] }>,
): TrackModel => {
  const piano = track("piano", "piano", 60);
  piano.role = "harmony";
  piano.notes = events.flatMap((event, eventIndex) =>
    event.pitches.map((pitch, voiceIndex) => ({
      id: `voice-${eventIndex}-${voiceIndex}`,
      start: event.start,
      duration: .5,
      pitch,
      velocity: 80,
    })));
  return piano;
};

const voiceLeadingSongModel = {
  tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
  meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
} as unknown as SongModelData;

test("stationary simultaneous wide voicing is healthy horizontal voice leading", () => {
  const result = evaluateCandidateMusicalFit({
    songModel: voiceLeadingSongModel,
    plan,
    tracks: [voiceLeadingTrack([{ start: 17, pitches: [48, 60, 72] }])],
    harmonyDecisions: [{
      start: 16, end: 20, symbol: "C", source: "deterministic_candidate_scoring",
      voiceLeading: 0,
    }],
  }).dimensions.voiceLeading;
  assert.equal(result.score, 1);
  assert.deepEqual(result.findings, []);
});

test("collapsing a stationary wide voicing to unison cannot improve voice leading", () => {
  const decisions: HarmonyDecisionEvidence[] = [{
    start: 16, end: 20, symbol: "C", source: "deterministic_candidate_scoring",
    voiceLeading: 0,
  }];
  const evaluate = (secondPitches: number[]) => evaluateCandidateMusicalFit({
    songModel: voiceLeadingSongModel,
    plan,
    tracks: [voiceLeadingTrack([
      { start: 17, pitches: [48, 60, 72] },
      { start: 18, pitches: secondPitches },
    ])],
    harmonyDecisions: decisions,
  }).dimensions.voiceLeading;
  const stationary = evaluate([48, 60, 72]);
  const collapsed = evaluate([60, 60, 60]);
  assert.equal(stationary.score, 1);
  assert.ok(collapsed.score! < stationary.score!);
});

test("cross-window matched voices reward small motion and localize a large transition", () => {
  const decisions: HarmonyDecisionEvidence[] = [
    { start: 19, end: 20, symbol: "C", source: "deterministic_candidate_scoring", voiceLeading: 0 },
    { start: 20, end: 22, symbol: "F", source: "deterministic_candidate_scoring", voiceLeading: 0 },
  ];
  const evaluate = (destination: number[]) => evaluateCandidateMusicalFit({
    songModel: voiceLeadingSongModel,
    plan,
    tracks: [voiceLeadingTrack([
      { start: 19.5, pitches: [48, 60, 72] },
      { start: 20.25, pitches: destination },
    ])],
    harmonyDecisions: decisions,
  }).dimensions.voiceLeading;
  const small = evaluate([49, 61, 73]);
  const large = evaluate([48, 72, 84]);
  assert.ok(small.score! > large.score!);
  assert.deepEqual(small.findings, []);
  assert.equal(large.findings[0]?.startBar, 6);
  assert.equal(large.findings[0]?.endBar, 6);
  assert.deepEqual(large.findings[0]?.affectedTrackIds, ["piano"]);
});

test("motif self-reference with null parent is valid producer repetition", () => {
  const repetitionPlan = structuredClone(plan) as ArrangementPlan;
  repetitionPlan.hierarchy = {
    version: "1.0", status: "applied", reason: null,
    precedence: ["song", "section", "phrase", "bar", "event"],
    song: { id: "plan", intent: "development_arc", climaxSectionId: null },
    sections: [{ id: "section:chorus", sourceSection: "chorus", startBar: 5, endBar: 8,
      function: "chorus", development: "reprise", targetEnergy: .5, targetDensity: .5,
      phraseIds: ["phrase"], barIds: [] }],
    phrases: [{ id: "phrase", sectionId: "section:chorus", startBar: 5, endBar: 5,
      confidence: 1, intent: "protect_vocal_phrase" }],
    bars: [], events: [],
  };
  repetitionPlan.compositionIntelligence = {
    version: "2.0", mode: "reasoning_core",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: 9, evidenceSha256: "e", songIntent: "preserve_observed_form",
    motifs: [{ id: "motif", fingerprint: "fp", sourceSectionId: "section:chorus",
      sourcePhraseId: "phrase", parentMotifId: null, transformation: "repetition",
      ownerTrackId: "piano", evidenceSha256: "e" }],
    phrases: [{ id: "phrase", sectionId: "section:chorus", startBar: 5, endBar: 5,
      intent: "state", tension: .4, motifRef: "motif", sourceMotifRef: "motif",
      intention: "support", transformation: "repetition", responseToPhraseId: null,
      ownerTrackId: "piano" }],
    instrumentRoles: [], tensionRelease: [],
  };
  const piano = track("piano", "piano", 60);
  piano.notes[0] = { ...piano.notes[0], motif: {
    id: "motif", fingerprint: "fp", parentMotifId: null, transformation: "repetition",
    phraseId: "phrase", intention: "support", evidenceSha256: "e",
  }};
  const result = evaluateCandidateMusicalFit({
    songModel: { tempoMap: [{ time: 0, bpm: 60 }], meterMap: [{ bar: 1, meter: "4/4" }] } as unknown as SongModelData,
    plan: repetitionPlan, tracks: [piano], harmonyDecisions: [],
  }).dimensions.motifContinuityAndDevelopment;
  assert.equal(result.status, "available");
  assert.equal(result.score, 1);
  assert.deepEqual(result.findings, []);

});

test("role duplication abstains when directives have no musical functions", () => {
  const emptyDirectivePlan = structuredClone(plan) as ArrangementPlan;
  emptyDirectivePlan.sections[0].trackDirectives = { piano: { register: "middle" } };
  const result = evaluateCandidateMusicalFit({
    songModel: { tempoMap: [{ time: 0, bpm: 60 }], meterMap: [{ bar: 1, meter: "4/4" }] } as unknown as SongModelData,
    plan: emptyDirectivePlan, tracks: [track("piano", "piano", 60)], harmonyDecisions: [],
  }).dimensions.roleDuplication;
  assert.equal(result.status, "unavailable");
  assert.equal(result.score, null);
});

test("vocal interaction only scores verified overlap inside declared protect-vocal phrase scope", () => {
  const scopedPlan = structuredClone(plan);
  scopedPlan.compositionIntelligence = {
    version: "2.0", mode: "reasoning_core",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: 12, evidenceSha256: "vocal-scope", songIntent: "preserve_observed_form",
    motifs: [], instrumentRoles: [], tensionRelease: [],
    phrases: [{
      id: "chorus-protect", sectionId: "section:chorus", startBar: 5, endBar: 8,
      intent: "protect_vocal", tension: .3, motifRef: "none", sourceMotifRef: null,
      intention: "silence", transformation: "repetition", responseToPhraseId: null,
      ownerTrackId: "piano",
    }],
  };
  const evaluate = (versePitch: number, notesInOrder: "forward" | "reverse") => {
    const piano = track("piano", "piano", 60);
    const notes = [
      { id: "verse-high", start: 2, duration: .5, pitch: versePitch, velocity: 80 },
      { id: "chorus-high", start: 17, duration: .5, pitch: 76, velocity: 80 },
    ];
    piano.notes = notesInOrder === "forward" ? notes : notes.reverse();
    return evaluateCandidateMusicalFit({
      songModel: {
        tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
        meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
        vocalEvidence: {
          status: "detected", reason: null, provenance: null, sampleRate: 48_000,
          channels: 1, frameSizeSamples: 1024,
          thresholds: { rms: .1, peak: .1, activitySample: .1, activityRatio: .1 },
          observedVoicedWindows: [{ start: 2, end: 3 }, { start: 16, end: 18 }],
          observedSilentWindows: [],
        },
      } as unknown as SongModelData,
      plan: scopedPlan, tracks: [piano], harmonyDecisions: [],
    }).dimensions.vocalInteraction;
  };
  const withVerseIntrusion = evaluate(76, "forward");
  const withoutVerseIntrusion = evaluate(48, "forward");
  assert.equal(withVerseIntrusion.score, 0);
  assert.equal(withoutVerseIntrusion.score, 0);
  assert.equal(withVerseIntrusion.evidence[0]?.observations.overlappingNotes, 1);
  assert.deepEqual(withVerseIntrusion.findings.map((finding) => ({
    startBar: finding.startBar, endBar: finding.endBar, affectedSections: finding.affectedSections,
  })), [{ startBar: 5, endBar: 5, affectedSections: ["chorus"] }]);
  assert.deepEqual(withVerseIntrusion, evaluate(76, "reverse"));
});

test("groove assessment excludes unrelated melodic tracks and accepts subdivisions", () => {
  const groovePlan = structuredClone(plan) as ArrangementPlan;
  groovePlan.compositionIntelligence = {
    version: "2.0", mode: "reasoning_core",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: 4, evidenceSha256: "e", songIntent: "preserve_observed_form",
    motifs: [], phrases: [], tensionRelease: [], instrumentRoles: [],
    groove: {
      version: "1.0", seed: 4, evidenceSha256: "e", subdivision: "8th",
      roles: [{ trackId: "bass", responsibility: "foundation" }, { trackId: "drums", responsibility: "pulse" }],
      motifs: [], events: [],
    },
  };
  const bass = { ...track("bass", "bass", 40), notes: [
    { id: "bass-subdivision", start: 17, duration: .25, pitch: 40, velocity: 80 },
  ] } as TrackModel;
  const drums = { ...track("drums", "drums", 36), notes: [
    { id: "drum-beat", start: 16, duration: .25, pitch: 36, velocity: 80 },
  ] } as TrackModel;
  const melody = { ...track("melody", "violin", 72), notes: [
    { id: "melody-off-grid", start: 17.31, duration: .25, pitch: 72, velocity: 80 },
  ] } as TrackModel;
  const songModel = {
    tempoMap: [{ time: 0, bpm: 60 }], meterMap: [{ bar: 1, meter: "4/4" }],
    rhythmEvidence: [{ provider: "test", version: "1", beats: [16, 18, 20], downbeats: [16], tempoBpm: 60 }],
  } as unknown as SongModelData;
  const withoutMelody = evaluateCandidateMusicalFit({
    songModel, plan: groovePlan, tracks: [bass, drums], harmonyDecisions: [],
  }).dimensions.grooveCoordination;
  const withMelody = evaluateCandidateMusicalFit({
    songModel, plan: groovePlan, tracks: [bass, drums, melody], harmonyDecisions: [],
  }).dimensions.grooveCoordination;
  assert.equal(withMelody.score, withoutMelody.score);
  assert.ok(withMelody.findings.every((finding) => !finding.affectedTrackIds.includes("melody")));
});

const reconciledGrooveDimension = (
  rhythmEvidence: NonNullable<SongModelData["rhythmEvidence"]>,
) => {
  const groovePlan = structuredClone(plan);
  groovePlan.compositionIntelligence = {
    version: "2.0", mode: "reasoning_core",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: 44, evidenceSha256: "rhythm-reconciliation",
    songIntent: "preserve_observed_form", motifs: [], phrases: [], tensionRelease: [],
    instrumentRoles: [
      { trackId: "bass", function: "foundation", authority: "project_track" },
      { trackId: "drums", function: "pulse", authority: "project_track" },
    ],
    groove: {
      version: "1.0", seed: 44, evidenceSha256: "rhythm-reconciliation",
      subdivision: "8th", motifs: [], events: [],
      roles: [
        { trackId: "bass", responsibility: "foundation" },
        { trackId: "drums", responsibility: "pulse" },
      ],
    },
  };
  const bass = track("bass", "bass", 40);
  bass.notes = [
    { id: "bass-1", start: 16, duration: .25, pitch: 40, velocity: 80 },
    { id: "bass-2", start: 18, duration: .25, pitch: 43, velocity: 80 },
  ];
  const drums = track("drums", "drums", 36);
  drums.notes = [
    { id: "drums-1", start: 16, duration: .25, pitch: 36, velocity: 80 },
    { id: "drums-2", start: 18, duration: .25, pitch: 38, velocity: 80 },
  ];
  return evaluateCandidateMusicalFit({
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
      rhythmEvidence,
    } as unknown as SongModelData,
    plan: groovePlan,
    tracks: [bass, drums],
    harmonyDecisions: [],
  }).dimensions.grooveCoordination;
};

test("groove reconciliation is invariant to BEAT_THIS and MADMOM evidence order", () => {
  const beatThis = {
    provider: "BEAT_THIS", version: "1",
    beats: [22, 16, 20, 18], downbeats: [16], tempoBpm: 60,
  };
  const madmom = {
    provider: "MADMOM", version: "1",
    beats: [16.02, 18.02, 20.02, 22.02], downbeats: [16.02], tempoBpm: 60.2,
  };
  assert.deepEqual(
    reconciledGrooveDimension([beatThis, madmom]),
    reconciledGrooveDimension([madmom, beatThis]),
  );
});

test("groove reconciliation abstains when non-authoritative timelines materially disagree", () => {
  const result = reconciledGrooveDimension([
    {
      provider: "provider-a", version: "1",
      beats: [16, 18, 20, 22], downbeats: [16], tempoBpm: 60,
    },
    {
      provider: "provider-b", version: "1",
      beats: [16.6, 17.6, 18.6], downbeats: [16.6], tempoBpm: 120,
    },
  ]);
  assert.equal(result.status, "unavailable");
  assert.equal(result.score, null);
  assert.deepEqual(result.findings, []);
});

test("groove reconciliation independently sorts and deduplicates provider beats", () => {
  const clean = reconciledGrooveDimension([{
    provider: "BEAT_THIS", version: "1",
    beats: [16, 18, 20, 22], downbeats: [16], tempoBpm: 60,
  }]);
  const unsorted = reconciledGrooveDimension([{
    provider: "BEAT_THIS", version: "1",
    beats: [22, 18, 16, 18, 20, 16.0005], downbeats: [16], tempoBpm: 60,
  }]);
  assert.deepEqual(unsorted, clean);
});
