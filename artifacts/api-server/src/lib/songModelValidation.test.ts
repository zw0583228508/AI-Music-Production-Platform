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