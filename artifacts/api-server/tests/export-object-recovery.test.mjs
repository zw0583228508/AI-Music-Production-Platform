import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundlePath = new URL(
  `./export-object-recovery.test-${process.pid}.tmp.mjs`,
  import.meta.url,
).pathname;
const rateBundlePath = new URL(
  `./export-cleanup-rate-integration.test-${process.pid}.tmp.mjs`,
  import.meta.url,
).pathname;
await build({
  stdin: {
    contents: `
      export {
        canonicalExportStorageUri,
        cleanupReviewedExportObjects,
        reclaimIncompleteExportObjects,
        reportUnreferencedExportObjects,
      } from "./src/lib/objectStorage";
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
const {
  canonicalExportStorageUri,
  cleanupReviewedExportObjects,
  reclaimIncompleteExportObjects,
  reportUnreferencedExportObjects,
} = await import(pathToFileURL(bundlePath).href);
await build({
  stdin: {
    contents: `
      export {
        createIsolatedDatabase,
        musicAuditEventsTable,
      } from "@workspace/db";
      export { and, eq, sql } from "drizzle-orm";
      export {
        recordExportCleanupRate,
      } from "./src/lib/exportJobs";
      export {
        EXPORT_CLEANUP_WINDOW_MS,
      } from "./src/lib/exportCleanupRate";
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "export-cleanup-rate-integration-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: rateBundlePath,
  external: [
    "@google-cloud/*",
    "@google/*",
    "pg-native",
    "pino",
    "pino-pretty",
    "thread-stream",
  ],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});
const {
  EXPORT_CLEANUP_WINDOW_MS,
  and,
  createIsolatedDatabase,
  eq,
  musicAuditEventsTable,
  recordExportCleanupRate,
  sql,
} = await import(pathToFileURL(rateBundlePath).href);
after(() => Promise.all([
  unlink(bundlePath).catch(() => undefined),
  unlink(rateBundlePath).catch(() => undefined),
]));

const cleanupService = `test.api-server.export-recovery.${process.pid}`;
const cleanupObserved = "export_cleanup_observed";
const cleanupAlert = "export_cleanup_rate_alert";
const cleanupRecovered = "export_cleanup_rate_recovered";

test("cleanup rate transitions stay single across concurrent database clients", async () => {
  const first = createIsolatedDatabase();
  const second = createIsolatedDatabase();
  const restarted = createIsolatedDatabase();
  const clients = [first, second, restarted];
  const logs = [];
  const cleanupLogger = {
    error(context, message) {
      logs.push({ level: "error", context, message });
    },
    info(context, message) {
      logs.push({ level: "info", context, message });
    },
  };
  const emptyReport = {
    discovered: 0,
    reclaimed: 0,
    preservedReady: 0,
    failedDeletions: 0,
    reclaimedStorageUris: [],
  };
  const startedAt = new Date("2026-09-06T12:00:00.000Z");

  try {
    await first.db.delete(musicAuditEventsTable)
      .where(eq(musicAuditEventsTable.resourceType, cleanupService));
    await first.db.insert(musicAuditEventsTable).values({
      id: `cleanup-seed-${process.pid}`,
      action: cleanupObserved,
      resourceType: cleanupService,
      outcome: "observed",
      metadata: {
        scope: "recovery_sweep",
        reclaimed: 2,
        failedDeletions: 0,
      },
      createdAt: startedAt,
    });

    await Promise.all([
      recordExportCleanupRate(
        { ...emptyReport, discovered: 1, reclaimed: 1 },
        "recovery_sweep",
        {
          database: first.db,
          now: startedAt,
          cleanupLogger,
          service: cleanupService,
        },
      ),
      recordExportCleanupRate(
        { ...emptyReport, discovered: 1, reclaimed: 1 },
        "recovery_sweep",
        {
          database: second.db,
          now: startedAt,
          cleanupLogger,
          service: cleanupService,
        },
      ),
    ]);

    const activeTransitions = await restarted.db.select()
      .from(musicAuditEventsTable)
      .where(and(
        eq(musicAuditEventsTable.resourceType, cleanupService),
        eq(musicAuditEventsTable.action, cleanupAlert),
      ));
    assert.equal(activeTransitions.length, 1);
    assert.equal(logs.filter(({ message }) => message === cleanupAlert).length, 1);

    const alertContextKeys = [
      "failedDeletionThreshold",
      "failedDeletions",
      "reclaimed",
      "reclaimedThreshold",
      "service",
      "windowEndedAt",
      "windowMinutes",
      "windowStartedAt",
    ];
    assert.deepEqual(
      Object.keys(activeTransitions[0].metadata).sort(),
      alertContextKeys,
    );
    assert.deepEqual(
      Object.keys(logs.find(({ message }) => message === cleanupAlert).context).sort(),
      alertContextKeys,
    );

    const recoveredAt = new Date(
      startedAt.getTime() + EXPORT_CLEANUP_WINDOW_MS + 1,
    );
    await Promise.all([
      recordExportCleanupRate(emptyReport, "recovery_sweep", {
        database: first.db,
        now: recoveredAt,
        cleanupLogger,
        service: cleanupService,
      }),
      recordExportCleanupRate(emptyReport, "recovery_sweep", {
        database: second.db,
        now: recoveredAt,
        cleanupLogger,
        service: cleanupService,
      }),
    ]);

    const recoveryTransitions = await restarted.db.select()
      .from(musicAuditEventsTable)
      .where(and(
        eq(musicAuditEventsTable.resourceType, cleanupService),
        eq(musicAuditEventsTable.action, cleanupRecovered),
      ));
    assert.equal(recoveryTransitions.length, 1);
    assert.equal(
      logs.filter(({ message }) => message === cleanupRecovered).length,
      1,
    );
    assert.deepEqual(
      Object.keys(recoveryTransitions[0].metadata).sort(),
      alertContextKeys,
    );
    assert.deepEqual(
      Object.keys(logs.find(({ message }) => message === cleanupRecovered).context).sort(),
      alertContextKeys,
    );
  } finally {
    await first.db.delete(musicAuditEventsTable)
      .where(eq(musicAuditEventsTable.resourceType, cleanupService))
      .catch(() => undefined);
    await Promise.all(clients.map(({ pool }) => pool.end()));
  }
});

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

function reconciliationStorage(names, createdAt) {
  const deleted = [];
  const files = names.map((name) => ({
    name,
    async getMetadata() {
      return [{ timeCreated: createdAt, size: "123" }];
    },
    async delete() {
      deleted.push(name);
    },
  }));
  return {
    deleted,
    client: {
      bucket(name) {
        assert.equal(name, "test-bucket");
        return {
          async getFiles({ prefix }) {
            return [files.filter((file) => file.name.startsWith(prefix))];
          },
          file(name) {
            return files.find((file) => file.name === name);
          },
        };
      },
    },
  };
}

test("ready export references normalize from current URLs and legacy object ids", () => {
  const hash = "2".repeat(64);
  const path = `/api/storage/objects/exports/export-ready-${hash}.zip`;
  assert.equal(canonicalExportStorageUri(path), path);
  assert.equal(canonicalExportStorageUri(`https://example.test${path}`), path);
  assert.equal(
    canonicalExportStorageUri("export-object://legacy-export"),
    "/api/storage/objects/exports/legacy-export.zip",
  );
  assert.equal(canonicalExportStorageUri("/api/exports/export-ready/download"), null);
});

test("historical reconciliation reports leftovers but protects non-package exports", async () => {
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const hash = "d".repeat(64);
  const current = `private/exports/export-old-${hash}.zip`;
  const ready = `private/exports/export-ready-${"e".repeat(64)}.zip`;
  const legacy = "private/exports/export-legacy.zip";
  const provider = "private/exports/generation/job/candidate/render.wav";
  const unknown = "private/exports/manual/render.wav";
  const storage = reconciliationStorage(
    [current, ready, legacy, provider, unknown],
    "2026-01-01T00:00:00.000Z",
  );
  const report = await reportUnreferencedExportObjects(
    [`/api/storage/objects/exports/export-ready-${"e".repeat(64)}.zip`],
    30 * 24 * 60 * 60 * 1000,
    new Date("2026-09-01T00:00:00.000Z"),
    storage.client,
  );

  assert.deepEqual(report.cleanupCandidates, [
    `/api/storage/objects/exports/export-old-${hash}.zip`,
  ]);
  assert.equal(report.entries.find((entry) => entry.objectName === ready).classification, "ready-reference");
  assert.equal(report.entries.find((entry) => entry.objectName === legacy).classification, "historical-download");
  assert.equal(report.entries.find((entry) => entry.objectName === provider).classification, "provider-generated");
  assert.equal(report.entries.find((entry) => entry.objectName === unknown).classification, "unknown-export-object");
  assert.deepEqual(storage.deleted, []);
});

test("cleanup requires reviewed dry run and rechecks the exact aged candidate set", async () => {
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const hash = "f".repeat(64);
  const name = `private/exports/export-orphan-${hash}.zip`;
  const uri = `/api/storage/objects/exports/export-orphan-${hash}.zip`;
  const storage = reconciliationStorage([name], "2026-01-01T00:00:00.000Z");
  const options = {
    readyStorageUris: [],
    minimumAgeMs: 30 * 24 * 60 * 60 * 1000,
    reviewedCandidates: [uri],
    now: new Date("2026-09-01T00:00:00.000Z"),
    storage: storage.client,
  };

  await assert.rejects(
    cleanupReviewedExportObjects({ ...options, dryRunReviewed: false }),
    /reviewed dry-run/,
  );
  assert.deepEqual(storage.deleted, []);
  assert.deepEqual(
    await cleanupReviewedExportObjects({ ...options, dryRunReviewed: true }),
    [uri],
  );
  assert.deepEqual(storage.deleted, [name]);
});

test("cleanup aborts if ready references changed after review", async () => {
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const hash = "1".repeat(64);
  const name = `private/exports/export-preserved-${hash}.zip`;
  const uri = `/api/storage/objects/exports/export-preserved-${hash}.zip`;
  const storage = reconciliationStorage([name], "2026-01-01T00:00:00.000Z");

  await assert.rejects(
    cleanupReviewedExportObjects({
      readyStorageUris: [uri],
      minimumAgeMs: 1,
      reviewedCandidates: [uri],
      dryRunReviewed: true,
      now: new Date("2026-09-01T00:00:00.000Z"),
      storage: storage.client,
    }),
    /no longer match/,
  );
  assert.deepEqual(storage.deleted, []);
});

test("objects without creation timestamps remain preservation-only", async () => {
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const hash = "3".repeat(64);
  const name = `private/exports/export-unknown-age-${hash}.zip`;
  const storage = reconciliationStorage([name], undefined);
  const file = storage.client.bucket("test-bucket").file(name);
  file.getMetadata = async () => [{
    updated: "2020-01-01T00:00:00.000Z",
    size: "123",
  }];

  const report = await reportUnreferencedExportObjects(
    [],
    1,
    new Date("2026-09-01T00:00:00.000Z"),
    storage.client,
  );

  assert.equal(report.entries[0].createdAt, null);
  assert.equal(report.entries[0].cleanupEligible, false);
  assert.deepEqual(report.cleanupCandidates, []);
});