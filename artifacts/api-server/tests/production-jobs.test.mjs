import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = `/tmp/music-production-jobs-${process.pid}.mjs`;
process.env.NODE_ENV = "production";
await build({
  stdin: {
    contents: `
      export {
        acknowledgeProductionJobCancellation,
        claimProductionJob,
        completeProductionJob,
        failProductionJob,
        heartbeatProductionJob,
        queueProductionJob,
        recoverProductionJobs,
        requestProductionJobCancellation,
        structuredJobError,
      } from "./src/lib/productionJobs";
      export {
        db,
        musicProjectsTable,
        musicUsageLedgerTable,
        productionJobsTable,
      } from "@workspace/db";
      export { eq, sql } from "drizzle-orm";
    `,
    resolveDir: apiDirectory,
    sourcefile: "production-jobs-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: harnessPath,
  external: ["pg-native"],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});

const {
  acknowledgeProductionJobCancellation,
  claimProductionJob,
  completeProductionJob,
  db,
  eq,
  failProductionJob,
  heartbeatProductionJob,
  musicProjectsTable,
  musicUsageLedgerTable,
  productionJobsTable,
  queueProductionJob,
  recoverProductionJobs,
  requestProductionJobCancellation,
  structuredJobError,
  sql,
} = await import(pathToFileURL(harnessPath).href);

const projectId = `production-jobs-${process.pid}`;
const ownerId = `production-owner-${process.pid}`;
const ledgerFailureTrigger = `test_ledger_atomicity_${process.pid}`;

async function withFailingLedgerUpdates(operation) {
  await db.execute(sql.raw(`
    create or replace function ${ledgerFailureTrigger}_fn()
    returns trigger language plpgsql as $$
    begin
      if new.owner_id = '${ownerId}' then
        raise exception 'forced ledger transition failure';
      end if;
      return new;
    end;
    $$;
    drop trigger if exists ${ledgerFailureTrigger} on music_usage_ledger;
    create trigger ${ledgerFailureTrigger}
      before update on music_usage_ledger
      for each row execute function ${ledgerFailureTrigger}_fn();
  `));
  try {
    return await operation();
  } finally {
    await db.execute(sql.raw(`
      drop trigger if exists ${ledgerFailureTrigger} on music_usage_ledger;
      drop function if exists ${ledgerFailureTrigger}_fn();
    `));
  }
}

async function assertJobAndLedgerStatus(jobId, jobStatus, ledgerStatus) {
  const [[job], [ledger]] = await Promise.all([
    db.select().from(productionJobsTable).where(eq(productionJobsTable.id, jobId)),
    db.select().from(musicUsageLedgerTable).where(eq(musicUsageLedgerTable.jobId, jobId)),
  ]);
  assert.equal(job.status, jobStatus);
  assert.equal(ledger.status, ledgerStatus);
}

function isForcedLedgerFailure(error) {
  return error instanceof Error &&
    error.cause instanceof Error &&
    error.cause.message === "forced ledger transition failure";
}

test("structured job errors survive a throwing message getter", () => {
  const hostile = Object.create(null, {
    message: {
      get() {
        throw new Error("hostile message getter escaped");
      },
    },
  });

  assert.deepEqual(structuredJobError(hostile), {
    code: "PRODUCTION_JOB_FAILED",
    message: "Production job failed",
    retryable: true,
  });
});

test("structured job errors survive throwing string and primitive conversion", () => {
  const hostileConversions = [
    {
      message: {
        toString() {
          throw new Error("hostile string conversion escaped");
        },
      },
    },
    {
      message: {
        [Symbol.toPrimitive]() {
          throw new Error("hostile primitive conversion escaped");
        },
      },
    },
  ];

  for (const hostile of hostileConversions) {
    assert.deepEqual(structuredJobError(hostile, "HOST_FAILURE"), {
      code: "HOST_FAILURE",
      message: "Production job failed",
      retryable: true,
    });
  }
});

test("structured job errors preserve a structured permanent-failure signal across varied diagnostics", () => {
  const diagnostics = [
    `  invalid\u0000license  ${"x".repeat(400)}`,
    "The requested model entitlement is unavailable for this account",
    "Provider rejected this operation permanently",
  ];

  for (const message of diagnostics) {
    const formatted = structuredJobError({
      message,
      retryable: false,
    });
    assert.equal(formatted.retryable, false);
  }

  const formatted = structuredJobError({
    message: diagnostics[0],
    retryable: false,
  });

  assert.equal(formatted.message.length, 240);
  assert.match(formatted.message, /^invalid license /u);
  assert.match(formatted.message, /\.\.\.$/u);
});

test("unknown job failures use the documented retryable default regardless of wording", () => {
  for (const message of [
    "invalid license",
    "Provider response could not be classified",
  ]) {
    assert.equal(structuredJobError({ message }).retryable, true);
  }
});

test("structured transient failures remain retryable regardless of wording", () => {
  assert.equal(
    structuredJobError({
      message: "invalid license",
      retryable: true,
    }).retryable,
    true,
  );
});

test("malformed or hostile retryability signals use the conservative default", () => {
  const hostile = Object.create(null, {
    message: { value: "Permanent provider failure" },
    retryable: {
      get() {
        throw new Error("hostile retryable getter escaped");
      },
    },
  });

  assert.equal(structuredJobError(hostile).retryable, true);
  assert.equal(
    structuredJobError({ message: "Permanent provider failure", retryable: "false" }).retryable,
    true,
  );
});

before(async () => {
  await db.insert(musicProjectsTable).values({
    id: projectId,
    name: "Production queue test",
    sourceType: "PROMPT",
    ownerId,
  });
});

after(async () => {
  await db.delete(musicProjectsTable).where(eq(musicProjectsTable.id, projectId));
  await unlink(harnessPath).catch(() => undefined);
});

test("idempotent queueing returns one durable job", async () => {
  const input = {
    projectId,
    ownerId,
    kind: "mastering",
    idempotencyKey: "same-master-request",
    inputSnapshot: { mixArtifactId: "mix-1" },
    requiredCapabilities: ["mastering"],
    resourcePool: "STUDIO_RENDER",
  };
  const [first, second] = await Promise.all([
    queueProductionJob(input),
    queueProductionJob(input),
  ]);
  assert.equal(first.job.id, second.job.id);
  assert.equal(Number(first.duplicate) + Number(second.duplicate), 1);
});

test("lease takeover fences a stale worker", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "quality",
    idempotencyKey: "quality-fence",
    inputSnapshot: { artifactId: "master-1" },
  });
  const first = await claimProductionJob(job.id, "worker-a");
  assert.ok(first);
  await db.update(productionJobsTable).set({
    leaseExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(productionJobsTable.id, job.id));
  const second = await claimProductionJob(job.id, "worker-b");
  assert.ok(second);
  assert.ok(second.leaseVersion > first.leaseVersion);
  assert.equal(
    await heartbeatProductionJob(job.id, "worker-a", first.leaseVersion, "late", 90),
    false,
  );
  assert.equal(
    await completeProductionJob(job.id, "worker-a", first.leaseVersion, []),
    false,
  );
  assert.equal(
    await completeProductionJob(job.id, "worker-b", second.leaseVersion, ["master-1"]),
    true,
  );
});

test("queued jobs cancel immediately without being claimable", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "export",
    idempotencyKey: "cancel-export",
    inputSnapshot: { arrangementId: "arrangement-1" },
  });
  assert.equal(
    await requestProductionJobCancellation(job.id, ownerId),
    "cancelled",
  );
  assert.equal(await claimProductionJob(job.id, "worker-c"), null);
});

test("queued cancellation rolls back if ledger accounting cannot commit", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "export",
    idempotencyKey: "atomic-cancel-queued",
    inputSnapshot: { arrangementId: "atomic-cancel-queued" },
  });
  await assert.rejects(
    withFailingLedgerUpdates(() =>
      requestProductionJobCancellation(job.id, ownerId)),
    isForcedLedgerFailure,
  );
  await assertJobAndLedgerStatus(job.id, "queued", "reserved");
  assert.equal(await requestProductionJobCancellation(job.id, ownerId), "cancelled");
});

test("successful completion rolls back if ledger accounting cannot commit", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "mastering",
    idempotencyKey: "atomic-complete",
    inputSnapshot: { artifactId: "atomic-complete" },
  });
  const claimed = await claimProductionJob(job.id, "atomic-complete-worker");
  assert.ok(claimed);
  await assert.rejects(
    withFailingLedgerUpdates(() =>
      completeProductionJob(
        job.id,
        "atomic-complete-worker",
        claimed.leaseVersion,
        ["atomic-output"],
        25,
      )),
    isForcedLedgerFailure,
  );
  await assertJobAndLedgerStatus(job.id, "running", "reserved");
  assert.equal(
    await completeProductionJob(
      job.id,
      "atomic-complete-worker",
      claimed.leaseVersion,
      ["atomic-output"],
      25,
    ),
    true,
  );
});

test("failed completion rolls back if ledger accounting cannot commit", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "quality",
    idempotencyKey: "atomic-failure",
    inputSnapshot: { artifactId: "atomic-failure" },
  });
  const claimed = await claimProductionJob(job.id, "atomic-failure-worker");
  assert.ok(claimed);
  const failure = {
    code: "PROVIDER_TIMEOUT",
    message: "Provider timed out",
    retryable: true,
  };
  await assert.rejects(
    withFailingLedgerUpdates(() =>
      failProductionJob(
        job.id,
        "atomic-failure-worker",
        claimed.leaseVersion,
        failure,
      )),
    isForcedLedgerFailure,
  );
  await assertJobAndLedgerStatus(job.id, "running", "reserved");
  assert.equal(
    await failProductionJob(
      job.id,
      "atomic-failure-worker",
      claimed.leaseVersion,
      failure,
    ),
    true,
  );
});

test("running jobs cannot complete after cancellation is requested", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "rendering",
    idempotencyKey: "cancel-running-render",
    inputSnapshot: { arrangementId: "arrangement-2" },
  });
  const claimed = await claimProductionJob(job.id, "worker-d");
  assert.ok(claimed);
  assert.equal(
    await requestProductionJobCancellation(job.id, ownerId),
    "cancel_requested",
  );
  assert.equal(
    await completeProductionJob(job.id, "worker-d", claimed.leaseVersion, []),
    false,
  );
  assert.equal(
    await acknowledgeProductionJobCancellation(
      job.id,
      "worker-d",
      claimed.leaseVersion,
    ),
    true,
  );
});

test("cancellation acknowledgement rolls back if ledger accounting cannot commit", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "rendering",
    idempotencyKey: "atomic-cancel-acknowledgement",
    inputSnapshot: { arrangementId: "atomic-cancel-acknowledgement" },
  });
  const claimed = await claimProductionJob(job.id, "atomic-cancel-worker");
  assert.ok(claimed);
  assert.equal(
    await requestProductionJobCancellation(job.id, ownerId),
    "cancel_requested",
  );
  await assert.rejects(
    withFailingLedgerUpdates(() =>
      acknowledgeProductionJobCancellation(
        job.id,
        "atomic-cancel-worker",
        claimed.leaseVersion,
      )),
    isForcedLedgerFailure,
  );
  await assertJobAndLedgerStatus(job.id, "cancel_requested", "reserved");
  assert.equal(
    await acknowledgeProductionJobCancellation(
      job.id,
      "atomic-cancel-worker",
      claimed.leaseVersion,
    ),
    true,
  );
});

test("reusing an idempotency key with different input is rejected", async () => {
  await queueProductionJob({
    projectId,
    ownerId,
    kind: "mixing",
    idempotencyKey: "conflicting-mix",
    inputSnapshot: { mixId: "one" },
  });
  await assert.rejects(
    queueProductionJob({
      projectId,
      ownerId,
      kind: "mixing",
      idempotencyKey: "conflicting-mix",
      inputSnapshot: { mixId: "two" },
    }),
    /different job input/,
  );
});

test("expired non-retryable work becomes terminal", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "mastering",
    idempotencyKey: "non-retryable-interruption",
    inputSnapshot: { mixId: "final-mix" },
    retryable: false,
  });
  await claimProductionJob(job.id, "worker-e");
  await db.update(productionJobsTable).set({
    leaseExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(productionJobsTable.id, job.id));
  await recoverProductionJobs();
  const [recovered] = await db.select().from(productionJobsTable)
    .where(eq(productionJobsTable.id, job.id));
  const [ledger] = await db.select().from(musicUsageLedgerTable)
    .where(eq(musicUsageLedgerTable.jobId, job.id));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error.code, "NON_RETRYABLE_WORKER_INTERRUPTION");
  assert.equal(ledger.status, "failed");
});

test("concurrent reservations cannot exceed an owner's monthly quota", async () => {
  const previousLimit = process.env.MUSIC_MONTHLY_COST_UNIT_LIMIT;
  process.env.MUSIC_MONTHLY_COST_UNIT_LIMIT = "100";
  try {
    const results = await Promise.allSettled([
      queueProductionJob({
        projectId,
        ownerId,
        kind: "separation",
        idempotencyKey: "quota-race-a",
        inputSnapshot: { sourceId: "source-a" },
        estimatedCostUnits: 60,
      }),
      queueProductionJob({
        projectId,
        ownerId,
        kind: "transcription",
        idempotencyKey: "quota-race-b",
        inputSnapshot: { sourceId: "source-b" },
        estimatedCostUnits: 60,
      }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(rejected.reason.message, /quota exceeded/i);
  } finally {
    if (previousLimit === undefined) {
      delete process.env.MUSIC_MONTHLY_COST_UNIT_LIMIT;
    } else {
      process.env.MUSIC_MONTHLY_COST_UNIT_LIMIT = previousLimit;
    }
  }
});

test("crash recovery releases cancelled work's quota reservation", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "rendering",
    idempotencyKey: "cancelled-recovery-ledger",
    inputSnapshot: { arrangementId: "arrangement-3" },
    estimatedCostUnits: 25,
  });
  const claimed = await claimProductionJob(job.id, "worker-f");
  assert.ok(claimed);
  assert.equal(
    await requestProductionJobCancellation(job.id, ownerId),
    "cancel_requested",
  );
  await db.update(productionJobsTable).set({
    leaseExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(productionJobsTable.id, job.id));
  await recoverProductionJobs();
  const [ledger] = await db.select().from(musicUsageLedgerTable)
    .where(eq(musicUsageLedgerTable.jobId, job.id));
  assert.equal(ledger.status, "cancelled");
});

test("exhausted retry recovery releases the quota reservation", async () => {
  const { job } = await queueProductionJob({
    projectId,
    ownerId,
    kind: "quality",
    idempotencyKey: "exhausted-recovery-ledger",
    inputSnapshot: { artifactId: "master-final" },
    estimatedCostUnits: 25,
    maxAttempts: 1,
  });
  await claimProductionJob(job.id, "worker-g");
  await db.update(productionJobsTable).set({
    leaseExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(productionJobsTable.id, job.id));
  await recoverProductionJobs();
  const [recovered] = await db.select().from(productionJobsTable)
    .where(eq(productionJobsTable.id, job.id));
  const [ledger] = await db.select().from(musicUsageLedgerTable)
    .where(eq(musicUsageLedgerTable.jobId, job.id));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error.code, "RETRIES_EXHAUSTED");
  assert.equal(ledger.status, "failed");
});