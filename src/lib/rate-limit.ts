// Simple in-memory sliding-window rate limiter. No external deps needed
// for a single-user self-hosted app — just a Map of timestamps keyed by
// the limiter name (e.g. IP, or a fixed key for the auth endpoint).

const windows = new Map<string, number[]>();

// Avoid creating a new Map on every HMR reload in dev.
const globalForRL = globalThis as unknown as { __boardroomRL?: typeof windows };
const store = globalForRL.__boardroomRL ?? (globalForRL.__boardroomRL = new Map());

/**
 * Returns `true` if the request should be BLOCKED.
 *
 * @param key     Identifier for the bucket (e.g. `'auth'` or an IP).
 * @param limit   Max allowed requests in the window.
 * @param windowMs  Window duration in milliseconds.
 */
export function isRateLimited(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  let timestamps = store.get(key);
  if (!timestamps) {
    timestamps = [];
    store.set(key, timestamps);
  }
  // Evict entries older than the window.
  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= limit) {
    return true; // blocked
  }
  timestamps.push(now);
  return false; // allowed
}
