/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * In-memory sliding window rate limiter.
 *
 * Stores per-user request timestamps. On each check: prunes timestamps
 * older than the window, counts the remainder, and accepts/rejects.
 *
 * Single-process safe (Node.js event loop). Not distributed.
 * For multi-process deployments, replace with a Redis-backed implementation.
 */
export class RateLimiter {
  /** Map<userId, sorted array of request timestamps in ms> */
  private readonly store = new Map<string | number, number[]>();

  constructor(private readonly windowMs = 60_000) {}

  /**
   * Check and record a request for a user.
   *
   * @param userId  The user ID (string or numeric)
   * @param limit   Max allowed requests per window (from aiApiConfig.rateLimitPerMinute)
   * @returns { allowed: true } or { allowed: false, retryAfterMs: number }
   */
  check(userId: string | number, limit: number): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.store.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.store.set(userId, timestamps);
    }

    // Binary-search prune: drop all timestamps before the window start.
    // O(log n + k) vs O(n) for a simple filter.
    let lo = 0,
      hi = timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (timestamps[mid] < windowStart) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) timestamps.splice(0, lo);

    if (timestamps.length >= limit) {
      // retryAfterMs is the time until the oldest request falls out of the window
      const retryAfterMs = Math.max(0, timestamps[0] + this.windowMs - now);
      return { allowed: false, retryAfterMs };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  /**
   * Garbage collect entries for inactive users.
   * Call every ~5 minutes to prevent unbounded memory growth in long-running servers.
   */
  gc(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [userId, timestamps] of this.store) {
      if (!timestamps.length || timestamps[timestamps.length - 1] < cutoff) {
        this.store.delete(userId);
      }
    }
  }

  /** Clear all state (useful in tests). */
  clear(): void {
    this.store.clear();
  }
}
