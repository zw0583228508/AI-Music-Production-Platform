import assert from "node:assert/strict";
import test from "node:test";
import { deriveVocalPhrasing, detectVocalActivity, isEffectivelySilent } from "./audioSignal";

test("rejects empty, digital-silent, and non-finite decoded PCM", () => {
  assert.equal(isEffectivelySilent(new Float32Array()), true);
  assert.equal(isEffectivelySilent(new Float32Array(8_000)), true);
  assert.equal(isEffectivelySilent(new Float32Array([NaN, Infinity, -Infinity])), true);
});

test("does not reject quiet audible PCM or a short audible transient", () => {
  assert.equal(isEffectivelySilent(new Float32Array([0.0006, -0.0006, 0.0006])), false);
  const transient = new Float32Array(8_000);
  transient[4_000] = 0.02;
  assert.equal(isEffectivelySilent(transient), false);
});

test("derives deterministic merged voiced and silent windows from PCM only", () => {
  const samples = new Float32Array(4_000);
  samples.fill(0.1, 1_000, 2_000);
  samples.fill(-0.1, 2_000, 3_000);
  const evidence = detectVocalActivity(samples, 1_000);
  assert.equal(evidence.status, "detected");
  assert.deepEqual(evidence.observedSilentWindows, [
    { start: 0, end: 1 },
    { start: 3, end: 4 },
  ]);
  assert.deepEqual(evidence.observedVoicedWindows, [{ start: 1, end: 3 }]);
  assert.equal(evidence.frameSizeSamples, 100);
  assert.deepEqual(detectVocalActivity(samples, 1_000), evidence);
});

test("records silence-only decoded stem activity without inventing voiced windows", () => {
  const evidence = detectVocalActivity(new Float32Array(800), 8_000);
  assert.equal(evidence.status, "low_confidence");
  assert.deepEqual(evidence.observedVoicedWindows, []);
  assert.deepEqual(evidence.observedSilentWindows, [{ start: 0, end: 0.1 }]);
});

test("groups short gaps into phrases and records only bounded inter-phrase breaths", () => {
  const phrasing = deriveVocalPhrasing({
    status: "detected",
    frameSizeSamples: 100,
    thresholds: { rms: .01, peak: .02, activitySample: .005, activityRatio: .1 },
    observedVoicedWindows: [
      { start: .2, end: 1 },
      { start: 1.2, end: 2 },
      { start: 2.8, end: 4 },
    ],
    observedSilentWindows: [],
  });
  assert.deepEqual(phrasing.phrases, [
    { start: .2, end: 2, confidence: .8 },
    { start: 2.8, end: 4, confidence: .8 },
  ]);
  assert.deepEqual(phrasing.breaths, [
    { start: 2, end: 2.8, confidence: .65, kind: "inter_phrase" },
  ]);
});

test("silence does not invent phrases or breaths", () => {
  assert.deepEqual(deriveVocalPhrasing({
    status: "low_confidence",
    frameSizeSamples: 100,
    thresholds: { rms: .01, peak: .02, activitySample: .005, activityRatio: .1 },
    observedVoicedWindows: [],
    observedSilentWindows: [{ start: 0, end: 8 }],
  }), { phrases: [], breaths: [] });
});