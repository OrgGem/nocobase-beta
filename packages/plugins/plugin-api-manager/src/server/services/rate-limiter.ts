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
}

export class FixedWindowRateLimiter {
  private windows = new Map<string, WindowEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 50000) {
    this.maxEntries = maxEntries;
  }

  check(key: string, max: number, windowSec: number): RateLimitResult {
    const now = Date.now();
    const windowMs = windowSec * 1000;

    const existing = this.windows.get(key);
    if (existing && now - existing.windowStartMs < windowMs) {
      if (existing.count >= max) {
        const retryAfterSec = Math.max(1, Math.ceil((existing.windowStartMs + windowMs - now) / 1000));
        return { allowed: false, retryAfterSec };
      }
      existing.count += 1;
      return { allowed: true, retryAfterSec: 0 };
    }

    if (this.windows.size >= this.maxEntries) {
      this.prune(now);
      if (this.windows.size >= this.maxEntries) {
        const oldest = this.windows.keys().next().value;
        if (oldest != null) this.windows.delete(oldest);
      }
    }
    this.windows.set(key, { count: 1, windowStartMs: now });
    return { allowed: true, retryAfterSec: 0 };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStartMs > 24 * 60 * 60 * 1000) {
        this.windows.delete(key);
      }
    }
  }
}
