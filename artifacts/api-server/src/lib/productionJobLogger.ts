import { logger } from "./logger";

export function logProductionJobEvent(
  jobId: string,
  event: string,
  metadata: Record<string, unknown> = {},
) {
  logger.info({ jobId, ...metadata }, event);
}