/**
 * Per-user sliding-window rate limiter (in-memory, single-instance).
 *
 * For multi-instance deployments swap the Map for a Redis ZSET — the public
 * `acquire(key, limitPerMinute)` API stays the same. Single-instance is fine
 * for the documented HA topology because Carbone calls are pinned to one
 * NocoBase node anyway (worker affinity is not required for correctness).
 */
export class RateLimiter {
  private readonly windows = new Map<string, number[]>();

  /**
   * Returns `true` when the request is allowed, `false` when the user has
   * exceeded the limit for the current 60-second sliding window. A non-positive
   * limit disables throttling.
   */
  acquire(key: string, limitPerMinute: number): boolean {
    if (!limitPerMinute || limitPerMinute <= 0) return true;
    const now = Date.now();
    const cutoff = now - 60_000;
    const bucket = (this.windows.get(key) || []).filter((t) => t >= cutoff);
    if (bucket.length >= limitPerMinute) {
      // Persist the trimmed window so we don't keep growing memory.
      this.windows.set(key, bucket);
      return false;
    }
    bucket.push(now);
    this.windows.set(key, bucket);
    return true;
  }

  /**
   * Drop windows that have been idle for at least 5 minutes. Safe to call from
   * a periodic timer.
   */
  prune(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [key, bucket] of this.windows) {
      const fresh = bucket.filter((t) => t >= cutoff);
      if (!fresh.length) this.windows.delete(key);
      else this.windows.set(key, fresh);
    }
  }
}
