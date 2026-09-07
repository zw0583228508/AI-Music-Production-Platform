import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAnalysisField } from "./analysisReconciliation";

test("clusters nearby independent tempo observations deterministically", () => {
  const result = reconcileAnalysisField("tempo", [
    { provider: "MADMOM", value: 120, confidence: .9 },
    { provider: "BEAT_THIS", value: 122, confidence: .9 },
    { provider: "ALL_IN_ONE", value: 91, confidence: .95 },
  ]);
  // Cluster representatives follow stable provider ordering, rather than
  // response arrival order.
  assert.equal(result.value, 122);
  assert.equal(result.status, "detected");
  assert.deepEqual(result.providers, ["BEAT_THIS", "MADMOM"]);
  assert.ok((result.margin ?? 0) > .12);
});

test("does not count repeated evidence from one provider as corroboration", () => {
  const result = reconcileAnalysisField("key", [
    { provider: "ESSENTIA", value: "C major", confidence: .9 },
    { provider: "ESSENTIA", value: "C major", confidence: .8 },
  ]);
  assert.equal(result.value, "C major");
  assert.equal(result.status, "low_confidence");
  assert.deepEqual(result.providers, ["ESSENTIA"]);
});

test("abstains when competing meter evidence has no usable margin", () => {
  const result = reconcileAnalysisField("meter", [
    { provider: "ALL_IN_ONE", value: "4/4", confidence: .94 },
    { provider: "STANDARD_MIDI", value: "3/4", confidence: .8 },
  ]);
  assert.equal(result.value, null);
  assert.equal(result.status, "not_available");
  assert.ok(result.message?.includes("disagreed"));
});

test("normalizes key aliases before clustering", () => {
  const result = reconcileAnalysisField("key", [
    { provider: "ESSENTIA", value: "f♯ min", confidence: .9 },
  ]);
  assert.equal(result.value, "F# minor");
});