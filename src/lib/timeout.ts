export const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

export function validateTimeoutMs(
  timeoutMs: unknown,
  description: string,
  maxMs = MAX_NODE_TIMEOUT_MS,
): number {
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > maxMs
  ) {
    throw new RangeError(
      `${description} must be a finite positive number no greater than ${maxMs} ms`,
    );
  }
  return timeoutMs;
}
