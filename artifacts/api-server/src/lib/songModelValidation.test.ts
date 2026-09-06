import assert from "node:assert/strict";
import test from "node:test";
import {
  chordMelodyConflictSongModel,
  microNoteSongModel,
  missingSectionsSongModel,
  octaveJumpSongModel,
  tempoDriftSongModel,
  validSongModel,
} from "./__fixtures__/songModelValidation";
import {
  evaluateArrangementEligibility,
  fuseProviderSongModels,
  isLegacySongModel,
  refreshSongModelValidation,
  validateCanonicalSongModel,
  validateSongModelCore,
} from "./songModelValidation";

const issueCodes = (result: { issues: Array<{ code: string }> }) =>
  result.issues.map((item) => item.code);

test("accepts a provider response that satisfies the canonical core contract", () => {
  const result = validateSongModelCore(validSongModel);
  assert.equal(result.success, true);
  assert.deepEqual(result.issues, []);
});

test("preserves observed bass evidence and its active-path metadata through fusion serialization", () => {
  const bass = [{ start: 0.25, end: 0.75, pitch: 38, confidence: 0.91, provider: "BASS" }];
  const candidate = {
    ...validSongModel,
    bass,
    confidenceByField: { bass: 0.91 },
    fieldStatus: {
      bass: {
        status: "detected",
        confidence: 0.91,
        providers: ["BASS"],
        message: null,
        edited: false,
      },
    },
    provenance: { bass: ["BASS"] },
    providerProvenance: [{
      capability: "bass_evidence",
      provider: "BASS",
      version: "1.0.0",
      status: "ready" as const,
    }],
  };
  const fused = fuseProviderSongModels([
    { provider: "BASS", output: candidate, confidence: 0.91 },
  ]);
  assert.equal(fused.accepted, true);
  if (!fused.accepted) return;
  const persisted = JSON.parse(JSON.stringify(fused.model));
  assert.deepEqual(persisted.bass, bass);
  assert.equal(persisted.confidenceByField.bass, 0.91);
  assert.deepEqual(persisted.fieldStatus.bass.providers, ["BASS"]);
  assert.deepEqual(persisted.provenance.bass, ["BASS"]);
  assert.equal(persisted.providerProvenance[0].provider, "BASS");
  assert.equal(persisted.fusion.selectedProvider, "BASS");
  assert.equal(validateCanonicalSongModel(persisted).success, true);
  assert.deepEqual(refreshSongModelValidation(persisted).bass, bass);
});

test("keeps absent bass evidence unavailable rather than inferring a fallback", () => {
  const candidate = {
    ...validSongModel,
    bass: [],
    confidenceByField: { bass: 0 },
    fieldStatus: {
      bass: {
        status: "not_available",
        confidence: null,
        providers: [],
        message: "No bass provider returned observed bass evidence.",
        edited: false,
      },
    },
    provenance: { bass: [] },
  };
  const fused = fuseProviderSongModels([
    { provider: "analysis", output: candidate, confidence: 0.9 },
  ]);
  assert.equal(fused.accepted, true);
  if (!fused.accepted) return;
  const persisted = JSON.parse(JSON.stringify(fused.model));
  assert.deepEqual(persisted.bass, []);
  assert.equal(persisted.fieldStatus.bass.status, "not_available");
  assert.equal(persisted.fieldStatus.bass.confidence, null);
  assert.deepEqual(persisted.fieldStatus.bass.providers, []);
  assert.deepEqual(persisted.provenance.bass, []);
});

test("flags tempo drift without silently discarding the candidate", () => {
  const result = validateSongModelCore(tempoDriftSongModel);
  assert.equal(result.success, true);
  assert.ok(issueCodes(result).includes("TEMPO_DRIFT"));
});

test("flags abrupt octave tracking jumps", () => {
  const result = validateSongModelCore(octaveJumpSongModel);
  assert.equal(result.success, true);
  assert.ok(issueCodes(result).includes("OCTAVE_JUMP"));
});

test("rejects micro-notes", () => {
  const result = validateSongModelCore(microNoteSongModel);
  assert.equal(result.success, false);
  assert.ok(issueCodes(result).includes("MICRO_NOTE"));
});

test("rejects provider output with missing sections", () => {
  const result = validateSongModelCore(missingSectionsSongModel);
  assert.equal(result.success, false);
  assert.ok(issueCodes(result).includes("MISSING_SECTIONS"));
});

test("revalidation removes a stale missing-sections issue after correction", () => {
  const fused = fuseProviderSongModels([
    { provider: "valid", output: validSongModel, confidence: 0.9 },
  ]);
  assert.equal(fused.accepted, true);
  if (!fused.accepted) return;
  const stale = {
    ...fused.model,
    validation: {
      status: "flagged" as const,
      issues: [{
        code: "MISSING_SECTIONS",
        severity: "error" as const,
        path: "sections",
        message: "At least one structural section is required before arranging.",
      }],
    },
  };
  const refreshed = refreshSongModelValidation(stale);
  assert.equal(refreshed.validation.status, "accepted");
  assert.equal(issueCodes(refreshed.validation).includes("MISSING_SECTIONS"), false);
});

test("rejects high-confidence chord and melody conflicts", () => {
  const result = validateSongModelCore(chordMelodyConflictSongModel);
  assert.equal(result.success, false);
  assert.ok(issueCodes(result).includes("CHORD_MELODY_CONFLICT"));
});

test("fusion rejects malformed candidates and selects the compatible consensus", () => {
  const outlier = {
    ...validSongModel,
    tempoMap: [{ time: 0, bpm: 168, confidence: 0.96 }],
  };
  const result = fuseProviderSongModels([
    { provider: "tempo-outlier", output: outlier, confidence: 0.96 },
    { provider: "consensus-a", output: validSongModel, confidence: 0.91 },
    {
      provider: "consensus-b",
      output: {
        ...validSongModel,
        tempoMap: [{ time: 0, bpm: 121, confidence: 0.89 }],
      },
      confidence: 0.89,
    },
    { provider: "micro-notes", output: microNoteSongModel, confidence: 0.98 },
  ]);
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.model.fusion.selectedProvider, "consensus-a");
  assert.equal(
    result.decisions.find((decision) => decision.provider === "micro-notes")?.status,
    "rejected",
  );
  assert.equal(
    result.decisions.find((decision) => decision.provider === "tempo-outlier")?.status,
    "flagged",
  );
});

test("arrangement eligibility blocks invalid and low-confidence Song Models", () => {
  const fused = fuseProviderSongModels([
    { provider: "valid", output: validSongModel, confidence: 0.9 },
  ]);
  assert.equal(fused.accepted, true);
  if (!fused.accepted) return;

  assert.equal(validateCanonicalSongModel(fused.model).success, true);
  assert.equal(evaluateArrangementEligibility(fused.model, "ready", 0.9).eligible, true);

  const invalid = {
    ...fused.model,
    sections: [],
  };
  const invalidEligibility = evaluateArrangementEligibility(invalid, "ready", 0.9);
  assert.equal(invalidEligibility.eligible, false);
  if (!invalidEligibility.eligible) {
    assert.equal(invalidEligibility.code, "INVALID_SONG_MODEL");
    assert.match(invalidEligibility.action, /Re-run analysis/i);
  }

  const lowConfidence = evaluateArrangementEligibility(fused.model, "ready", 0.3);
  assert.equal(lowConfidence.eligible, false);
  if (!lowConfidence.eligible) {
    assert.equal(lowConfidence.code, "LOW_SONG_MODEL_CONFIDENCE");
  }
});

test("canonical validation rejects malformed nested chord decision evidence", () => {
  const fused = fuseProviderSongModels([
    { provider: "valid", output: validSongModel, confidence: 0.9 },
  ]);
  assert.equal(fused.accepted, true);
  if (!fused.accepted) return;

  const invalidConflict = structuredClone(fused.model) as any;
  invalidConflict.chords[0].melodyConflictEvidence = [{}];
  const conflictResult = validateCanonicalSongModel(invalidConflict);
  assert.equal(conflictResult.success, false);
  assert.ok(issueCodes(conflictResult).includes("INVALID_MELODY_CONFLICT_EVIDENCE"));

  const invalidCandidate = structuredClone(fused.model) as any;
  invalidCandidate.chords[0].candidateProvenance = [{
    candidateId: "candidate-1",
    provider: "provider",
    score: "high",
  }];
  const candidateResult = validateCanonicalSongModel(invalidCandidate);
  assert.equal(candidateResult.success, false);
  assert.ok(issueCodes(candidateResult).includes("INVALID_CHORD_CANDIDATE_PROVENANCE"));

  for (const timing of [
    { startBeat: -1, durationBeats: 4 },
    { startBeat: 0 },
    { startSeconds: 0, endSeconds: -1 },
    { startSeconds: 1, endSeconds: 2 },
  ]) {
    const invalidTiming = structuredClone(fused.model) as any;
    invalidTiming.chords[0].timing = timing;
    const timingResult = validateCanonicalSongModel(invalidTiming);
    assert.equal(timingResult.success, false);
    assert.ok(issueCodes(timingResult).includes("INVALID_CANONICAL_CHORD_TIMING"));
  }

  const invalidBassSupport = structuredClone(fused.model) as any;
  invalidBassSupport.chords[0].bassSupportEvidence = [{
    start: 0,
    end: 1,
    pitch: 128,
    confidence: 1,
    provider: "",
  }];
  const bassSupportResult = validateCanonicalSongModel(invalidBassSupport);
  assert.equal(bassSupportResult.success, false);
  assert.ok(issueCodes(bassSupportResult).includes("INVALID_CHORD_BASS_SUPPORT"));
});

test("arrangement eligibility blocks flagged tempo drift and octave jumps", () => {
  for (const output of [tempoDriftSongModel, octaveJumpSongModel]) {
    const fused = fuseProviderSongModels([
      { provider: "flagged", output, confidence: 0.9 },
    ]);
    assert.equal(fused.accepted, true);
    if (!fused.accepted) continue;
    const eligibility = evaluateArrangementEligibility(
      fused.model,
      "ready",
      fused.model.fusion.confidence,
    );
    assert.equal(eligibility.eligible, false);
    if (!eligibility.eligible) {
      assert.equal(eligibility.code, "SONG_MODEL_FLAGGED");
    }
  }
});

test("arrangement eligibility uses compatibility-adjusted fusion confidence", () => {
  const incompatible = {
    ...validSongModel,
    tempoMap: [{ time: 0, bpm: 168, confidence: 0.96 }],
  };
  const fused = fuseProviderSongModels([
    { provider: "tempo-a", output: validSongModel, confidence: 0.96 },
    { provider: "tempo-b", output: incompatible, confidence: 0.95 },
  ]);
  assert.equal(fused.accepted, true);
  if (!fused.accepted) return;
  assert.ok(fused.model.fusion.confidence < 0.55);
  const eligibility = evaluateArrangementEligibility(fused.model, "ready", 0.96);
  assert.equal(eligibility.eligible, false);
});

test("legacy backfill never auto-heals an invalid current-contract Song Model", () => {
  assert.equal(isLegacySongModel(validSongModel), true);
  assert.equal(isLegacySongModel({ ...validSongModel, contractVersion: "1.0", sections: [] }), false);
  assert.equal(isLegacySongModel(null), false);
});