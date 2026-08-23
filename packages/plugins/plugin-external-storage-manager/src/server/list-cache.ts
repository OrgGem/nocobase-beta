/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Small bounded TTL cache used to memoize expensive storage listings.
 *
 * The S3 search path performs a full recursive ListObjectsV2 walk of the
 * prefix on every request; typing in the search box would otherwise fire
 * hundreds of S3 requests per keystroke burst. A short-lived per-process
 * cache absorbs the debounce bursts without changing correctness guarantees
 * beyond the configured staleness window.
 */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private options: { ttlMs: number; maxEntries?: number } = { ttlMs: 30_000, maxEntries: 200 },
  ) {}

  get enabled(): boolean {
    return this.options.ttlMs > 0;
  }

  get(key: string, now: number = Date.now()): V | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency for LRU-ish eviction ordering.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, now: number = Date.now()): void {
    if (!this.enabled) {
      return;
    }
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, { value, expiresAt: now + this.options.ttlMs });

    const maxEntries = this.options.maxEntries ?? 200;
    while (this.entries.size > maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  /** Remove every entry whose key starts with the given prefix. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
