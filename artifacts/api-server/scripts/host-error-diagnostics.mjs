const defaultMessageLimit = 240;

export function formatHostErrorMessage(
  error,
  fallback,
  limit = defaultMessageLimit,
) {
  try {
    const message = error?.message ?? error;
    const sanitized = String(message)
      .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (!sanitized) return fallback;
    return sanitized.length <= limit
      ? sanitized
      : `${sanitized.slice(0, limit - 3)}...`;
  } catch {
    return fallback;
  }
}