import assert from "node:assert/strict";
import test from "node:test";
import { isEffectivelySilent } from "./audioSignal";

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