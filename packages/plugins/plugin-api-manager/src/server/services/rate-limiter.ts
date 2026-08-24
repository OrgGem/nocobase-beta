/**
 * Fixed-window in-memory rate limiter.
 * Each key gets a window that starts on first hit and lasts windowSec seconds.
 *
 * NOTE: This implementation is process-local. In multi-instance deployments each
 * pod maintains its own counters, so the effective limit is multiplied by the
 * number of running instances. Replace with a Redis/DB-backed adapter when
 * horizontal scaling is required.
 */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

interface WindowEntry {
  count: number;
  windowStartMs: number;
  /** Window length of this entry, used to decide when it has fully elapsed. */
  windowMs: number;
}

export class FixedWindowRateLimiter {
  private windows = new Map<string, WindowEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 50000) {
    this.maxEntries = maxEntries;
  }

  /** Number of tracked keys (used by tests and diagnostics). */
  get size(): number {
    return this.windows.size;
  }

  check(key: string, max: number, windowSec: number): RateLimitResult {
    const now = Date.now();
    const windowMs = windowSec * 1000;

    const existing = this.windows.get(key);
    if (existing && now - existing.windowStartMs < existing.windowMs) {
      if (existing.count >= max) {
        const retryAfterSec = Math.max(1, Math.ceil((existing.windowStartMs + existing.windowMs - now) / 1000));
        return { allowed: false, retryAfterSec };
      }
      existing.count += 1;
      return { allowed: true, retryAfterSec: 0 };
    }

    if (this.windows.size >= this.maxEntries) {
      this.prune(now);
      if (this.windows.size >= this.maxEntries) {
        // Still full after pruning: drop the oldest insertion to make room.
        const oldest = this.windows.keys().next().value;
        if (oldest != null) this.windows.delete(oldest);
      }
    }
    this.windows.set(key, { count: 1, windowStartMs: now, windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }

  /**
   * Drop entries whose own window has fully elapsed. Window-aware pruning
   * keeps short-window entries from lingering until a fixed 24 h cutoff and
   * avoids evicting still-live entries to make room for expired ones. Only
   * runs when the map is at capacity so the hot path stays O(1).
   */
  private prune(now: number): void {
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStartMs >= entry.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}
