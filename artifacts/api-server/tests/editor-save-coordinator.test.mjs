import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundlePath = `/tmp/editor-save-coordinator-test-${process.pid}.mjs`;
await build({
  entryPoints: [
    new URL(
      "../../music-studio/src/components/studio/editor-save-coordinator.ts",
      import.meta.url,
    ).pathname,
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
});
const { EditorConflictError, EditorSaveCoordinator } = await import(pathToFileURL(bundlePath).href);
after(() => unlink(bundlePath).catch(() => undefined));

test("an edit during an in-flight save remains dirty and schedules a newer save", () => {
  const coordinator = new EditorSaveCoordinator();
  coordinator.markChanged();
  const firstGeneration = coordinator.beginSave();
  assert.equal(firstGeneration, 1);
  assert.equal(coordinator.hasInFlightSave(), true);

  coordinator.markChanged();
  assert.equal(coordinator.acknowledge(firstGeneration), "resave");
  assert.equal(coordinator.hasInFlightSave(), false);

  const secondGeneration = coordinator.beginSave();
  assert.equal(secondGeneration, 2);
  assert.equal(coordinator.acknowledge(secondGeneration), "synced");
});

test("stale acknowledgements cannot clear a newer in-flight save", () => {
  const coordinator = new EditorSaveCoordinator();
  coordinator.markChanged();
  const generation = coordinator.beginSave();
  assert.equal(coordinator.acknowledge((generation ?? 0) - 1), "ignored");
  assert.equal(coordinator.hasInFlightSave(), true);
  coordinator.reject(generation);
  assert.equal(coordinator.hasInFlightSave(), false);
});

test("a version conflict unlocks autosave while preserving the local generation for explicit resolution", () => {
  const coordinator = new EditorSaveCoordinator();
  coordinator.markChanged();
  const conflictedGeneration = coordinator.beginSave();
  coordinator.reject(conflictedGeneration);
  assert.equal(coordinator.hasInFlightSave(), false);
  assert.equal(coordinator.beginSave(), conflictedGeneration);
  assert.match(new EditorConflictError().message, /load the latest revision or apply your local edit/i);
});