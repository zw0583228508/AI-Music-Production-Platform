import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  calibrationVersionsTable,
  calibrationActivePointersTable,
  calibrationActivationHistoryTable,
  db,
  producerDecisionsTable,
  producerPreferencesTable,
  producerPreferenceVersionsTable,
  type ProducerDecisionContext,
  type ProducerDecisionSource,
} from "@workspace/db";

const sha256 = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unsafeKey = /(url|uri|path|object|fingerprint|audio|pcm)/i;

/** Only IDs and a one-way server hash survive into the learning ledger/API. */
export function privateDecisionContext(value: Partial<ProducerDecisionContext>): ProducerDecisionContext {
  return {
    subjectId: typeof value.subjectId === "string" ? value.subjectId : null,
    comparedSubjectId: typeof value.comparedSubjectId === "string" ? value.comparedSubjectId : null,
    modelVersion: typeof value.modelVersion === "string" ? value.modelVersion : null,
    evidenceIds: (value.evidenceIds ?? []).filter((id): id is string => typeof id === "string").slice(0, 50),
    lineageIds: (value.lineageIds ?? []).filter((id): id is string => typeof id === "string").slice(0, 50),
    evidenceSha256: value.evidenceSha256 ?? null,
    rankingScore: Number.isFinite(value.rankingScore) ? value.rankingScore : null,
    criticScore: Number.isFinite(value.criticScore) ? value.criticScore : null,
  };
}
export function learningWriteAllowed(
  preferences: { learningEnabled: boolean; inferredBehaviorEnabled: boolean },
  source: ProducerDecisionSource,
): boolean {
  return source === "objective_evidence" ||
    (preferences.learningEnabled &&
      (source !== "inferred_behavior" || preferences.inferredBehaviorEnabled));
}
type LedgerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Transaction-only append: caller's primary mutation and ledger record commit together. */
export async function appendProducerDecisionTx(
  tx: LedgerTransaction,
  input: Parameters<typeof appendProducerDecision>[0],
) {
  if (input.source !== "objective_evidence") {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"producer-preferences:" + input.ownerId}))`,
    );
    const policy = (await tx.select().from(producerPreferencesTable)
      .where(eq(producerPreferencesTable.ownerId, input.ownerId)).limit(1))[0] ??
      { learningEnabled: true, inferredBehaviorEnabled: true };
    if (!learningWriteAllowed(policy, input.source)) return null;
  }
  const context = privateDecisionContext({
    ...input.context,
    evidenceSha256: input.evidence === undefined ? input.context?.evidenceSha256 ?? null : sha256(input.evidence),
  });
  const [row] = await tx.insert(producerDecisionsTable).values({
    id: randomUUID(), ownerId: input.ownerId, projectId: input.projectId, domain: input.domain,
    kind: input.kind, source: input.source, rating: input.rating ?? null,
    reasons: (input.reasons ?? []).map((reason) => reason.trim()).filter(Boolean).slice(0, 20),
    context, version: 1,
  }).returning();
  return row;
}

export async function appendProducerDecision(input: {
  ownerId: string; projectId: string; domain: string; kind: string;
  source: ProducerDecisionSource; rating?: number | null; reasons?: string[];
  context?: Partial<ProducerDecisionContext>; evidence?: unknown;
}) {
  return db.transaction((tx) => appendProducerDecisionTx(tx, input));
}

export function producerDecisionResponse(row: typeof producerDecisionsTable.$inferSelect) {
  // Defense in depth if a historical row was written by an older caller.
  const context = privateDecisionContext(row.context);
  return { id: row.id, projectId: row.projectId, domain: row.domain, kind: row.kind,
    source: row.source, rating: row.rating, reasons: row.reasons.filter((x) => !unsafeKey.test(x)),
    context, version: row.version, createdAt: row.createdAt.toISOString() };
}

export async function listProducerDecisions(ownerId: string, projectId?: string, limit = 50) {
  const rows = await db.select().from(producerDecisionsTable)
    .where(projectId ? and(eq(producerDecisionsTable.ownerId, ownerId), eq(producerDecisionsTable.projectId, projectId)) : eq(producerDecisionsTable.ownerId, ownerId))
    .orderBy(desc(producerDecisionsTable.createdAt)).limit(Math.min(100, Math.max(1, limit)));
  return rows.map(producerDecisionResponse);
}

export async function preferencesForOwner(ownerId: string) {
  const [row] = await db.select().from(producerPreferencesTable).where(eq(producerPreferencesTable.ownerId, ownerId)).limit(1);
  return row ?? { ownerId, learningEnabled: true, inferredBehaviorEnabled: true, version: 0, updatedAt: new Date() };
}

export async function updatePreferences(ownerId: string, values: { learningEnabled: boolean; inferredBehaviorEnabled: boolean }) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"producer-preferences:" + ownerId}))`,
    );
    const [previous] = await tx.select().from(producerPreferencesTable).where(eq(producerPreferencesTable.ownerId, ownerId)).limit(1);
    const version = (previous?.version ?? 0) + 1;
    const [row] = await tx.insert(producerPreferencesTable).values({ ownerId, ...values, version, updatedAt: new Date() })
      .onConflictDoUpdate({ target: producerPreferencesTable.ownerId, set: { ...values, version, updatedAt: new Date() } }).returning();
    await tx.insert(producerPreferenceVersionsTable).values({ id: randomUUID(), ownerId, version, ...values });
    return row;
  });
}

export type CalibrationExample = { id: string; label: boolean; rankingScore: number; criticScore: number; split: "train" | "held_out" };
/** Frozen, stable hash split: only explicit producer labels may enter this dataset. */
export function buildCalibrationDataset(rows: Array<typeof producerDecisionsTable.$inferSelect>): CalibrationExample[] {
  return rows.flatMap((row) => {
    if (row.source !== "explicit_feedback") return [];
    const context = privateDecisionContext(row.context);
    if (!Number.isFinite(context.rankingScore) || !Number.isFinite(context.criticScore)) return [];
    const label = row.kind === "approval" ? true : row.kind === "rejection" ? false :
      row.rating === null ? null : row.rating >= 3;
    if (label === null) return [];
    const split = Number.parseInt(sha256(row.id).slice(0, 8), 16) % 5 === 0 ? "held_out" : "train";
    return [{ id: row.id, label, rankingScore: context.rankingScore!, criticScore: context.criticScore!, split }];
  });
}
export function heldOutAgreement(examples: CalibrationExample[], rankingWeight: number, criticWeight: number) {
  const heldOut = examples.filter((example) => example.split === "held_out");
  const correct = heldOut.filter((example) =>
    (rankingWeight * example.rankingScore + criticWeight * example.criticScore >= 0.5) === example.label).length;
  return { examples: heldOut.length, heldOutAgreement: heldOut.length ? correct / heldOut.length : 0 };
}
export function compareCalibrationOnHeldOut(
  examples: CalibrationExample[],
  proposed: { rankingWeight: number; criticWeight: number },
  baseline: { rankingWeight: number; criticWeight: number } = {
    rankingWeight: 0.5,
    criticWeight: 0.5,
  },
) {
  validateCalibrationWeights(proposed.rankingWeight, proposed.criticWeight);
  validateCalibrationWeights(baseline.rankingWeight, baseline.criticWeight);
  return {
    proposal: heldOutAgreement(
      examples,
      proposed.rankingWeight,
      proposed.criticWeight,
    ),
    baseline: heldOutAgreement(
      examples,
      baseline.rankingWeight,
      baseline.criticWeight,
    ),
  };
}
export function validateCalibrationWeights(rankingWeight: number, criticWeight: number): void {
  if (!Number.isFinite(rankingWeight) || !Number.isFinite(criticWeight) ||
    rankingWeight < 0 || criticWeight < 0 || rankingWeight > 1 || criticWeight > 1 ||
    Math.abs(rankingWeight + criticWeight - 1) > 0.000001) throw new Error("Calibration weights must be finite 0..1 values that sum to 1");
}
export function canPromoteCalibration(
  evaluation: { examples: number; heldOutAgreement: number },
  baselineAgreement: number,
  minimumImprovement = 0.02,
): boolean {
  return evaluation.examples >= 5 &&
    evaluation.heldOutAgreement >= baselineAgreement + minimumImprovement;
}
export async function evaluateCalibration(ownerId: string, rankingWeight = 0.5, criticWeight = 0.5) {
  validateCalibrationWeights(rankingWeight, criticWeight);
  const rows = await db.select().from(producerDecisionsTable).where(and(eq(producerDecisionsTable.ownerId, ownerId), eq(producerDecisionsTable.source, "explicit_feedback"))).orderBy(producerDecisionsTable.createdAt);
  return heldOutAgreement(buildCalibrationDataset(rows), rankingWeight, criticWeight);
}

export async function promoteCalibration(ownerId: string, rankingWeight: number, criticWeight: number, minimumImprovement = 0.02) {
  validateCalibrationWeights(rankingWeight, criticWeight);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"producer-calibration:" + ownerId}))`,
    );
    const [pointer] = await tx.select().from(calibrationActivePointersTable)
      .where(eq(calibrationActivePointersTable.ownerId, ownerId)).limit(1);
    const [active] = pointer
      ? await tx.select().from(calibrationVersionsTable).where(and(
          eq(calibrationVersionsTable.id, pointer.calibrationVersionId),
          eq(calibrationVersionsTable.ownerId, ownerId),
        )).limit(1)
      : [];
    const [latest] = await tx.select({ version: calibrationVersionsTable.version })
      .from(calibrationVersionsTable)
      .where(eq(calibrationVersionsTable.ownerId, ownerId))
      .orderBy(desc(calibrationVersionsTable.version))
      .limit(1);
    const decisionRows = await tx.select().from(producerDecisionsTable).where(and(
      eq(producerDecisionsTable.ownerId, ownerId),
      eq(producerDecisionsTable.source, "explicit_feedback"),
    )).orderBy(producerDecisionsTable.createdAt);
    const comparison = compareCalibrationOnHeldOut(
      buildCalibrationDataset(decisionRows),
      { rankingWeight, criticWeight },
      active
        ? {
            rankingWeight: active.rankingWeight,
            criticWeight: active.criticWeight,
          }
        : undefined,
    );
    if (!canPromoteCalibration(
      comparison.proposal,
      comparison.baseline.heldOutAgreement,
      minimumImprovement,
    )) {
      throw new Error("Calibration promotion requires at least five held-out decisions and measurable agreement improvement");
    }
    const [row] = await tx.insert(calibrationVersionsTable).values({ id: randomUUID(), ownerId, version: (latest?.version ?? 0) + 1, rankingWeight, criticWeight, heldOutAgreement: comparison.proposal.heldOutAgreement, baselineAgreement: comparison.baseline.heldOutAgreement, status: "immutable", promotedAt: new Date() }).returning();
    await tx.insert(calibrationActivePointersTable).values({ ownerId, calibrationVersionId: row.id, updatedAt: new Date() }).onConflictDoUpdate({ target: calibrationActivePointersTable.ownerId, set: { calibrationVersionId: row.id, updatedAt: new Date() } });
    await tx.insert(calibrationActivationHistoryTable).values({ id: randomUUID(), ownerId, calibrationVersionId: row.id, action: "promote" });
    return row;
  });
}
export async function listCalibrations(ownerId: string) {
  const [pointer] = await db.select().from(calibrationActivePointersTable).where(eq(calibrationActivePointersTable.ownerId, ownerId)).limit(1);
  const rows = await db.select().from(calibrationVersionsTable).where(eq(calibrationVersionsTable.ownerId, ownerId)).orderBy(desc(calibrationVersionsTable.version));
  return rows.map((row) => ({ ...row, active: pointer?.calibrationVersionId === row.id }));
}
export async function activeCalibrationForOwner(ownerId: string) {
  const [pointer] = await db.select().from(calibrationActivePointersTable)
    .where(eq(calibrationActivePointersTable.ownerId, ownerId)).limit(1);
  if (!pointer) return null;
  const [row] = await db.select().from(calibrationVersionsTable).where(and(
    eq(calibrationVersionsTable.id, pointer.calibrationVersionId),
    eq(calibrationVersionsTable.ownerId, ownerId),
  )).limit(1);
  return row ? { rankingWeight: row.rankingWeight, criticWeight: row.criticWeight } : null;
}
export async function rollbackCalibration(ownerId: string, calibrationVersionId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"producer-calibration:" + ownerId}))`,
    );
    const [row] = await tx.select().from(calibrationVersionsTable).where(and(eq(calibrationVersionsTable.id, calibrationVersionId), eq(calibrationVersionsTable.ownerId, ownerId))).limit(1);
    if (!row) return null;
    await tx.insert(calibrationActivePointersTable).values({ ownerId, calibrationVersionId: row.id, updatedAt: new Date() }).onConflictDoUpdate({ target: calibrationActivePointersTable.ownerId, set: { calibrationVersionId: row.id, updatedAt: new Date() } });
    await tx.insert(calibrationActivationHistoryTable).values({ id: randomUUID(), ownerId, calibrationVersionId: row.id, action: "rollback" });
    return row;
  });
}