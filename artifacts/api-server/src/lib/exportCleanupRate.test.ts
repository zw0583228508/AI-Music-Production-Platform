import { strict as assert } from "node:assert";
import { test } from "node:test";
import { exportCleanupRateIsAlerting } from "./exportCleanupRate";

test("isolated cleanup stays below the operational alert threshold", () => {
  assert.equal(exportCleanupRateIsAlerting({
    reclaimed: 1,
    failedDeletions: 0,
  }), false);
});

test("repeated reclamation opens an operational alert", () => {
  assert.equal(exportCleanupRateIsAlerting({
    reclaimed: 3,
    failedDeletions: 0,
  }), true);
});

test("repeated deletion failures open an operational alert", () => {
  assert.equal(exportCleanupRateIsAlerting({
    reclaimed: 0,
    failedDeletions: 2,
  }), true);
});

test("a normal rate represents alert recovery", () => {
  assert.equal(exportCleanupRateIsAlerting({
    reclaimed: 2,
    failedDeletions: 1,
  }), false);
});