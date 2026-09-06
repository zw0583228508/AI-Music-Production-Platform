import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPORT_AUDIO_ROLES,
  exportAudioRole,
  isExportAudioRole,
  isFinalExportAudioRole,
} from "./exportAudioRoles";

test("export audio stages have one stable package-role contract", () => {
  assert.deepEqual(EXPORT_AUDIO_ROLES, {
    mix: "MIX",
    premaster: "PREMASTER",
    master: "MASTER",
  });
  assert.equal(exportAudioRole("mix"), "MIX");
  assert.equal(exportAudioRole("premaster"), "PREMASTER");
  assert.equal(exportAudioRole("master"), "MASTER");
  assert.equal(isExportAudioRole("MIX"), true);
  assert.equal(isExportAudioRole("PREMASTER"), true);
  assert.equal(isExportAudioRole("MASTER"), true);
  assert.equal(isFinalExportAudioRole("MIX"), true);
  assert.equal(isFinalExportAudioRole("PREMASTER"), false);
  assert.equal(isFinalExportAudioRole("MASTER"), true);
});