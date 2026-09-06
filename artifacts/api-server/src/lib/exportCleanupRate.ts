export const EXPORT_CLEANUP_WINDOW_MS = 15 * 60_000;
export const EXPORT_CLEANUP_RECLAIMED_THRESHOLD = 3;
export const EXPORT_CLEANUP_FAILURE_THRESHOLD = 2;

export type ExportCleanupRate = {
  reclaimed: number;
  failedDeletions: number;
};

/**
 * A 15-minute rolling window smooths over an isolated crashed export while
 * surfacing repeated publication/worker failures. Three reclaimed packages or
 * two failed deletions in that window opens the incident.
 */
export function exportCleanupRateIsAlerting(rate: ExportCleanupRate): boolean {
  return rate.reclaimed >= EXPORT_CLEANUP_RECLAIMED_THRESHOLD ||
    rate.failedDeletions >= EXPORT_CLEANUP_FAILURE_THRESHOLD;
}