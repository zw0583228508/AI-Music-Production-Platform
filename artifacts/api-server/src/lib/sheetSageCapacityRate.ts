export const SHEETSAGE_CAPACITY_WINDOW_MS = 15 * 60_000;
export const SHEETSAGE_CAPACITY_ALERT_THRESHOLD = 3;

export function sheetSageCapacityIsSustained(rejections: number): boolean {
  return rejections >= SHEETSAGE_CAPACITY_ALERT_THRESHOLD;
}

export function sheetSageCapacityShouldEmitAlert(
  uniqueRejections: number,
  hasRecentAlert: boolean,
): boolean {
  return sheetSageCapacityIsSustained(uniqueRejections) && !hasRecentAlert;
}

export function isSheetSageCapacityAdmissionRejection(
  providerId: string,
  status: number,
  rejectionType: string | null,
): boolean {
  return providerId === "SHEETSAGE" &&
    status === 503 &&
    rejectionType === "capacity-admission";
}