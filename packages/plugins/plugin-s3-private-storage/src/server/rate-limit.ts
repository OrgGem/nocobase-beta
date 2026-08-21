/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Minimal in-memory sliding-window rate limiter for the private S3 stream
 * endpoint (`attachments:stream`).
 *
 * Design notes:
 * - A sliding window (per-key timestamps) is more accurate than a fixed
 *   window and is simple enough to implement without external dependencies.
 * - State lives in a Map; stale buckets are pruned lazily on every check and
 *   by a periodic timer so the map cannot grow unboundedly.
 * - Suitable for single-instance deployments. For multi-instance setups the
 *   limiter should be swapped for a shared store (e.g. Redis).
 */

export interface RateLimitOptions {
  /** Maximum number of requests allowed within the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds the client should wait before retrying (0 when allowed). */
  retryAfterSec: number;
}

const PRUNE_INTERVAL_MS = 60_000;

export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private options: RateLimitOptions) {
    if (!(options.max > 0)) {
      throw new Error('[s3-private-storage] rate limit max must be a positive number');
    }
    if (!(options.windowMs > 0)) {
      throw new Error('[s3-private-storage] rate limit windowMs must be a positive number');
    }
    this.timer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.timer.unref?.();
  }

  check(key: string, now: number = Date.now()): RateLimitDecision {
    const { max, windowMs } = this.options;
    const cutoff = now - windowMs;
    const timestamps = (this.hits.get(key) || []).filter((t) => t > cutoff);

    if (timestamps.length >= max) {
      this.hits.set(key, timestamps);
      const oldest = timestamps[0];
      const retryAfterMs = Math.max(1, oldest + windowMs - now);
      return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Drop expired buckets; called lazily and by the periodic timer. */
  prune(now: number = Date.now()): void {
    const cutoff = now - this.options.windowMs;
    for (const [key, timestamps] of this.hits) {
      const remaining = timestamps.filter((t) => t > cutoff);
      if (remaining.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, remaining);
      }
    }
  }

  /** Test helper: clear all recorded hits. */
  reset(): void {
    this.hits.clear();
  }

  /** Test helper: number of tracked keys, or hits for a single key. */
  size(key?: string): number {
    if (key === undefined) {
      return this.hits.size;
    }
    return (this.hits.get(key) || []).length;
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.hits.clear();
  }
}

export interface StreamRateLimitConfig {
  enabled: boolean;
  max: number;
  windowMs: number;
}

const DEFAULT_MAX = 120;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Read stream rate-limit configuration from environment variables so it can be
 * tuned per deployment without code changes:
 * - S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED  (default: true, "false"/"0" disables)
 * - S3_PRIVATE_STREAM_RATE_LIMIT_MAX      (default: 120 requests)
 * - S3_PRIVATE_STREAM_RATE_LIMIT_WINDOW_MS (default: 60000)
 */
export function getStreamRateLimitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StreamRateLimitConfig {
  const rawEnabled = env.S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED;
  const rawMax = env.S3_PRIVATE_STREAM_RATE_LIMIT_MAX;
  const rawWindowMs = env.S3_PRIVATE_STREAM_RATE_LIMIT_WINDOW_MS;

  const max = rawMax ? Number(rawMax) : DEFAULT_MAX;
  const windowMs = rawWindowMs ? Number(rawWindowMs) : DEFAULT_WINDOW_MS;

  return {
    enabled: rawEnabled === undefined ? true : rawEnabled !== 'false' && rawEnabled !== '0',
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS,
  };
}
