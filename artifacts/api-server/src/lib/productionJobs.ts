import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  musicUsageLedgerTable,
  productionJobsTable,
  type ProductionJobError,
  type ProductionJobKind,
  type ProductionJobStatus,
} from "@workspace/db";
import { formatHostErrorMessage } from "./hostErrorDiagnostics";
export { logProductionJobEvent } from "./productionJobLogger";

export const PRODUCTION_JOB_KINDS: ProductionJobKind[] = [
  "analysis",
  "separation",
  "transcription",
  "arrangement",
  "rendering",
  "mixing",
  "mastering",
  "quality",
  "export",
];

export type ResourcePool = "AUTO" | "CPU" | "GPU" | "FAST" | "QUALITY" | "STUDIO_RENDER";

export type QueueProductionJobInput = {
  projectId: string;
  ownerId: string;
  kind: ProductionJobKind;
  idempotencyKey: string;
  inputSnapshot: Record<string, unknown>;
  requiredCapabilities?: string[];
  resourcePool?: ResourcePool;
  provider?: string;
  modelVersion?: string;
  maxAttempts?: number;
  retryable?: boolean;
  estimatedCostUnits?: number;
};

type ProductionJobTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];

const LEASE_MS = 2 * 60_000;

const leaseDeadline = (now = new Date()): Date =>
  new Date(now.getTime() + LEASE_MS);

function validateKey(key: string): string {
  const normalized = key.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error("A non-empty idempotency key of at most 200 characters is required");
  }
  return normalized;
}

function clampAttempts(value: number | undefined): number {
  return Math.max(1, Math.min(10, Math.trunc(value ?? 3)));
}

function clampUnits(value: number | undefined): number {
  return Math.max(0, Math.min(1_000_000, Math.trunc(value ?? 0)));
}

export async function queueProductionJob(
  input: QueueProductionJobInput,
  database?: ProductionJobTransaction,
): Promise<{
  job: typeof productionJobsTable.$inferSelect;
  duplicate: boolean;
}> {
  if (!database) {
    return db.transaction((transaction) =>
      queueProductionJob(input, transaction)
    );
  }
  const quotaMonth = new Date().toISOString().slice(0, 7);
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`music-quota:${input.ownerId}:${quotaMonth}`}))`,
  );
  const idempotencyKey = validateKey(input.idempotencyKey);
  const maxAttempts = clampAttempts(input.maxAttempts);
  const estimatedCostUnits = clampUnits(input.estimatedCostUnits);
  const existing = await database
    .select()
    .from(productionJobsTable)
    .where(and(
      eq(productionJobsTable.projectId, input.projectId),
      eq(productionJobsTable.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  if (existing[0]) {
    if (
      existing[0].kind !== input.kind ||
      !isDeepStrictEqual(existing[0].inputSnapshot, input.inputSnapshot)
    ) {
      throw new Error("Idempotency key was already used with different job input");
    }
    return { job: existing[0], duplicate: true };
  }
  const monthlyLimit = Math.max(
    0,
    Number.parseInt(process.env.MUSIC_MONTHLY_COST_UNIT_LIMIT ?? "100000", 10),
  );
  const [usage] = await database
    .select({
      units: sql<number>`coalesce(sum(${musicUsageLedgerTable.units}), 0)::int`,
    })
    .from(musicUsageLedgerTable)
    .where(and(
      eq(musicUsageLedgerTable.ownerId, input.ownerId),
      sql`${musicUsageLedgerTable.status} in ('reserved', 'completed')`,
      sql`${musicUsageLedgerTable.createdAt} >= date_trunc('month', now())`,
    ));
  if ((usage?.units ?? 0) + estimatedCostUnits > monthlyLimit) {
    throw new Error("Monthly music processing quota exceeded");
  }

  const values = {
    id: randomUUID(),
    projectId: input.projectId,
    ownerId: input.ownerId,
    kind: input.kind,
    status: "queued" as ProductionJobStatus,
    stage: "queued",
    progress: 0,
    attempt: 0,
    maxAttempts,
    idempotencyKey,
    inputSnapshot: input.inputSnapshot,
    requiredCapabilities: input.requiredCapabilities ?? [],
    resourcePool: input.resourcePool ?? "AUTO",
    provider: input.provider ?? null,
    modelVersion: input.modelVersion ?? null,
    retryable: input.retryable ?? true,
    estimatedCostUnits,
  };
  const [job] = await database
    .insert(productionJobsTable)
    .values(values)
    .onConflictDoNothing({
      target: [productionJobsTable.projectId, productionJobsTable.idempotencyKey],
    })
    .returning();
  if (job) {
    await database.insert(musicUsageLedgerTable).values({
      id: randomUUID(),
      projectId: input.projectId,
      ownerId: input.ownerId,
      jobId: job.id,
      kind: input.kind,
      units: estimatedCostUnits,
      estimatedCostCents: estimatedCostUnits,
    }).onConflictDoNothing();
    return { job, duplicate: false };
  }

  const [racedJob] = await database
    .select()
    .from(productionJobsTable)
    .where(and(
      eq(productionJobsTable.projectId, input.projectId),
      eq(productionJobsTable.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  if (!racedJob) throw new Error("Queued production job disappeared after insert");
  if (
    racedJob.kind !== input.kind ||
    !isDeepStrictEqual(racedJob.inputSnapshot, input.inputSnapshot)
  ) {
    throw new Error("Idempotency key was already used with different job input");
  }
  return { job: racedJob, duplicate: true };
}

/**
 * Claims queued work, or takes over an expired lease. The leaseVersion is a
 * fencing token: an old worker cannot update this row after takeover.
 */
export async function claimProductionJob(
  jobId: string,
  workerId: string,
  now = new Date(),
) {
  const [job] = await db
    .update(productionJobsTable)
    .set({
      status: "running",
      workerId,
      attempt: sql`${productionJobsTable.attempt} + 1`,
      leaseVersion: sql`${productionJobsTable.leaseVersion} + 1`,
      heartbeatAt: now,
      leaseExpiresAt: leaseDeadline(now),
      stage: "claimed",
      updatedAt: now,
    })
    .where(and(
      eq(productionJobsTable.id, jobId),
      or(
        eq(productionJobsTable.status, "queued"),
        and(
          eq(productionJobsTable.status, "running"),
          or(
            isNull(productionJobsTable.leaseExpiresAt),
            lt(productionJobsTable.leaseExpiresAt, now),
          ),
        ),
      ),
      sql`${productionJobsTable.attempt} < ${productionJobsTable.maxAttempts}`,
    ))
    .returning();
  return job ?? null;
}

export async function heartbeatProductionJob(
  jobId: string,
  workerId: string,
  leaseVersion: number,
  stage?: string,
  progress?: number,
): Promise<boolean> {
  const now = new Date();
  const [updated] = await db
    .update(productionJobsTable)
    .set({
      ...(stage ? { stage } : {}),
      ...(progress === undefined ? {} : { progress: Math.max(0, Math.min(100, Math.round(progress))) }),
      heartbeatAt: now,
      leaseExpiresAt: leaseDeadline(now),
      updatedAt: now,
    })
    .where(and(
      eq(productionJobsTable.id, jobId),
      eq(productionJobsTable.workerId, workerId),
      eq(productionJobsTable.leaseVersion, leaseVersion),
      eq(productionJobsTable.status, "running"),
      gt(productionJobsTable.leaseExpiresAt, new Date()),
      sql`${productionJobsTable.leaseExpiresAt} > ${now}`,
    ))
    .returning({ id: productionJobsTable.id });
  return Boolean(updated);
}

export async function isProductionJobCancellationRequested(
  jobId: string,
  workerId: string,
  leaseVersion: number,
): Promise<boolean> {
  const [job] = await db
    .select({
      status: productionJobsTable.status,
      cancelRequestedAt: productionJobsTable.cancelRequestedAt,
    })
    .from(productionJobsTable)
    .where(and(
      eq(productionJobsTable.id, jobId),
      eq(productionJobsTable.workerId, workerId),
      eq(productionJobsTable.leaseVersion, leaseVersion),
    ))
    .limit(1);
  return job?.status === "cancel_requested" || Boolean(job?.cancelRequestedAt);
}

export async function acknowledgeProductionJobCancellation(
  jobId: string,
  workerId: string,
  leaseVersion: number,
): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(productionJobsTable)
      .set({
        status: "cancelled",
        stage: "cancelled",
        progress: 100,
        retryable: false,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(productionJobsTable.id, jobId),
        eq(productionJobsTable.workerId, workerId),
        eq(productionJobsTable.leaseVersion, leaseVersion),
        eq(productionJobsTable.status, "cancel_requested"),
        gt(productionJobsTable.leaseExpiresAt, now),
      ))
      .returning({ id: productionJobsTable.id });
    if (updated) {
      await transaction.update(musicUsageLedgerTable).set({ status: "cancelled" })
        .where(eq(musicUsageLedgerTable.jobId, jobId));
    }
    return Boolean(updated);
  });
}

export async function completeProductionJob(
  jobId: string,
  workerId: string,
  leaseVersion: number,
  outputArtifactIds: string[] = [],
  actualCostUnits?: number,
): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(productionJobsTable)
      .set({
        status: "succeeded",
        stage: "complete",
        progress: 100,
        outputArtifactIds,
        actualCostUnits: actualCostUnits === undefined ? null : clampUnits(actualCostUnits),
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(productionJobsTable.id, jobId),
        eq(productionJobsTable.workerId, workerId),
        eq(productionJobsTable.leaseVersion, leaseVersion),
        eq(productionJobsTable.status, "running"),
        gt(productionJobsTable.leaseExpiresAt, now),
      ))
      .returning({ id: productionJobsTable.id });
    if (updated) {
      await transaction.update(musicUsageLedgerTable).set({
        status: "completed",
        actualCostCents: actualCostUnits === undefined
          ? null
          : clampUnits(actualCostUnits),
      }).where(eq(musicUsageLedgerTable.jobId, jobId));
    }
    return Boolean(updated);
  });
}

export async function failProductionJob(
  jobId: string,
  workerId: string,
  leaseVersion: number,
  error: ProductionJobError,
): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(productionJobsTable)
      .set({
        status: "failed",
        stage: "failed",
        progress: 100,
        error,
        retryable: error.retryable,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(productionJobsTable.id, jobId),
        eq(productionJobsTable.workerId, workerId),
        eq(productionJobsTable.leaseVersion, leaseVersion),
        eq(productionJobsTable.status, "running"),
        gt(productionJobsTable.leaseExpiresAt, now),
      ))
      .returning({ id: productionJobsTable.id });
    if (updated) {
      await transaction.update(musicUsageLedgerTable).set({ status: "failed" })
        .where(eq(musicUsageLedgerTable.jobId, jobId));
    }
    return Boolean(updated);
  });
}

export async function requestProductionJobCancellation(
  jobId: string,
  ownerId: string,
): Promise<"cancelled" | "cancel_requested" | "not_found" | "terminal"> {
  const now = new Date();
  return db.transaction(async (transaction) => {
  const [cancelled] = await transaction
    .update(productionJobsTable)
    .set({
      status: "cancelled",
      stage: "cancelled",
      progress: 100,
      cancelRequestedAt: now,
      completedAt: now,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(productionJobsTable.id, jobId),
      eq(productionJobsTable.ownerId, ownerId),
      eq(productionJobsTable.status, "queued"),
    ))
    .returning({ id: productionJobsTable.id });
  if (cancelled) {
    await transaction.update(musicUsageLedgerTable).set({ status: "cancelled" })
      .where(eq(musicUsageLedgerTable.jobId, jobId));
    return "cancelled";
  }

  const [requested] = await transaction
    .update(productionJobsTable)
    .set({
      status: "cancel_requested",
      cancelRequestedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(productionJobsTable.id, jobId),
      eq(productionJobsTable.ownerId, ownerId),
      eq(productionJobsTable.status, "running"),
    ))
    .returning({ id: productionJobsTable.id });
  if (requested) return "cancel_requested";

  const [job] = await transaction
    .select({ status: productionJobsTable.status })
    .from(productionJobsTable)
    .where(and(
      eq(productionJobsTable.id, jobId),
      eq(productionJobsTable.ownerId, ownerId),
    ))
    .limit(1);
  if (!job) return "not_found";
  return "terminal";
  });
}

export async function retryProductionJob(jobId: string, ownerId: string) {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction.select({
      projectId: productionJobsTable.projectId,
    }).from(productionJobsTable).where(and(
      eq(productionJobsTable.id, jobId),
      eq(productionJobsTable.ownerId, ownerId),
    )).limit(1);
    if (!candidate) return null;
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${candidate.projectId}))`,
    );
    const [job] = await transaction
      .update(productionJobsTable)
      .set({
        status: "queued",
        stage: "retry_queued",
        progress: 0,
        attempt: sql`${productionJobsTable.attempt}`,
        error: null,
        cancelRequestedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(productionJobsTable.id, jobId),
        eq(productionJobsTable.ownerId, ownerId),
        eq(productionJobsTable.status, "failed"),
        eq(productionJobsTable.retryable, true),
        sql`${productionJobsTable.attempt} < ${productionJobsTable.maxAttempts}`,
      ))
      .returning();
    return job ?? null;
  });
}

export async function recoverProductionJobs(now = new Date()): Promise<void> {
  await db.transaction(async (transaction) => {
    const cancelled = await transaction
      .update(productionJobsTable)
      .set({
        status: "cancelled",
        stage: "cancelled",
        progress: 100,
        retryable: false,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(productionJobsTable.status, "cancel_requested"),
        or(
          isNull(productionJobsTable.leaseExpiresAt),
          lt(productionJobsTable.leaseExpiresAt, now),
        ),
      ))
      .returning({ id: productionJobsTable.id });
    for (const job of cancelled) {
      await transaction.update(musicUsageLedgerTable)
        .set({ status: "cancelled" })
        .where(eq(musicUsageLedgerTable.jobId, job.id));
    }
  });
  await db.transaction(async (transaction) => {
    const exhausted = await transaction
      .update(productionJobsTable)
      .set({
      status: "failed",
      stage: "retries_exhausted",
      progress: 100,
      retryable: false,
      error: {
        code: "RETRIES_EXHAUSTED",
        message: "The worker stopped before the job completed.",
        retryable: false,
      },
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
      })
      .where(and(
        eq(productionJobsTable.status, "running"),
        or(
          isNull(productionJobsTable.leaseExpiresAt),
          lt(productionJobsTable.leaseExpiresAt, now),
        ),
        sql`${productionJobsTable.attempt} >= ${productionJobsTable.maxAttempts}`,
      ))
      .returning({ id: productionJobsTable.id });
    for (const job of exhausted) {
      await transaction.update(musicUsageLedgerTable)
        .set({ status: "failed" })
        .where(eq(musicUsageLedgerTable.jobId, job.id));
    }
    const interrupted = await transaction
      .update(productionJobsTable)
      .set({
      status: "failed",
      stage: "worker_interrupted",
      progress: 100,
      error: {
        code: "NON_RETRYABLE_WORKER_INTERRUPTION",
        message: "The non-retryable worker stopped before the job completed.",
        retryable: false,
      },
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
      })
      .where(and(
        eq(productionJobsTable.status, "running"),
        eq(productionJobsTable.retryable, false),
        or(
          isNull(productionJobsTable.leaseExpiresAt),
          lt(productionJobsTable.leaseExpiresAt, now),
        ),
        sql`${productionJobsTable.attempt} < ${productionJobsTable.maxAttempts}`,
      ))
      .returning({ id: productionJobsTable.id });
    for (const job of interrupted) {
      await transaction.update(musicUsageLedgerTable)
        .set({ status: "failed" })
        .where(eq(musicUsageLedgerTable.jobId, job.id));
    }
  });
  await db
    .update(productionJobsTable)
    .set({
      status: "queued",
      stage: "recovered",
      progress: 0,
      workerId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(productionJobsTable.status, "running"),
      or(
        isNull(productionJobsTable.leaseExpiresAt),
        lt(productionJobsTable.leaseExpiresAt, now),
      ),
      eq(productionJobsTable.retryable, true),
      sql`${productionJobsTable.attempt} < ${productionJobsTable.maxAttempts}`,
    ));
}

function structuredRetryability(error: unknown): boolean | undefined {
  try {
    if (
      typeof error === "object" &&
      error !== null &&
      "retryable" in error
    ) {
      const retryable = (error as { retryable?: unknown }).retryable;
      return typeof retryable === "boolean" ? retryable : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function structuredJobError(
  error: unknown,
  fallbackCode = "PRODUCTION_JOB_FAILED",
  fallbackMessage = "Production job failed",
): ProductionJobError {
  const message = formatHostErrorMessage(error, fallbackMessage);
  // Unknown failures remain retryable so a diagnostic format change cannot
  // silently turn a transient provider or host outage into a terminal job.
  const retryable = structuredRetryability(error) ?? true;
  return { code: fallbackCode, message, retryable };
}

export async function productionQueueMetrics() {
  const rows = await db
    .select({
      status: productionJobsTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(productionJobsTable)
    .groupBy(productionJobsTable.status);
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}
