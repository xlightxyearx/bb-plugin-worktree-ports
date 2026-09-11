/** Unchanged scans before the sweep slows down, and how far it may slow. */
const IDLE_SCANS_BEFORE_BACKOFF = 20;
const IDLE_BACKOFF_FACTOR = 5;
const IDLE_INTERVAL_CAP_MS = 30_000;

/**
 * A machine where nothing has changed for a while does not need a scan every
 * few seconds. Any change, or anyone opening the card, resets `idleScans`.
 */
export function nextDelayMs(baseMs: number, idleScans: number): number {
  if (idleScans < IDLE_SCANS_BEFORE_BACKOFF) return baseMs;
  return Math.min(baseMs * IDLE_BACKOFF_FACTOR, IDLE_INTERVAL_CAP_MS);
}
