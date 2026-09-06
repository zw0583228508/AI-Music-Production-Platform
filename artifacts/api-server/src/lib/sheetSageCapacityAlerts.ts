import { createHash, randomUUID } from "node:crypto";
import { db, musicAuditEventsTable } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  SHEETSAGE_CAPACITY_ALERT_THRESHOLD,
  SHEETSAGE_CAPACITY_WINDOW_MS,
  sheetSageCapacityShouldEmitAlert,
} from "./sheetSageCapacityRate";

const SERVICE = "sheetsage-capacity";
const OBSERVED = "sheetsage_capacity_rejection_observed";
const ALERT = "sheetsage_capacity_saturation_alert";

export type SheetSageCapacityLogger = Pick<typeof logger, "error" | "warn">;

export async function recordSheetSageCapacityRejection(
  analysisKey: string,
  options: {
    database?: typeof db;
    now?: Date;
    capacityLogger?: SheetSageCapacityLogger;
  } = {},
): Promise<void> {
  const database = options.database ?? db;
  const now = options.now ?? new Date();
  const capacityLogger = options.capacityLogger ?? logger;
  const windowStartedAt = new Date(now.getTime() - SHEETSAGE_CAPACITY_WINDOW_MS);
  const analysisKeyHash = createHash("sha256").update(analysisKey).digest("hex");

  try {
    const transition = await database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${SERVICE}))`);
      const duplicate = await transaction.select({
        id: musicAuditEventsTable.id,
      }).from(musicAuditEventsTable).where(and(
        eq(musicAuditEventsTable.resourceType, SERVICE),
        eq(musicAuditEventsTable.action, OBSERVED),
        gte(musicAuditEventsTable.createdAt, windowStartedAt),
        sql`${musicAuditEventsTable.metadata}->>'analysisKeyHash' = ${analysisKeyHash}`,
      )).limit(1);
      if (duplicate.length > 0) return null;

      await transaction.insert(musicAuditEventsTable).values({
        id: randomUUID(),
        action: OBSERVED,
        resourceType: SERVICE,
        outcome: "retryable",
        metadata: {
          reason: "capacity_admission",
          analysisKeyHash,
        },
        createdAt: now,
      });
      const recent = await transaction.select({
        action: musicAuditEventsTable.action,
      }).from(musicAuditEventsTable).where(and(
        eq(musicAuditEventsTable.resourceType, SERVICE),
        eq(musicAuditEventsTable.action, OBSERVED),
        gte(musicAuditEventsTable.createdAt, windowStartedAt),
      ));
      const recentAlerts = await transaction.select({
        id: musicAuditEventsTable.id,
      }).from(musicAuditEventsTable).where(and(
        eq(musicAuditEventsTable.resourceType, SERVICE),
        eq(musicAuditEventsTable.action, ALERT),
        gte(musicAuditEventsTable.createdAt, windowStartedAt),
      )).limit(1);

      const rejectionCount = recent.length;
      if (!sheetSageCapacityShouldEmitAlert(
        rejectionCount,
        recentAlerts.length > 0,
      )) return null;
      const context = {
        service: SERVICE,
        rejectionCount,
        threshold: SHEETSAGE_CAPACITY_ALERT_THRESHOLD,
        windowMinutes: SHEETSAGE_CAPACITY_WINDOW_MS / 60_000,
        windowStartedAt: windowStartedAt.toISOString(),
        windowEndedAt: now.toISOString(),
      };
      await transaction.insert(musicAuditEventsTable).values({
        id: randomUUID(),
        action: ALERT,
        resourceType: SERVICE,
        outcome: "alerting",
        metadata: context,
        createdAt: now,
      });
      return context;
    });
    if (!transition) return;
    capacityLogger.error(transition, ALERT);
  } catch {
    capacityLogger.warn(
      { service: SERVICE },
      "sheetsage_capacity_rejection_record_failed",
    );
  }
}