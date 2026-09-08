import assert from "node:assert/strict";
import test from "node:test";
import type {
  ArrangementPlan,
  CandidateMusicCriticDimension,
  HarmonyDecisionEvidence,
  SongModelData,
  TrackModel,
} from "@workspace/db";
import { RepairGenerationCandidateBody } from "@workspace/api-zod";
import {
  applyBoundedRepair,
  boundedRepairSourceSeed,
  normalizeRepairFinding,
  repairTimeBounds,
  validateServerAuthoredRepairFinding,
} from "./candidateRepair";
import { evaluateCandidateMusicalFit } from "./candidateQuality";
import { canonicalMotifFingerprint, synchronizeMotifLineage } from "./musicEngines";

test("bounded repair queue seed helper preserves persisted source seed exactly", () => {
  assert.equal(boundedRepairSourceSeed(1_987_654_321), 1_987_654_321);
});

test("repair request parser accepts public v1 and v2 findings without partial-v2 downgrade", () => {
  const piano = track("piano");
  const publicV1 = {
    id: "historical-v1-finding",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "The historical critic identified a local piano issue.",
  };
  const parsedV1 = RepairGenerationCandidateBody.parse({
    findingId: publicV1.id,
    finding: publicV1,
  });
  const validated = validateServerAuthoredRepairFinding(
    parsedV1.findingId,
    parsedV1.finding,
    [publicV1],
    plan,
    [piano],
  );
  assert.deepEqual(validated, normalizeRepairFinding(publicV1, plan, [piano]));

  const publicV2 = normalizeRepairFinding(publicV1, plan, [piano]);
  assert.deepEqual(RepairGenerationCandidateBody.parse({
    findingId: publicV2.id,
    finding: publicV2,
  }).finding, publicV2);

  assert.equal(RepairGenerationCandidateBody.safeParse({
    findingId: publicV1.id,
    finding: { ...publicV1, affectedRoles: ["piano"] },
  }).success, false);
});

const plan = {
  id: "plan",
  version: 1,
  sections: [
    { section: "verse", startBar: 1, endBar: 4, energy: 0.4, density: 0.4, tracks: {}, operations: [] },
    { section: "chorus", startBar: 5, endBar: 8, energy: 0.8, density: 0.8, tracks: {}, operations: [] },
  ],
  style: {},
  songModelVersion: 1,
  parameters: {},
  provenance: {},
  hierarchy: {
    version: "1.0",
    status: "applied",
    reason: null,
    precedence: ["song", "section", "phrase", "bar", "event"],
    song: { id: "plan", intent: "development_arc", climaxSectionId: "section:chorus:2" },
    sections: [
      { id: "section:verse:1", sourceSection: "verse", startBar: 1, endBar: 4, function: "verse", development: "initial", targetEnergy: .4, targetDensity: .4, phraseIds: [], barIds: ["bar:section:verse:1:1"] },
      { id: "section:chorus:2", sourceSection: "chorus", startBar: 5, endBar: 8, function: "chorus", development: "initial", targetEnergy: .8, targetDensity: .8, phraseIds: ["phrase:section:chorus:2:p1"], barIds: ["bar:section:chorus:2:5", "bar:section:chorus:2:6"] },
    ],
    phrases: [{ id: "phrase:section:chorus:2:p1", sectionId: "section:chorus:2", startBar: 5, endBar: 5, confidence: .9, intent: "protect_vocal_phrase" }],
    bars: [
      { id: "bar:section:verse:1:1", sectionId: "section:verse:1", bar: 1, meter: "4/4", phraseIds: [], vocalSpace: "unknown" },
      { id: "bar:section:chorus:2:5", sectionId: "section:chorus:2", bar: 5, meter: "3/4", phraseIds: ["phrase:section:chorus:2:p1"], vocalSpace: "occupied" },
      { id: "bar:section:chorus:2:6", sectionId: "section:chorus:2", bar: 6, meter: "3/4", phraseIds: [], vocalSpace: "available" },
    ],
    events: [
      { id: "event:section:verse:1:1:piano", sectionId: "section:verse:1", barId: "bar:section:verse:1:1", trackId: "piano", intent: "follow_section", source: "section" },
      { id: "event:section:chorus:2:5:piano", sectionId: "section:chorus:2", barId: "bar:section:chorus:2:5", trackId: "piano", intent: "support_vocal", source: "vocal_phrase" },
    ],
  },
} as unknown as ArrangementPlan;
const track = (id: string): TrackModel => ({
  id,
  instrument: "piano",
  role: id,
  notes: [
    { id: `${id}-outside`, start: 2, duration: 1, pitch: 60, velocity: 80 },
    { id: `${id}-inside`, start: 18, duration: 1, pitch: 62, velocity: 80 },
  ],
  cc: [],
  articulations: [],
  automation: [],
  source: "original",
  version: 1,
  provenance: { model: "test", version: "1", parameters: {}, parentIds: [], createdBy: "test" },
} as unknown as TrackModel);

test("bounded repairs preserve every unscoped event and track", () => {
  const bass = track("bass");
  const piano = track("piano");
  const finding = normalizeRepairFinding({
    id: "critic-1",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "The chorus piano voicing clashes with the melody.",
  }, plan, [piano, bass]);
  const proposedPiano = {
    ...piano,
    notes: [
      { id: "rewritten-outside", start: 2, duration: 1, pitch: 20, velocity: 1 },
      { id: "repaired-inside", start: 18, duration: 1, pitch: 67, velocity: 90 },
    ],
    source: "repair",
    version: 2,
  };
  const proposedPlan = {
    ...plan,
    sections: plan.sections.map((section) => ({
      ...section,
      energy: section.section === "chorus" ? 0.7 : 0.1,
    })),
    hierarchy: {
      ...plan.hierarchy,
      sections: plan.hierarchy.sections.map((section) => ({
        ...section,
        targetEnergy: section.id === "section:chorus:2" ? .7 : .1,
      })),
      bars: plan.hierarchy.bars.map((bar) => bar.id === "bar:section:chorus:2:5"
        ? { ...bar, vocalSpace: "available" as const }
        : bar),
      events: plan.hierarchy.events.map((event) => event.id === "event:section:chorus:2:5:piano"
        ? { ...event, intent: "use_vocal_space" as const }
        : event),
    },
  };
  const result = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate",
      sourceCandidateLabel: "Original Candidate",
      sourceScore: 0.5,
      seed: 123,
      maxAttempts: 2,
      finding,
      plan,
      trackModels: [piano, bass],
    },
    proposedPlan,
    proposedTrackModels: [proposedPiano, { ...bass, source: "wrong" }],
    timeBounds: { start: 16, end: 24 },
  });
  assert.equal(result.outsideScopePreserved, true);
  assert.deepEqual(result.trackModels.find((item) => item.id === "bass"), bass);
  assert.equal(result.trackModels[0].notes[0].id, "piano-outside");
  assert.equal(result.trackModels[0].notes[1].id, "repaired-inside");
  assert.equal(result.plan.sections[0].energy, 0.4);
  assert.equal(result.plan.sections[1].energy, 0.8);
  assert.equal(result.plan.hierarchy.song.climaxSectionId, "section:chorus:2");
  assert.equal(result.plan.hierarchy.sections[0].targetEnergy, .4);
  assert.equal(result.plan.hierarchy.sections[1].targetEnergy, .8);
  assert.equal(result.plan.hierarchy.bars.find((bar) => bar.id === "bar:section:chorus:2:5")?.vocalSpace, "available");
  assert.deepEqual(result.changedScopes, [
    { level: "bar", id: "bar:section:chorus:2:5" },
    { level: "event", id: "event:section:chorus:2:5:piano" },
  ]);
});

test("directive repairs reject canonical hierarchy scope and ownership rewrites", () => {
  const piano = track("piano");
  const finding = normalizeRepairFinding({
    id: "directive-hierarchy-guard",
    affectedSections: ["chorus"], startBar: 5, endBar: 6,
    affectedTrackIds: ["piano"], musicalReason: "Local directive needs repair.",
  }, plan, [piano]);
  const apply = (proposedPlan: ArrangementPlan) => applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate", sourceCandidateLabel: "Original",
      sourceScore: .5, seed: 1, maxAttempts: 1, finding, plan, trackModels: [piano],
    },
    proposedPlan, proposedTrackModels: [piano],
    timeBounds: { start: 16, end: 24 },
  });
  const mutate = (change: (hierarchy: NonNullable<ArrangementPlan["hierarchy"]>) => void) => {
    const proposedPlan = structuredClone(plan);
    change(proposedPlan.hierarchy!);
    assert.throws(() => apply(proposedPlan), /canonical hierarchy/);
  };
  mutate((hierarchy) => { hierarchy.sections[1].endBar = 9; });
  mutate((hierarchy) => { hierarchy.sections[1].sourceSection = "verse"; });
  mutate((hierarchy) => { hierarchy.bars[1].bar = 9; });
  mutate((hierarchy) => { hierarchy.bars[1].sectionId = "section:verse:1"; });
  mutate((hierarchy) => { hierarchy.events[1].sectionId = "section:verse:1"; });
  mutate((hierarchy) => { hierarchy.phrases[0].sectionId = "section:verse:1"; });
});

test("critic findings must identify concrete known musical scope", () => {
  assert.throws(() => normalizeRepairFinding({
    id: "critic-2",
    affectedSections: [],
    startBar: 5,
    endBar: 4,
    affectedTrackIds: ["missing"],
    musicalReason: "",
  }, plan, [track("piano")]), /critic finding/);
});

test("repair findings retain canonical scope, roles, evidence references, and bounded operations", () => {
  const finding = normalizeRepairFinding({
    id: "v2-envelope",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    affectedRoles: ["harmony"],
    canonicalScope: { startBar: 5, endBar: 6 },
    evidenceReferences: [{ source: "track_notes", summary: "bounded symbolic evidence" }],
    permissibleRepairOperations: ["adjust_voicing"],
    musicalReason: "A local voicing repair is required.",
  }, plan, [{ ...track("piano"), role: "harmony" }]);
  assert.deepEqual(finding.canonicalScope, { startBar: 5, endBar: 6 });
  assert.deepEqual(finding.permissibleRepairOperations, ["adjust_voicing"]);
  assert.throws(() => normalizeRepairFinding({
    ...finding,
    id: "invalid-operation",
    permissibleRepairOperations: ["replace_source" as never],
  }, plan, [track("piano")]), /permissible repair operation/);
});

test("v2 repair operations reject out-of-allowlist mutations and retain source metadata", () => {
  const piano = track("piano");
  const finding = normalizeRepairFinding({
    id: "voicing-only", affectedSections: ["chorus"], startBar: 5, endBar: 6,
    affectedTrackIds: ["piano"], musicalReason: "Local voicing adjustment.",
    permissibleRepairOperations: ["adjust_voicing"],
  }, plan, [piano]);
  const changedVelocity = structuredClone(piano);
  changedVelocity.notes[1].velocity = 1;
  assert.throws(() => applyBoundedRepair({
    snapshot: { sourceCandidateId: "source", sourceCandidateLabel: "Source", sourceScore: .5, seed: 99,
      maxAttempts: 2, finding, plan, trackModels: [piano] },
    proposedPlan: { ...plan, provenance: { ...plan.provenance, parentIds: ["replacement"] } },
    proposedTrackModels: [changedVelocity], timeBounds: { start: 16, end: 24 },
  }), /adjust_dynamics/);
  const changedPitch = structuredClone(piano);
  changedPitch.notes[1].pitch = 67;
  changedPitch.source = "replacement";
  changedPitch.version = 999;
  changedPitch.provenance = { ...piano.provenance, parentIds: ["replacement"] };
  const repaired = applyBoundedRepair({
    snapshot: { sourceCandidateId: "source", sourceCandidateLabel: "Source", sourceScore: .5, seed: 99,
      maxAttempts: 2, finding, plan, trackModels: [piano] },
    proposedPlan: { ...plan, provenance: { ...plan.provenance, parentIds: ["replacement"] } },
    proposedTrackModels: [changedPitch], timeBounds: { start: 16, end: 24 },
  });
  assert.equal(repaired.trackModels[0].source, piano.source);
  assert.equal(repaired.trackModels[0].version, piano.version);
  assert.deepEqual(repaired.trackModels[0].provenance, piano.provenance);
  assert.deepEqual(repaired.plan.provenance, plan.provenance);
});

test("repair scope must exactly match the server-authored finding identity", () => {
  const finding = {
    id: "critic-server-owned",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "The chorus piano voicing clashes with the melody.",
  };
  assert.deepEqual(
    validateServerAuthoredRepairFinding(
      finding.id,
      finding,
      [finding],
      plan,
      [track("piano")],
    ),
    normalizeRepairFinding(finding, plan, [track("piano")]),
  );
  assert.throws(() => validateServerAuthoredRepairFinding(
    finding.id,
    { ...finding, endBar: 7 },
    [finding],
    plan,
    [track("piano")],
  ), /server-authored/);
  assert.throws(() => validateServerAuthoredRepairFinding(
    "unknown",
    finding,
    [finding],
    plan,
    [track("piano")],
  ), /not available/);
});

test("notes crossing either repair boundary remain byte-for-byte original", () => {
  const piano = track("piano");
  piano.notes = [
    { id: "crosses-start", start: 15, duration: 2, pitch: 60, velocity: 80 },
    { id: "crosses-end", start: 23, duration: 2, pitch: 62, velocity: 80 },
  ];
  const finding = normalizeRepairFinding({
    id: "critic-boundaries",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "Repair the notes fully contained in these bars.",
  }, plan, [piano]);
  const result = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate",
      sourceCandidateLabel: "Original Candidate",
      sourceScore: 0.5,
      seed: 123,
      maxAttempts: 2,
      finding,
      plan,
      trackModels: [piano],
    },
    proposedPlan: plan,
    proposedTrackModels: [{
      ...piano,
      notes: [
        { id: "changed-crosses-start", start: 15, duration: 2, pitch: 20, velocity: 1 },
        { id: "changed-crosses-end", start: 23, duration: 2, pitch: 20, velocity: 1 },
        { id: "contained", start: 18, duration: 1, pitch: 67, velocity: 90 },
      ],
    }],
    timeBounds: { start: 16, end: 24 },
  });
  assert.equal(result.outsideScopePreserved, true);
  assert.deepEqual(result.trackModels[0].notes, [
    piano.notes[0],
    { id: "contained", start: 18, duration: 1, pitch: 67, velocity: 90 },
    piano.notes[1],
  ]);
});

test("repair time bounds follow canonical meter changes", () => {
  const finding = {
    id: "meter-change",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "Repair two bars after the meter change.",
  };
  assert.deepEqual(repairTimeBounds(
    finding,
    [{ time: 0, bpm: 60 }],
    [{ bar: 1, meter: "4/4" }, { bar: 5, meter: "3/4" }],
  ), { start: 16, end: 22 });
});

test("critic bars cannot extend into an unnamed section", () => {
  assert.throws(() => normalizeRepairFinding({
    id: "cross-section",
    affectedSections: ["chorus"],
    startBar: 4,
    endBar: 5,
    affectedTrackIds: ["piano"],
    musicalReason: "This must not rewrite the verse.",
  }, plan, [track("piano")]), /Every repair bar/);
});

test("repairing a legacy plan materializes a valid hierarchy and reports every added scope", () => {
  const piano = track("piano");
  const { hierarchy: _removed, ...legacyPlan } = plan;
  const finding = normalizeRepairFinding({
    id: "legacy-upgrade",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "Repair the legacy candidate without returning an invalid plan.",
  }, legacyPlan as ArrangementPlan, [piano]);
  const result = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "legacy",
      sourceCandidateLabel: "Legacy Candidate",
      sourceScore: .4,
      seed: 3,
      maxAttempts: 2,
      finding,
      plan: legacyPlan as ArrangementPlan,
      trackModels: [piano],
    },
    proposedPlan: plan,
    proposedTrackModels: [piano],
    timeBounds: { start: 16, end: 24 },
  });
  assert.equal(result.plan.hierarchy.status, "applied");
  assert.equal(result.changedScopes[0].level, "song");
  assert.ok(result.changedScopes.some((scope) =>
    scope.level === "event" && scope.id === "event:section:chorus:2:5:piano"));
});

test("bounded repairs replace only in-scope motif decisions and symbolic lineage", () => {
  const piano = track("piano");
  const bass = track("bass");
  bass.performanceEvidence = {
    version: "1.0", seed: 3, compositionSeed: 3, performanceSeed: 33,
    instrumentFamily: "keys", articulationProfile: "test", timingProfile: "test",
    dynamicsProfile: "test", canonicalTimelineSha256: "timeline", phraseIds: [],
    sectionRanges: [], playability: { valid: true, checkedNotes: 2, violations: [] },
    performedMaterialSha256: "source-digest",
  };
  const motifTag = (
    id: string,
    phraseId: string,
    intention: "support" | "foreground" | "silence",
  ) => ({
    id,
    fingerprint: "",
    parentMotifId: id === "chorus-motif" ? "verse-motif" : null,
    transformation: id === "chorus-motif" ? "rhythmic_variation" as const : "repetition" as const,
    phraseId,
    intention,
    evidenceSha256: "evidence",
  });
  piano.notes = [
    { id: "verse-note", start: 2, duration: 1, pitch: 60, velocity: 80, motif: motifTag("verse-motif", "verse-phrase", "support") },
    { id: "crosses-repair-start", start: 15, duration: 2, pitch: 62, velocity: 80, motif: motifTag("chorus-motif", "chorus-phrase", "foreground") },
    { id: "chorus-note", start: 18, duration: 1, pitch: 64, velocity: 80, motif: motifTag("chorus-motif", "chorus-phrase", "foreground") },
    { id: "silence-note", start: 20, duration: 1, pitch: 67, velocity: 70, motif: motifTag("silence-motif", "vocal-silence", "silence") },
  ];
  const setFingerprint = (id: string, phraseId: string) => {
    const material = piano.notes.filter((note) =>
      note.motif?.id === id && note.motif.phraseId === phraseId);
    const fingerprint = canonicalMotifFingerprint(material);
    for (const note of material) note.motif!.fingerprint = fingerprint;
    return fingerprint;
  };
  const verseFingerprint = setFingerprint("verse-motif", "verse-phrase");
  const chorusFingerprint = setFingerprint("chorus-motif", "chorus-phrase");
  const silenceFingerprint = setFingerprint("silence-motif", "vocal-silence");
  const emptyFingerprint = canonicalMotifFingerprint([]);
  const reasoning = {
    version: "2.0",
    mode: "reasoning_core",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: 3,
    evidenceSha256: "evidence",
    songIntent: "develop_observed_form",
    tensionRelease: [],
    instrumentRoles: [{ trackId: "piano", function: "harmony", authority: "project_track" }],
    phrases: [
      { id: "verse-phrase", sectionId: "section:verse:1", startBar: 1, endBar: 4, intent: "state", tension: .2, motifRef: "verse-motif", sourceMotifRef: null, intention: "support", transformation: "repetition", responseToPhraseId: null, ownerTrackId: "piano" },
      { id: "chorus-phrase", sectionId: "section:chorus:2", startBar: 5, endBar: 6, intent: "develop", tension: .8, motifRef: "chorus-motif", sourceMotifRef: "verse-motif", intention: "foreground", transformation: "rhythmic_variation", responseToPhraseId: null, ownerTrackId: "piano" },
      { id: "chorus-repetition", sectionId: "section:chorus:2", startBar: 5, endBar: 6, intent: "state", tension: .6, motifRef: "verse-motif", sourceMotifRef: "verse-motif", intention: "foreground", transformation: "repetition", responseToPhraseId: null, ownerTrackId: "piano" },
      { id: "bass-chorus-phrase", sectionId: "section:chorus:2", startBar: 5, endBar: 6, intent: "state", tension: .5, motifRef: "bass-motif", sourceMotifRef: null, intention: "support", transformation: "repetition", responseToPhraseId: null, ownerTrackId: "bass" },
      { id: "vocal-silence", sectionId: "section:chorus:2", startBar: 5, endBar: 6, intent: "protect_vocal", tension: .2, motifRef: "silence-motif", sourceMotifRef: null, intention: "silence", transformation: "repetition", responseToPhraseId: null, ownerTrackId: null },
    ],
    motifs: [
      { id: "verse-motif", fingerprint: verseFingerprint, sourceSectionId: "section:verse:1", sourcePhraseId: "verse-phrase", parentMotifId: null, transformation: "repetition", ownerTrackId: "piano", evidenceSha256: "evidence" },
      { id: "chorus-motif", fingerprint: chorusFingerprint, sourceSectionId: "section:chorus:2", sourcePhraseId: "chorus-phrase", parentMotifId: "verse-motif", transformation: "rhythmic_variation", ownerTrackId: "piano", evidenceSha256: "evidence" },
      { id: "bass-motif", fingerprint: emptyFingerprint, sourceSectionId: "section:chorus:2", sourcePhraseId: "bass-chorus-phrase", parentMotifId: null, transformation: "repetition", ownerTrackId: "bass", evidenceSha256: "evidence" },
      { id: "silence-motif", fingerprint: silenceFingerprint, sourceSectionId: "section:chorus:2", sourcePhraseId: "vocal-silence", parentMotifId: null, transformation: "repetition", ownerTrackId: null, evidenceSha256: "evidence" },
    ],
  } as ArrangementPlan["compositionIntelligence"];
  const originalPlan = { ...plan, compositionIntelligence: reasoning };
  const proposedReasoning = structuredClone(reasoning)!;
  proposedReasoning.motifs.find((motif) => motif.id === "chorus-motif")!.fingerprint = "repaired-chorus";
  proposedReasoning.motifs.find((motif) => motif.id === "bass-motif")!.fingerprint = "wrong-bass";
  proposedReasoning.phrases.find((phrase) => phrase.id === "chorus-phrase")!.transformation = "register_displacement";
  proposedReasoning.phrases.find((phrase) => phrase.id === "chorus-repetition")!.tension = .7;
  proposedReasoning.phrases.find((phrase) => phrase.id === "vocal-silence")!.tension = .35;
  proposedReasoning.motifs.find((motif) => motif.id === "silence-motif")!.fingerprint = "wrong-silence";
  const proposedPiano = structuredClone(piano);
  proposedPiano.notes = proposedPiano.notes.map((note) =>
    note.id === "crosses-repair-start"
      ? { ...note, pitch: 20 }
      : note.id === "chorus-note"
        ? { ...note, pitch: 69, motif: { ...note.motif!, fingerprint: "proposed" } }
        : note.id === "silence-note"
          ? { ...note, pitch: 65, motif: { ...note.motif!, fingerprint: "proposed" } }
          : note);
  const finding = normalizeRepairFinding({
    id: "motif-repair",
    affectedSections: ["chorus"],
    startBar: 5,
    endBar: 6,
    affectedTrackIds: ["piano"],
    musicalReason: "Repair the developed chorus gesture.",
  }, originalPlan, [piano, bass]);
  const proposedBass = structuredClone(bass);
  proposedBass.performanceEvidence!.performedMaterialSha256 = "generated-digest";
  const result = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate",
      sourceCandidateLabel: "Original",
      sourceScore: .5,
      seed: 3,
      maxAttempts: 2,
      finding,
      plan: originalPlan,
      trackModels: [piano, bass],
    },
    proposedPlan: { ...plan, compositionIntelligence: proposedReasoning },
    proposedTrackModels: [proposedPiano, proposedBass],
    timeBounds: { start: 16, end: 24 },
  });
  assert.equal(result.outsideScopePreserved, true);
  assert.deepEqual(result.trackModels.find((track) => track.id === "bass"), bass);
  assert.equal(
    JSON.stringify(result.trackModels[0].notes.find((note) => note.id === "verse-note")?.motif),
    JSON.stringify(piano.notes.find((note) => note.id === "verse-note")?.motif),
  );
  assert.equal(
    JSON.stringify(result.trackModels[0].notes.find((note) => note.id === "crosses-repair-start")?.motif),
    JSON.stringify(piano.notes.find((note) => note.id === "crosses-repair-start")?.motif),
  );
  assert.deepEqual(
    result.plan.compositionIntelligence?.motifs.find((motif) => motif.id === "verse-motif"),
    reasoning?.motifs[0],
  );
  const finalChorusMaterial = result.trackModels[0].notes.filter((note) =>
    note.motif?.id === "chorus-motif" && note.motif.phraseId === "chorus-phrase");
  const finalChorusFingerprint = canonicalMotifFingerprint(finalChorusMaterial);
  assert.equal(result.plan.compositionIntelligence?.motifs.find((motif) =>
    motif.id === "chorus-motif")?.fingerprint, finalChorusFingerprint);
  assert.equal(finalChorusMaterial.find((note) => note.id === "chorus-note")
    ?.motif?.fingerprint, finalChorusFingerprint);
  assert.equal(finalChorusMaterial.find((note) => note.id === "crosses-repair-start")
    ?.motif?.fingerprint, chorusFingerprint);
  assert.equal(finalChorusMaterial.find((note) =>
    note.id === "crosses-repair-start")?.pitch, 62);
  assert.equal(finalChorusMaterial.find((note) => note.id === "chorus-note")?.pitch, 69);
  assert.equal(
    result.plan.compositionIntelligence?.phrases.find((phrase) => phrase.id === "chorus-phrase")?.transformation,
    "register_displacement",
  );
  assert.equal(
    result.plan.compositionIntelligence?.motifs.find((motif) => motif.id === "bass-motif")?.fingerprint,
    emptyFingerprint,
  );
  assert.equal(
    result.plan.compositionIntelligence?.motifs.filter((motif) => motif.id === "verse-motif").length,
    1,
  );
  assert.equal(
    result.plan.compositionIntelligence?.phrases.find((phrase) =>
      phrase.id === "chorus-repetition")?.tension,
    .7,
  );
  const finalSilenceMaterial = result.trackModels[0].notes.filter((note) =>
    note.motif?.id === "silence-motif");
  const finalSilenceFingerprint = canonicalMotifFingerprint(finalSilenceMaterial);
  assert.equal(result.plan.compositionIntelligence?.motifs.find((motif) =>
    motif.id === "silence-motif")?.fingerprint, finalSilenceFingerprint);
  assert.equal(result.plan.compositionIntelligence?.phrases.find((phrase) =>
    phrase.id === "vocal-silence")?.tension, .35);
  const invalidIdentity = structuredClone(proposedReasoning);
  invalidIdentity.phrases.find((phrase) => phrase.id === "chorus-phrase")!.motifRef = "replacement-id";
  assert.throws(() => applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate",
      sourceCandidateLabel: "Original",
      sourceScore: .5,
      seed: 3,
      maxAttempts: 2,
      finding,
      plan: originalPlan,
      trackModels: [piano],
    },
    proposedPlan: { ...plan, compositionIntelligence: invalidIdentity },
    proposedTrackModels: [piano],
    timeBounds: { start: 16, end: 24 },
  }), /preserve motif and phrase ownership identity/);
  const invalidSource = structuredClone(proposedReasoning);
  invalidSource.motifs.find((motif) => motif.id === "chorus-motif")!.sourcePhraseId =
    "chorus-repetition";
  assert.throws(() => applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate",
      sourceCandidateLabel: "Original",
      sourceScore: .5,
      seed: 3,
      maxAttempts: 2,
      finding,
      plan: originalPlan,
      trackModels: [piano],
    },
    proposedPlan: { ...plan, compositionIntelligence: invalidSource },
    proposedTrackModels: [proposedPiano],
    timeBounds: { start: 16, end: 24 },
  }), /preserve canonical motif source lineage/);
  const duplicateIdentity = structuredClone(proposedReasoning);
  duplicateIdentity.motifs.push(structuredClone(duplicateIdentity.motifs[0]));
  assert.throws(() => applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "candidate",
      sourceCandidateLabel: "Original",
      sourceScore: .5,
      seed: 3,
      maxAttempts: 2,
      finding,
      plan: originalPlan,
      trackModels: [piano],
    },
    proposedPlan: { ...plan, compositionIntelligence: duplicateIdentity },
    proposedTrackModels: [proposedPiano],
    timeBounds: { start: 16, end: 24 },
  }), /unique motif identities/);
});

type RepairMatrixFixture = {
  songModel: SongModelData;
  plan: ArrangementPlan;
  tracks: TrackModel[];
  harmonyDecisions: HarmonyDecisionEvidence[];
};

const repairMatrixFixture = (): RepairMatrixFixture => {
  const matrixPlan = structuredClone(plan);
  matrixPlan.style = {
    ...matrixPlan.style,
    orchestration: { density: .5 },
  } as ArrangementPlan["style"];
  matrixPlan.provenance = {
    model: "matrix", version: "1", parameters: {}, parentIds: ["source-plan"],
    createdBy: "test",
  };
  matrixPlan.sections[0].tracks = { piano: "harmony", strings: "counterline" };
  matrixPlan.sections[0].activeTracks = ["piano", "strings"];
  matrixPlan.sections[1].tracks = { piano: "harmony", strings: "counterline" };
  matrixPlan.sections[1].activeTracks = ["piano", "strings"];
  matrixPlan.sections[0].trackDirectives = {
    piano: { musicalFunction: "harmonic_support", register: "middle" },
    strings: { musicalFunction: "countermelody", register: "middle" },
  };
  matrixPlan.sections[1].trackDirectives = {
    piano: { musicalFunction: "harmonic_support", register: "middle" },
    strings: { musicalFunction: "countermelody", register: "middle" },
  };
  matrixPlan.hierarchy!.song.climaxSectionId = "section:chorus:2";
  matrixPlan.hierarchy!.phrases[0] = {
    ...matrixPlan.hierarchy!.phrases[0],
    id: "matrix-phrase", sectionId: "section:chorus:2", startBar: 5, endBar: 8,
  };
  matrixPlan.hierarchy!.sections[1].phraseIds = ["matrix-phrase"];
  const fingerprint = canonicalMotifFingerprint([
    { start: 16, duration: .5, pitch: 67 },
    { start: 18, duration: .5, pitch: 70 },
    { start: 20, duration: .5, pitch: 68 },
  ]);
  matrixPlan.compositionIntelligence = {
    version: "2.0", mode: "reasoning_core",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: 335, evidenceSha256: fingerprint, songIntent: "develop_observed_form",
    motifs: [{
      id: "matrix-motif", fingerprint, sourceSectionId: "section:chorus:2",
      sourcePhraseId: "matrix-phrase", parentMotifId: null, transformation: "repetition",
      ownerTrackId: "strings", evidenceSha256: fingerprint,
    }],
    phrases: [{
      id: "matrix-phrase", sectionId: "section:chorus:2", startBar: 5, endBar: 8,
      intent: "state", tension: .5, motifRef: "matrix-motif",
      sourceMotifRef: "matrix-motif", intention: "foreground",
      transformation: "repetition", responseToPhraseId: null, ownerTrackId: "strings",
    }],
    instrumentRoles: [
      { trackId: "piano", function: "harmony", authority: "project_track" },
      { trackId: "strings", function: "counterline", authority: "project_track" },
    ],
    tensionRelease: [
      { sectionId: "section:verse:1", tension: .2, release: .1 },
      { sectionId: "section:chorus:2", tension: .8, release: .2 },
    ],
  };
  const matrixTrack = (id: string, role: string, pitch: number): TrackModel => {
    const value = track(id);
    value.role = role;
    value.instrument = id === "strings" ? "strings" : "piano";
    value.instrumentDefinition = {
      playableRange: { min: 21, max: 108 },
      constraints: { minNoteDuration: .05 },
    } as TrackModel["instrumentDefinition"];
    value.notes = [
      { id: `${id}-outside`, start: 2, duration: 1, pitch, velocity: 77 },
      { id: `${id}-a`, start: 16, duration: .5, pitch, velocity: 80 },
      { id: `${id}-b`, start: 18, duration: .5, pitch: pitch + 3, velocity: 82 },
      { id: `${id}-c`, start: 20, duration: .5, pitch: pitch + 1, velocity: 79 },
    ];
    value.appliedDirectives = [
      { section: "verse", startBar: 1, endBar: 4, start: 0, end: 16,
        directive: matrixPlan.sections[0].trackDirectives![id] },
      { section: "chorus", startBar: 5, endBar: 8, start: 16, end: 32,
        directive: matrixPlan.sections[1].trackDirectives![id] },
    ];
    return value;
  };
  const piano = matrixTrack("piano", "harmony", 60);
  const strings = matrixTrack("strings", "counterline", 67);
  strings.notes.slice(1).forEach((note) => {
    note.motif = {
      id: "matrix-motif", fingerprint, parentMotifId: null,
      transformation: "repetition", phraseId: "matrix-phrase",
      intention: "foreground", evidenceSha256: fingerprint,
    };
  });
  const anchor = matrixTrack("anchor", "texture", 48);
  anchor.performanceEvidence = {
    version: "1.0", seed: 335, compositionSeed: 335, performanceSeed: 336,
    instrumentFamily: "keys", articulationProfile: "matrix", timingProfile: "matrix",
    dynamicsProfile: "matrix", canonicalTimelineSha256: "timeline",
    phraseIds: [], sectionRanges: [],
    playability: { valid: true, checkedNotes: anchor.notes.length, violations: [] },
    performedMaterialSha256: "immutable-anchor-digest",
  };
  return {
    songModel: {
      tempoMap: [{ time: 0, bpm: 60, confidence: 1 }],
      meterMap: [{ bar: 1, meter: "4/4", confidence: 1 }],
    } as unknown as SongModelData,
    plan: matrixPlan,
    tracks: [piano, strings, anchor],
    harmonyDecisions: [],
  };
};

test("all nine v2 critic domains improve through validated bounded repairs without collateral mutation", () => {
  type MatrixCase = {
    dimension: Extract<CandidateMusicCriticDimension,
      "motifContinuityAndDevelopment" | "phraseIntent" | "vocalInteraction" |
      "roleDuplication" | "orchestralBalance" | "grooveCoordination" |
      "voiceLeading" | "countermelodyShape" | "dramaticTrajectory">;
    weak: (fixture: RepairMatrixFixture) => void;
    repair: (fixture: RepairMatrixFixture, finding: ReturnType<typeof normalizeRepairFinding>) => {
      plan: ArrangementPlan;
      tracks: TrackModel[];
    };
    forbid: (fixture: RepairMatrixFixture) => { plan: ArrangementPlan; tracks: TrackModel[] };
  };
  const affectedTrack = (
    fixture: RepairMatrixFixture,
    finding: ReturnType<typeof normalizeRepairFinding>,
  ) => fixture.tracks.find((item) => finding.affectedTrackIds.includes(item.id))!;
  const cases: MatrixCase[] = [
    {
      dimension: "motifContinuityAndDevelopment",
      weak: (fixture) => {
        fixture.tracks[1].notes[1].motif!.fingerprint = "stale-rendered-fingerprint";
      },
      repair: (fixture, finding) => {
        const tracks = structuredClone(fixture.tracks);
        const strings = tracks.find((item) => item.id === "strings")!;
        strings.notes = strings.notes.filter((note) => note.id !== "strings-a");
        strings.notes.push({
          ...fixture.tracks[1].notes[1], id: "strings-a-repaired",
        });
        return { plan: structuredClone(fixture.plan), tracks };
      },
      forbid: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[1].notes[1].velocity = 1;
        return { plan: structuredClone(fixture.plan), tracks };
      },
    },
    {
      dimension: "phraseIntent",
      weak: (fixture) => {
        fixture.tracks[1].notes = fixture.tracks[1].notes.filter((note) => !note.motif);
        fixture.plan.compositionIntelligence!.motifs![0].fingerprint =
          canonicalMotifFingerprint([{ start: 18, duration: .5, pitch: 67 }]);
        fixture.tracks[1].notes.push({
          id: "strings-untagged", start: 18, duration: .5, pitch: 67, velocity: 80,
        });
      },
      repair: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[1].notes = tracks[1].notes.filter((note) => note.id !== "strings-untagged");
        tracks[1].notes.push({
          id: "strings-phrase-repair", start: 18, duration: .5, pitch: 67, velocity: 80,
          motif: {
            id: "matrix-motif",
            fingerprint: fixture.plan.compositionIntelligence!.motifs![0].fingerprint,
            parentMotifId: null, transformation: "repetition", phraseId: "matrix-phrase",
            intention: "foreground",
            evidenceSha256: fixture.plan.compositionIntelligence!.evidenceSha256,
          },
        });
        return { plan: structuredClone(fixture.plan), tracks };
      },
      forbid: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[1].notes[1].pitch += 12;
        return { plan: structuredClone(fixture.plan), tracks };
      },
    },
    {
      dimension: "vocalInteraction",
      weak: (fixture) => {
        fixture.songModel.vocalEvidence = {
          status: "detected", reason: null, provenance: null, sampleRate: 48_000,
          channels: 1, frameSizeSamples: 1024,
          thresholds: { rms: .1, peak: .1, activitySample: .1, activityRatio: .1 },
          observedVoicedWindows: [{ start: 16, end: 18 }], observedSilentWindows: [],
        };
        fixture.plan.compositionIntelligence!.phrases[0].intent = "protect_vocal";
        fixture.tracks[0].notes[1].pitch = 76;
      },
      repair: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[0].notes[1].pitch = 55;
        return { plan: structuredClone(fixture.plan), tracks };
      },
      forbid: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[0].notes[1].start += .25;
        return { plan: structuredClone(fixture.plan), tracks };
      },
    },
    {
      dimension: "roleDuplication",
      weak: (fixture) => {
        fixture.plan.sections[1].trackDirectives!.strings.musicalFunction = "harmonic_support";
        fixture.tracks[1].appliedDirectives![1].directive =
          fixture.plan.sections[1].trackDirectives!.strings;
      },
      repair: (fixture) => {
        const repairedPlan = structuredClone(fixture.plan);
        repairedPlan.sections[1].trackDirectives!.strings.musicalFunction = "countermelody";
        return { plan: repairedPlan, tracks: structuredClone(fixture.tracks) };
      },
      forbid: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[0].notes[1].velocity = 1;
        return { plan: structuredClone(fixture.plan), tracks };
      },
    },
    {
      dimension: "orchestralBalance",
      weak: (fixture) => {
        fixture.plan.sections[0].trackDirectives = {};
        fixture.plan.sections[1].density = .5;
        fixture.tracks[1].notes = fixture.tracks[1].notes.filter((note) =>
          note.start < 16 || note.id === "strings-a");
        const retained = fixture.tracks[1].notes.find((note) => note.id === "strings-a")!;
        const retainedFingerprint = canonicalMotifFingerprint([retained]);
        fixture.plan.compositionIntelligence!.motifs![0].fingerprint = retainedFingerprint;
        retained.motif!.fingerprint = retainedFingerprint;
      },
      repair: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        const strings = tracks[1];
        for (let index = 0; index < 8; index += 1) {
          strings.notes.push({
            id: `strings-balance-${index}`, start: 16 + index * 1.5,
            duration: .25, pitch: 64 + index % 3, velocity: 72,
          });
        }
        return { plan: structuredClone(fixture.plan), tracks };
      },
      forbid: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[1].notes[1].start = 17.25;
        return { plan: structuredClone(fixture.plan), tracks };
      },
    },
    {
      dimension: "grooveCoordination",
      weak: (fixture) => {
        fixture.plan.compositionIntelligence!.groove = {
          version: "1.0", seed: 335,
          evidenceSha256: fixture.plan.compositionIntelligence!.evidenceSha256,
          subdivision: "8th", motifs: [], events: [],
          roles: [
            { trackId: "piano", responsibility: "pulse" },
            { trackId: "strings", responsibility: "syncopation" },
          ],
        };
        fixture.songModel.rhythmEvidence = [{
          provider: "test", version: "1", beats: [16, 18, 20, 22],
          downbeats: [16], tempoBpm: 60,
        }];
        fixture.tracks[0].notes = [
          { id: "piano-off-grid", start: 17.3, duration: .25, pitch: 60, velocity: 80 },
        ];
        const grooveMotifFingerprint = canonicalMotifFingerprint([
          { start: 18, duration: .25, pitch: 67 },
        ]);
        fixture.plan.compositionIntelligence!.motifs![0].fingerprint =
          grooveMotifFingerprint;
        fixture.tracks[1].notes = [
          {
            id: "strings-grid", start: 18, duration: .25, pitch: 67, velocity: 80,
            motif: {
              id: "matrix-motif", fingerprint: grooveMotifFingerprint,
              parentMotifId: null, transformation: "repetition",
              phraseId: "matrix-phrase", intention: "foreground",
              evidenceSha256: fixture.plan.compositionIntelligence!.evidenceSha256,
            },
          },
        ];
      },
      repair: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[0].notes[0].start = 17;
        return { plan: structuredClone(fixture.plan), tracks };
      },
      forbid: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[0].notes[0].velocity = 1;
        return { plan: structuredClone(fixture.plan), tracks };
      },
    },
    {
      dimension: "voiceLeading",
      weak: (fixture) => {
        fixture.harmonyDecisions = [{
          start: 16, end: 19, symbol: "C", source: "deterministic_candidate_scoring",
          voiceLeading: .3, candidateRationale: [
            { symbol: "C", function: "tonic", score: .2, melodyFit: .5,
              bassFit: .5, voiceLeading: .4, selected: false },
          ],
        }];
        fixture.tracks[0].notes[1].pitch = 48;
        fixture.tracks[0].notes[2].pitch = 84;
      },
      repair: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[0].notes[2].pitch = 52;
        return { plan: structuredClone(fixture.plan), tracks };
      },
      forbid: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[0].notes[1].velocity = 1;
        return { plan: structuredClone(fixture.plan), tracks };
      },
    },
    {
      dimension: "countermelodyShape",
      weak: (fixture) => {
        const intelligence = fixture.plan.compositionIntelligence!;
        intelligence.phrases[0].ownerTrackId = "piano";
        intelligence.motifs![0].ownerTrackId = "piano";
        const pianoMaterial = fixture.tracks[0].notes.slice(1);
        const pianoFingerprint = canonicalMotifFingerprint(pianoMaterial);
        intelligence.motifs![0].fingerprint = pianoFingerprint;
        pianoMaterial.forEach((note) => {
          note.motif = {
            id: "matrix-motif", fingerprint: pianoFingerprint, parentMotifId: null,
            transformation: "repetition", phraseId: "matrix-phrase",
            intention: "foreground",
            evidenceSha256: intelligence.evidenceSha256,
          };
        });
        fixture.tracks[1].notes = [
          { id: "strings-flat-a", start: 16, duration: .5, pitch: 67, velocity: 80 },
          { id: "strings-flat-b", start: 18, duration: .5, pitch: 67, velocity: 80 },
          { id: "strings-flat-c", start: 20, duration: .5, pitch: 67, velocity: 80 },
        ];
      },
      repair: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[1].notes = [
          { id: "strings-shaped-a", start: 16, duration: .5, pitch: 67, velocity: 80 },
          { id: "strings-shaped-b", start: 18, duration: .75, pitch: 72, velocity: 80 },
          { id: "strings-shaped-c", start: 20, duration: .5, pitch: 69, velocity: 80 },
        ];
        return { plan: structuredClone(fixture.plan), tracks };
      },
      forbid: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[1].notes[1].velocity = 1;
        return { plan: structuredClone(fixture.plan), tracks };
      },
    },
    {
      dimension: "dramaticTrajectory",
      weak: (fixture) => {
        fixture.plan.compositionIntelligence!.tensionRelease[0].tension = .9;
        fixture.plan.compositionIntelligence!.tensionRelease[1].tension = .4;
      },
      repair: (fixture) => {
        const repairedPlan = structuredClone(fixture.plan);
        repairedPlan.compositionIntelligence!.tensionRelease[0].tension = .2;
        repairedPlan.compositionIntelligence!.tensionRelease[1].tension = .8;
        return { plan: repairedPlan, tracks: structuredClone(fixture.tracks) };
      },
      forbid: (fixture) => {
        const tracks = structuredClone(fixture.tracks);
        tracks[0].notes[0].start = 3;
        return { plan: structuredClone(fixture.plan), tracks };
      },
    },
  ];

  for (const matrixCase of cases) {
    const fixture = repairMatrixFixture();
    matrixCase.weak(fixture);
    const before = evaluateCandidateMusicalFit(fixture);
    const beforeDimension = before.dimensions[matrixCase.dimension];
    const serverFinding = beforeDimension.findings[0];
    assert.ok(serverFinding, `${matrixCase.dimension}: evaluator authored a repair finding`);
    const finding = validateServerAuthoredRepairFinding(
      serverFinding.id, structuredClone(serverFinding), beforeDimension.findings,
      fixture.plan, fixture.tracks,
    );
    const bounds = repairTimeBounds(
      finding, fixture.songModel.tempoMap, fixture.songModel.meterMap,
    );
    const snapshot = {
      sourceCandidateId: "source", sourceCandidateLabel: "Source",
      sourceScore: before.score, seed: 335, maxAttempts: 2,
      finding, plan: fixture.plan, trackModels: fixture.tracks,
    };
    const proposal = matrixCase.repair(fixture, finding);
    const repaired = applyBoundedRepair({
      snapshot, proposedPlan: proposal.plan, proposedTrackModels: proposal.tracks,
      timeBounds: bounds,
    });
    const after = evaluateCandidateMusicalFit({
      songModel: fixture.songModel, plan: repaired.plan, tracks: repaired.trackModels,
      harmonyDecisions: fixture.harmonyDecisions,
    });
    const afterDimension = after.dimensions[matrixCase.dimension];
    assert.ok(
      afterDimension.score! > beforeDimension.score! ||
        !afterDimension.findings.some((item) => item.id === serverFinding.id),
      `${matrixCase.dimension}: score improves or exact issue clears`,
    );
    assert.equal(
      repaired.plan.compositionIntelligence?.seed,
      fixture.plan.compositionIntelligence?.seed,
      `${matrixCase.dimension}: composition seed`,
    );
    assert.deepEqual(
      repaired.plan.provenance.parentIds, fixture.plan.provenance.parentIds,
      `${matrixCase.dimension}: source parents`,
    );
    assert.deepEqual(
      repaired.plan.hierarchy, fixture.plan.hierarchy,
      `${matrixCase.dimension}: hierarchy`,
    );
    assert.deepEqual(
      repaired.plan.compositionIntelligence?.motifs,
      fixture.plan.compositionIntelligence?.motifs,
      `${matrixCase.dimension}: Composition Intelligence motifs`,
    );
    assert.deepEqual(
      repaired.plan.compositionIntelligence?.phrases,
      fixture.plan.compositionIntelligence?.phrases,
      `${matrixCase.dimension}: Composition Intelligence phrases`,
    );
    for (const sourceSection of fixture.plan.sections) {
      const whollyRepairable = finding.affectedSections.includes(sourceSection.section) &&
        sourceSection.startBar >= finding.startBar && sourceSection.endBar <= finding.endBar;
      if (!whollyRepairable) assert.deepEqual(
        repaired.plan.sections.find((item) => item.section === sourceSection.section),
        sourceSection,
        `${matrixCase.dimension}: unaffected plan section ${sourceSection.section}`,
      );
    }
    for (const sourceTrack of fixture.tracks.filter((item) =>
      !finding.affectedTrackIds.includes(item.id))) {
      assert.deepEqual(
        repaired.trackModels.find((item) => item.id === sourceTrack.id),
        sourceTrack,
        `${matrixCase.dimension}: unselected ${sourceTrack.id} notes, directives, motif tags, and performance digest`,
      );
    }
    for (const id of finding.affectedTrackIds) {
      const source = fixture.tracks.find((item) => item.id === id)!;
      const result = repaired.trackModels.find((item) => item.id === id)!;
      assert.deepEqual(
        result.notes.filter((note) => note.start < bounds.start || note.start + note.duration > bounds.end),
        source.notes.filter((note) => note.start < bounds.start || note.start + note.duration > bounds.end),
        `${matrixCase.dimension}: unrelated notes and motif tags`,
      );
      assert.deepEqual(
        result.appliedDirectives?.filter((item) =>
          item.startBar < finding.startBar || item.endBar > finding.endBar),
        source.appliedDirectives?.filter((item) =>
          item.startBar < finding.startBar || item.endBar > finding.endBar),
        `${matrixCase.dimension}: unrelated directives`,
      );
    }
    assert.equal(repaired.outsideScopePreserved, true, `${matrixCase.dimension}: preservation gate`);
    const forbidden = matrixCase.forbid(fixture);
    assert.throws(() => applyBoundedRepair({
      snapshot, proposedPlan: forbidden.plan, proposedTrackModels: forbidden.tracks,
      timeBounds: bounds,
    }), /does not permit|pitch change/, `${matrixCase.dimension}: forbidden mutation`);
    assert.ok(affectedTrack(fixture, finding), `${matrixCase.dimension}: affected production track`);
  }
});

test("materialized scoped motif fingerprint deltas remain bounded derived repair evidence", () => {
  const fixture = repairMatrixFixture();
  const intelligence = fixture.plan.compositionIntelligence!;
  const motif = intelligence.motifs![0];
  const phrase = intelligence.phrases[0];
  const strings = fixture.tracks.find((item) => item.id === "strings")!;
  strings.notes = [16, 18, 20].map((start, index) => ({
    id: `flat-counterline-${index}`, start, duration: .5, pitch: 67, velocity: 80,
    motif: {
      id: motif.id, fingerprint: "", parentMotifId: motif.parentMotifId,
      transformation: motif.transformation, phraseId: phrase.id,
      intention: phrase.intention, evidenceSha256: motif.evidenceSha256,
    },
  }));
  motif.fingerprint = canonicalMotifFingerprint(strings.notes);
  strings.notes.forEach((note) => { note.motif!.fingerprint = motif.fingerprint; });

  const piano = fixture.tracks.find((item) => item.id === "piano")!;
  const verseNote = piano.notes.find((note) => note.id === "piano-outside")!;
  const verseFingerprint = canonicalMotifFingerprint([verseNote]);
  verseNote.motif = {
    id: "unscoped-verse-motif", fingerprint: verseFingerprint,
    parentMotifId: null, transformation: "repetition", phraseId: "unscoped-verse-phrase",
    intention: "support", evidenceSha256: intelligence.evidenceSha256,
  };
  intelligence.phrases.push({
    id: "unscoped-verse-phrase", sectionId: "section:verse:1", startBar: 1, endBar: 4,
    intent: "state", tension: .2, motifRef: "unscoped-verse-motif",
    sourceMotifRef: "unscoped-verse-motif", intention: "support",
    transformation: "repetition", responseToPhraseId: null, ownerTrackId: "piano",
  });
  intelligence.motifs!.push({
    id: "unscoped-verse-motif", fingerprint: verseFingerprint,
    sourceSectionId: "section:verse:1", sourcePhraseId: "unscoped-verse-phrase",
    parentMotifId: null, transformation: "repetition", ownerTrackId: "piano",
    evidenceSha256: intelligence.evidenceSha256,
  });

  const before = evaluateCandidateMusicalFit(fixture);
  const serverFinding = before.dimensions.countermelodyShape.findings[0];
  assert.ok(serverFinding);
  const finding = validateServerAuthoredRepairFinding(
    serverFinding.id, structuredClone(serverFinding),
    before.dimensions.countermelodyShape.findings, fixture.plan, fixture.tracks,
  );
  const proposedPlan = structuredClone(fixture.plan);
  const proposedTracks = structuredClone(fixture.tracks);
  const proposedStrings = proposedTracks.find((item) => item.id === "strings")!;
  proposedStrings.notes = [
    { ...strings.notes[0], id: "shaped-counterline-0", pitch: 67 },
    { ...strings.notes[1], id: "shaped-counterline-1", pitch: 72, duration: .75 },
    { ...strings.notes[2], id: "shaped-counterline-2", pitch: 69 },
  ];
  const materializedTracks = synchronizeMotifLineage(
    proposedTracks, proposedPlan.compositionIntelligence,
  );
  assert.notEqual(
    proposedPlan.compositionIntelligence!.motifs!.find((item) =>
      item.id === motif.id)!.fingerprint,
    motif.fingerprint,
  );
  const repaired = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "source", sourceCandidateLabel: "Source",
      sourceScore: before.score, seed: 335, maxAttempts: 2,
      finding, plan: fixture.plan, trackModels: fixture.tracks,
    },
    proposedPlan,
    proposedTrackModels: materializedTracks,
    timeBounds: repairTimeBounds(
      finding, fixture.songModel.tempoMap, fixture.songModel.meterMap,
    ),
  });
  assert.equal(repaired.outsideScopePreserved, true);
  const after = evaluateCandidateMusicalFit({
    ...fixture, plan: repaired.plan, tracks: repaired.trackModels,
  });
  assert.ok(after.dimensions.countermelodyShape.score! >
    before.dimensions.countermelodyShape.score!);
  const repairedMotif = repaired.plan.compositionIntelligence!.motifs!.find((item) =>
    item.id === motif.id)!;
  const { fingerprint: _sourceFingerprint, ...sourceLineage } = motif;
  const { fingerprint: _repairedFingerprint, ...repairedLineage } = repairedMotif;
  assert.deepEqual(repairedLineage, sourceLineage);
  assert.equal(
    repairedMotif.fingerprint,
    canonicalMotifFingerprint(repaired.trackModels.find((item) =>
      item.id === "strings")!.notes.filter((note) =>
      note.motif?.id === motif.id && note.motif.phraseId === phrase.id)),
  );
  assert.deepEqual(
    repaired.plan.compositionIntelligence!.motifs!.find((item) =>
      item.id === "unscoped-verse-motif"),
    intelligence.motifs!.find((item) => item.id === "unscoped-verse-motif"),
  );
  assert.deepEqual(
    repaired.trackModels.find((item) => item.id === "piano")!.notes.find((note) =>
      note.id === "piano-outside")!.motif,
    verseNote.motif,
  );
});

test("materialized voice-leading voicing repair reconciles a bar-local longer-motif fingerprint", () => {
  const fixture = repairMatrixFixture();
  const intelligence = fixture.plan.compositionIntelligence!;
  const phrase = intelligence.phrases[0];
  const motif = intelligence.motifs![0];
  phrase.ownerTrackId = "piano";
  motif.ownerTrackId = "piano";
  const piano = fixture.tracks.find((item) => item.id === "piano")!;
  piano.notes = [
    piano.notes[0],
    { id: "voicing-a", start: 16, duration: .5, pitch: 48, velocity: 80 },
    { id: "voicing-b", start: 18, duration: .5, pitch: 84, velocity: 80 },
    { id: "voicing-unscoped", start: 20, duration: .5, pitch: 72, velocity: 80 },
  ];
  motif.fingerprint = canonicalMotifFingerprint(piano.notes.slice(1));
  piano.notes.slice(1).forEach((note) => {
    note.motif = {
      id: motif.id, fingerprint: motif.fingerprint, parentMotifId: motif.parentMotifId,
      transformation: motif.transformation, phraseId: phrase.id,
      intention: phrase.intention, evidenceSha256: motif.evidenceSha256,
    };
  });
  fixture.harmonyDecisions = [{
    start: 16, end: 19, symbol: "C", source: "deterministic_candidate_scoring",
    voiceLeading: .3,
  }];
  const before = evaluateCandidateMusicalFit(fixture);
  const serverFinding = before.dimensions.voiceLeading.findings[0];
  assert.ok(serverFinding);
  const finding = validateServerAuthoredRepairFinding(
    serverFinding.id, structuredClone(serverFinding),
    before.dimensions.voiceLeading.findings, fixture.plan, fixture.tracks,
  );
  const proposedPlan = structuredClone(fixture.plan);
  const proposedTracks = structuredClone(fixture.tracks);
  proposedTracks.find((item) => item.id === "piano")!.notes.find((note) =>
    note.id === "voicing-b")!.pitch = 52;
  const materialized = synchronizeMotifLineage(
    proposedTracks, proposedPlan.compositionIntelligence,
  );
  const unscopedSourceNote = structuredClone(piano.notes.find((note) =>
    note.id === "voicing-unscoped")!);
  const repaired = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "source", sourceCandidateLabel: "Source",
      sourceScore: before.score, seed: 335, maxAttempts: 2,
      finding, plan: fixture.plan, trackModels: fixture.tracks,
    },
    proposedPlan, proposedTrackModels: materialized,
    timeBounds: repairTimeBounds(
      finding, fixture.songModel.tempoMap, fixture.songModel.meterMap,
    ),
  });
  assert.equal(repaired.outsideScopePreserved, true);
  const after = evaluateCandidateMusicalFit({
    ...fixture, plan: repaired.plan, tracks: repaired.trackModels,
  });
  assert.ok(after.dimensions.voiceLeading.score! >
    before.dimensions.voiceLeading.score!);
  const finalMotif = repaired.plan.compositionIntelligence!.motifs![0];
  const { fingerprint: _beforeFingerprint, ...beforeLineage } = motif;
  const { fingerprint: _afterFingerprint, ...afterLineage } = finalMotif;
  assert.deepEqual(afterLineage, beforeLineage);
  assert.equal(
    finalMotif.fingerprint,
    canonicalMotifFingerprint(repaired.trackModels.find((item) =>
      item.id === "piano")!.notes.filter((note) => note.motif?.id === motif.id)),
  );
  assert.deepEqual(
    repaired.trackModels.find((item) => item.id === "piano")!.notes.find((note) =>
      note.id === "voicing-unscoped"),
    unscopedSourceNote,
  );
});

test("materialized groove rhythm repair reconciles a subphrase longer-motif fingerprint", () => {
  const fixture = repairMatrixFixture();
  const intelligence = fixture.plan.compositionIntelligence!;
  const phrase = intelligence.phrases[0];
  const motif = intelligence.motifs![0];
  phrase.ownerTrackId = "piano";
  motif.ownerTrackId = "piano";
  intelligence.groove = {
    version: "1.0", seed: intelligence.seed,
    evidenceSha256: intelligence.evidenceSha256, subdivision: "8th",
    roles: [
      { trackId: "piano", responsibility: "pulse" },
      { trackId: "strings", responsibility: "syncopation" },
    ],
    motifs: [], events: [],
  };
  fixture.songModel.rhythmEvidence = [{
    provider: "test", version: "1", beats: [16, 18, 20, 22],
    downbeats: [16], tempoBpm: 60,
  }];
  const piano = fixture.tracks.find((item) => item.id === "piano")!;
  piano.notes = [
    { id: "groove-repair", start: 17.3, duration: .25, pitch: 60, velocity: 80 },
    { id: "groove-unscoped", start: 20, duration: .25, pitch: 64, velocity: 80 },
  ];
  motif.fingerprint = canonicalMotifFingerprint(piano.notes);
  piano.notes.forEach((note) => {
    note.motif = {
      id: motif.id, fingerprint: motif.fingerprint, parentMotifId: motif.parentMotifId,
      transformation: motif.transformation, phraseId: phrase.id,
      intention: phrase.intention, evidenceSha256: motif.evidenceSha256,
    };
  });
  const strings = fixture.tracks.find((item) => item.id === "strings")!;
  strings.notes = [{ id: "groove-partner", start: 18, duration: .25, pitch: 67, velocity: 80 }];
  const before = evaluateCandidateMusicalFit(fixture);
  const serverFinding = before.dimensions.grooveCoordination.findings.find((item) =>
    item.affectedTrackIds.includes("piano") && item.startBar === 5);
  assert.ok(serverFinding);
  const finding = validateServerAuthoredRepairFinding(
    serverFinding.id, structuredClone(serverFinding),
    before.dimensions.grooveCoordination.findings, fixture.plan, fixture.tracks,
  );
  const proposedPlan = structuredClone(fixture.plan);
  const proposedTracks = structuredClone(fixture.tracks);
  proposedTracks.find((item) => item.id === "piano")!.notes.find((note) =>
    note.id === "groove-repair")!.start = 17;
  const materialized = synchronizeMotifLineage(
    proposedTracks, proposedPlan.compositionIntelligence,
  );
  const unscopedSourceNote = structuredClone(piano.notes.find((note) =>
    note.id === "groove-unscoped")!);
  const repaired = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "source", sourceCandidateLabel: "Source",
      sourceScore: before.score, seed: 335, maxAttempts: 2,
      finding, plan: fixture.plan, trackModels: fixture.tracks,
    },
    proposedPlan, proposedTrackModels: materialized,
    timeBounds: repairTimeBounds(
      finding, fixture.songModel.tempoMap, fixture.songModel.meterMap,
    ),
  });
  assert.equal(repaired.outsideScopePreserved, true);
  const after = evaluateCandidateMusicalFit({
    ...fixture, plan: repaired.plan, tracks: repaired.trackModels,
  });
  assert.ok(after.dimensions.grooveCoordination.score! >
    before.dimensions.grooveCoordination.score!);
  const finalMotif = repaired.plan.compositionIntelligence!.motifs![0];
  const { fingerprint: _beforeFingerprint, ...beforeLineage } = motif;
  const { fingerprint: _afterFingerprint, ...afterLineage } = finalMotif;
  assert.deepEqual(afterLineage, beforeLineage);
  assert.equal(
    finalMotif.fingerprint,
    canonicalMotifFingerprint(repaired.trackModels.find((item) =>
      item.id === "piano")!.notes.filter((note) => note.motif?.id === motif.id)),
  );
  assert.deepEqual(
    repaired.trackModels.find((item) => item.id === "piano")!.notes.find((note) =>
      note.id === "groove-unscoped"),
    unscopedSourceNote,
  );
});

test("materialized vocal repair reconciles fingerprint after scoped motif-note deletion", () => {
  const fixture = repairMatrixFixture();
  const intelligence = fixture.plan.compositionIntelligence!;
  const phrase = intelligence.phrases[0];
  const motif = intelligence.motifs![0];
  phrase.ownerTrackId = "piano";
  phrase.intent = "protect_vocal";
  motif.ownerTrackId = "piano";
  fixture.songModel.vocalEvidence = {
    status: "detected", reason: null, provenance: null, sampleRate: 48_000,
    channels: 1, frameSizeSamples: 1024,
    thresholds: { rms: .1, peak: .1, activitySample: .1, activityRatio: .1 },
    observedVoicedWindows: [{ start: 16, end: 18 }],
    observedSilentWindows: [],
  };
  const piano = fixture.tracks.find((item) => item.id === "piano")!;
  piano.notes = [
    { id: "intrusive-motif-note", start: 16, duration: .5, pitch: 76, velocity: 84 },
    { id: "support-motif-note", start: 18, duration: .5, pitch: 60, velocity: 76 },
    { id: "unscoped-motif-note", start: 20, duration: .5, pitch: 64, velocity: 72 },
  ];
  motif.fingerprint = canonicalMotifFingerprint(piano.notes);
  piano.notes.forEach((note) => {
    note.motif = {
      id: motif.id, fingerprint: motif.fingerprint, parentMotifId: motif.parentMotifId,
      transformation: motif.transformation, phraseId: phrase.id,
      intention: phrase.intention, evidenceSha256: motif.evidenceSha256,
    };
  });
  const before = evaluateCandidateMusicalFit(fixture);
  const serverFinding = before.dimensions.vocalInteraction.findings.find((item) =>
    item.affectedTrackIds.includes("piano"));
  assert.ok(serverFinding);
  const finding = validateServerAuthoredRepairFinding(
    serverFinding.id, structuredClone(serverFinding),
    before.dimensions.vocalInteraction.findings, fixture.plan, fixture.tracks,
  );
  const proposedPlan = structuredClone(fixture.plan);
  const proposedTracks = structuredClone(fixture.tracks);
  const proposedPiano = proposedTracks.find((item) => item.id === "piano")!;
  proposedPiano.notes = proposedPiano.notes.filter((note) =>
    note.id !== "intrusive-motif-note");
  const materialized = synchronizeMotifLineage(
    proposedTracks, proposedPlan.compositionIntelligence,
  );
  assert.notEqual(
    proposedPlan.compositionIntelligence!.motifs![0].fingerprint,
    motif.fingerprint,
  );
  const unscopedSourceNote = structuredClone(piano.notes.find((note) =>
    note.id === "unscoped-motif-note")!);
  const repaired = applyBoundedRepair({
    snapshot: {
      sourceCandidateId: "source", sourceCandidateLabel: "Source",
      sourceScore: before.score, seed: 335, maxAttempts: 2,
      finding, plan: fixture.plan, trackModels: fixture.tracks,
    },
    proposedPlan, proposedTrackModels: materialized,
    timeBounds: repairTimeBounds(
      finding, fixture.songModel.tempoMap, fixture.songModel.meterMap,
    ),
  });
  assert.equal(repaired.outsideScopePreserved, true);
  const after = evaluateCandidateMusicalFit({
    ...fixture, plan: repaired.plan, tracks: repaired.trackModels,
  });
  assert.ok(after.dimensions.vocalInteraction.score! >
    before.dimensions.vocalInteraction.score!);
  assert.deepEqual(after.dimensions.vocalInteraction.findings, []);
  const finalMotif = repaired.plan.compositionIntelligence!.motifs![0];
  const { fingerprint: _beforeFingerprint, ...beforeLineage } = motif;
  const { fingerprint: _afterFingerprint, ...afterLineage } = finalMotif;
  assert.deepEqual(afterLineage, beforeLineage);
  assert.equal(
    finalMotif.fingerprint,
    canonicalMotifFingerprint(repaired.trackModels.find((item) =>
      item.id === "piano")!.notes.filter((note) => note.motif?.id === motif.id)),
  );
  assert.deepEqual(
    repaired.trackModels.find((item) => item.id === "piano")!.notes.find((note) =>
      note.id === "unscoped-motif-note"),
    unscopedSourceNote,
  );
});

test("notes-only repairs reject plan hierarchy and composition-intelligence mutations", () => {
  const piano = track("piano");
  const finding = normalizeRepairFinding({
    id: "notes-only", affectedSections: ["chorus"], startBar: 5, endBar: 8,
    affectedTrackIds: ["piano"], musicalReason: "Only replace notes.",
    permissibleRepairOperations: ["adjust_notes"],
  }, plan, [piano]);
  for (const mutate of [
    (value: ArrangementPlan) => { value.hierarchy!.song.climaxSectionId = "section:verse:1"; },
    (value: ArrangementPlan) => {
      value.compositionIntelligence = {
        version: "2.0", mode: "reasoning_core",
        precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
        seed: 1, evidenceSha256: "e", songIntent: "preserve_observed_form",
        motifs: [], tensionRelease: [], phrases: [], instrumentRoles: [],
      };
    },
  ]) {
    const proposed = structuredClone(plan);
    mutate(proposed);
    assert.throws(() => applyBoundedRepair({
      snapshot: { sourceCandidateId: "source", sourceCandidateLabel: "Source", sourceScore: .5,
        seed: 7, maxAttempts: 2, finding, plan, trackModels: [piano] },
      proposedPlan: proposed, proposedTrackModels: [piano], timeBounds: { start: 16, end: 32 },
    }), /adjust_directive/);
  }
  const regenerated = structuredClone(plan);
  regenerated.sections[1].energy = .1;
  regenerated.sections[1].density = .1;
  const preserved = applyBoundedRepair({
    snapshot: { sourceCandidateId: "source", sourceCandidateLabel: "Source", sourceScore: .5,
      seed: 7, maxAttempts: 2, finding, plan, trackModels: [piano] },
    proposedPlan: regenerated, proposedTrackModels: [piano], timeBounds: { start: 16, end: 32 },
  });
  assert.equal(preserved.plan.sections[1].energy, plan.sections[1].energy);
  assert.equal(preserved.plan.sections[1].density, plan.sections[1].density);
});

test("notes-only repair ignores regenerated reasoning seed and preserves source identity", () => {
  const piano = track("piano");
  const intelligence = {
    version: "2.0", mode: "reasoning_core",
    precedence: ["song_intent", "dramatic_arc", "section_function", "phrase_intent", "instrument_role", "motif", "harmony_rhythm_voicing", "event"],
    seed: 17, evidenceSha256: "source-evidence", songIntent: "preserve_observed_form",
    motifs: [], tensionRelease: [], phrases: [], instrumentRoles: [],
  } as ArrangementPlan["compositionIntelligence"];
  const sourcePlan = { ...plan, compositionIntelligence: intelligence };
  const finding = normalizeRepairFinding({
    id: "seed-noise", affectedSections: ["chorus"], startBar: 5, endBar: 8,
    affectedTrackIds: ["piano"], musicalReason: "Repair notes only.",
    permissibleRepairOperations: ["adjust_notes"],
  }, sourcePlan, [piano]);
  const proposedPlan = structuredClone(sourcePlan);
  proposedPlan.compositionIntelligence!.seed = 999;
  proposedPlan.compositionIntelligence!.evidenceSha256 = "generated-container-noise";
  const result = applyBoundedRepair({
    snapshot: { sourceCandidateId: "source", sourceCandidateLabel: "Source", sourceScore: .5,
      seed: 17, maxAttempts: 2, finding, plan: sourcePlan, trackModels: [piano] },
    proposedPlan, proposedTrackModels: [piano], timeBounds: { start: 16, end: 32 },
  });
  assert.equal(result.plan.compositionIntelligence?.seed, 17);
  assert.equal(result.plan.compositionIntelligence?.evidenceSha256, "source-evidence");
  assert.deepEqual(result.plan.provenance, sourcePlan.provenance);
});