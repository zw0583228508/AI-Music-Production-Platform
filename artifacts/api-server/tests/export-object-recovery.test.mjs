import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundlePath = new URL(
  `./export-object-recovery.test-${process.pid}.tmp.mjs`,
  import.meta.url,
).pathname;
await build({
  stdin: {
    contents: `
      export { reclaimIncompleteExportObjects } from "./src/lib/objectStorage";
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "export-object-recovery-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
  external: ["@google-cloud/*", "@google/*"],
});
const { reclaimIncompleteExportObjects } = await import(pathToFileURL(bundlePath).href);
after(() => unlink(bundlePath).catch(() => undefined));

test("crash recovery deletes only unreferenced incomplete export packages", async () => {
  const previousPrivateDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  after(() => {
    if (previousPrivateDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = previousPrivateDir;
  });

  const exportId = "export-crashed-worker";
  const incomplete = `private/exports/${exportId}-${"a".repeat(64)}.zip`;
  const ready = `private/exports/${exportId}-${"b".repeat(64)}.zip`;
  const unrelated = `private/exports/another-export-${"c".repeat(64)}.zip`;
  const malformed = `private/exports/${exportId}-preview.wav`;
  const deleted = [];
  let listedPrefix;
  const files = [incomplete, ready, unrelated, malformed].map((name) => ({
    name,
    async delete() {
      deleted.push(name);
    },
  }));
  const storage = {
    bucket(name) {
      assert.equal(name, "test-bucket");
      return {
        async getFiles({ prefix }) {
          listedPrefix = prefix;
          return [files.filter((file) => file.name.startsWith(prefix))];
        },
      };
    },
  };

  const readyUri = `/api/storage/objects/exports/${exportId}-${"b".repeat(64)}.zip`;
  const report = await reclaimIncompleteExportObjects(
    exportId,
    [readyUri],
    storage,
  );

  assert.equal(listedPrefix, `private/exports/${exportId}-`);
  assert.deepEqual(deleted, [incomplete]);
  assert.deepEqual(report, {
    discovered: 2,
    reclaimed: 1,
    preservedReady: 1,
    failedDeletions: 0,
    reclaimedStorageUris: [
      `/api/storage/objects/exports/${exportId}-${"a".repeat(64)}.zip`,
    ],
  });
});

test("crash recovery reports deletion failures and continues reclaiming", async () => {
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const exportId = "export-delete-failure";
  const failed = `private/exports/${exportId}-${"d".repeat(64)}.zip`;
  const reclaimed = `private/exports/${exportId}-${"e".repeat(64)}.zip`;
  const storage = {
    bucket() {
      return {
        async getFiles() {
          return [[
            { name: failed, async delete() { throw new Error("storage unavailable"); } },
            { name: reclaimed, async delete() {} },
          ]];
        },
      };
    },
  };

  const report = await reclaimIncompleteExportObjects(exportId, [], storage);

  assert.deepEqual(report, {
    discovered: 2,
    reclaimed: 1,
    preservedReady: 0,
    failedDeletions: 1,
    reclaimedStorageUris: [
      `/api/storage/objects/exports/${exportId}-${"e".repeat(64)}.zip`,
    ],
  });
});