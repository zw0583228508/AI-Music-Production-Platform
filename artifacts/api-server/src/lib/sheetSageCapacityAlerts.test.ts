import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SHEETSAGE_CAPACITY_ALERT_THRESHOLD,
  isSheetSageCapacityAdmissionRejection,
  sheetSageCapacityIsSustained,
  sheetSageCapacityShouldEmitAlert,
} from "./sheetSageCapacityRate";

test("an isolated SheetSage capacity retry does not indicate saturation", () => {
  assert.equal(sheetSageCapacityIsSustained(1), false);
});

test("repeated SheetSage capacity retries indicate sustained saturation", () => {
  assert.equal(
    sheetSageCapacityIsSustained(SHEETSAGE_CAPACITY_ALERT_THRESHOLD),
    true,
  );
});

test("sustained saturation emits at most one alert per rolling window", () => {
  assert.equal(
    sheetSageCapacityShouldEmitAlert(
      SHEETSAGE_CAPACITY_ALERT_THRESHOLD,
      false,
    ),
    true,
  );
  assert.equal(
    sheetSageCapacityShouldEmitAlert(
      SHEETSAGE_CAPACITY_ALERT_THRESHOLD + 1,
      true,
    ),
    false,
  );
});

test("capacity admission is counted separately from auth and model failures", () => {
  assert.equal(
    isSheetSageCapacityAdmissionRejection(
      "SHEETSAGE",
      503,
      "capacity-admission",
    ),
    true,
  );
  assert.equal(
    isSheetSageCapacityAdmissionRejection("SHEETSAGE", 401, null),
    false,
  );
  assert.equal(
    isSheetSageCapacityAdmissionRejection("SHEETSAGE", 503, null),
    false,
  );
  assert.equal(
    isSheetSageCapacityAdmissionRejection(
      "OTHER_PROVIDER",
      503,
      "capacity-admission",
    ),
    false,
  );
});