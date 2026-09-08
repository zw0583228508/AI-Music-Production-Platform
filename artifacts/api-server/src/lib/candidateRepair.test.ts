import assert from "node:assert/strict";
import test from "node:test";
import type { ArrangementPlan, TrackModel } from "@workspace/db";
import {
  applyBoundedRepair,
  normalizeRepairFinding,
  repairTimeBounds,
  validateServerAuthoredRepairFinding,
} from "./candidateRepair";
import { canonicalMotifFingerprint } from "./musicEngines";

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
      song: { ...plan.hierarchy.song, climaxSectionId: "section:verse:1" },
      sections: plan.hierarchy.sections.map((section) => ({
        ...section,
        targetEnergy: section.id === "section:chorus:2" ? .7 : .1,
      })),
      bars: plan.hierarchy.bars.map((bar) => bar.id === "bar:section:chorus:2:5"
        ? { ...bar, vocalSpace: "available" as const, phraseIds: [] }
        : bar),
      events: plan.hierarchy.events.map((event) => event.id === "event:section:chorus:2:5:piano"
        ? { ...event, intent: "use_vocal_space" as const, source: "vocal_space" as const }
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
    finding,
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
  }, originalPlan, [piano]);
  const result = applyBoundedRepair({
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
    proposedPlan: { ...plan, compositionIntelligence: proposedReasoning },
    proposedTrackModels: [proposedPiano],
    timeBounds: { start: 16, end: 24 },
  });
  assert.deepEqual(
    result.plan.compositionIntelligence?.motifs.find((motif) => motif.id === "verse-motif"),
    reasoning?.motifs[0],
  );
  const finalChorusMaterial = result.trackModels[0].notes.filter((note) =>
    note.motif?.id === "chorus-motif" && note.motif.phraseId === "chorus-phrase");
  const finalChorusFingerprint = canonicalMotifFingerprint(finalChorusMaterial);
  assert.equal(result.plan.compositionIntelligence?.motifs.find((motif) =>
    motif.id === "chorus-motif")?.fingerprint, finalChorusFingerprint);
  assert.ok(finalChorusMaterial.every((note) =>
    note.motif?.fingerprint === finalChorusFingerprint));
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