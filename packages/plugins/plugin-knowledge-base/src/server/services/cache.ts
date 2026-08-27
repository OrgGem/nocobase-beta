/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * In-memory TTL + LRU cache for Knowledge Base search results and embeddings.
 *
 * - Entries expire after a configurable TTL (default 5 minutes).
 * - When maxEntries is exceeded, the least-recently-used entry is evicted.
 * - Cache can be invalidated by prefix (e.g. per knowledge base) or fully cleared,
 *   which happens automatically when documents are vectorized/deleted.
 *
 * This is a single-process cache. For multi-instance deployments each process
 * keeps its own cache — correctness is preserved because invalidation is
 * triggered by local write paths; cross-node staleness is bounded by the TTL.
 */

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export type SearchCacheValue = unknown[];

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

export class KbCacheService {
  private store = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }

    // Refresh recency for LRU behavior
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    if (this.store.size >= this.maxEntries) {
      this.evictOldest();
    }
    const expiresAt = Date.now() + (ttlMs ?? this.ttlMs);
    // Delete first so re-setting an existing key refreshes LRU order
    this.store.delete(key);
    this.store.set(key, { value, expiresAt });
  }

  /**
   * Get-or-load helper. Returns cached value when fresh; otherwise calls
   * loader(), stores the result, and returns it.
   */
  async getOrLoad<T>(key: string, loader: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = await loader();
    this.set(key, value, ttlMs);
    return value;
  }

  /** Remove every key that starts with the given prefix (e.g. `search:<kbId>:`). */
  invalidatePrefix(prefix: string): number {
    let removed = 0;
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Invalidate all cached entries whose KB-id section includes any of the
   * given ids. Search keys have the form search:<id1,id2,...>:....
   */
  invalidateKnowledgeBaseIds(kbIds: string[]): number {
    const idSet = new Set(kbIds.map(String));
    let removed = 0;
    for (const key of Array.from(this.store.keys())) {
      if (!key.startsWith('search:')) continue;
      const idsSection = key.slice('search:'.length).split(':')[0] ?? '';
      for (const id of idsSection.split(',')) {
        if (idSet.has(id)) {
          this.store.delete(key);
          removed += 1;
          break;
        }
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  private evictOldest(): void {
    const oldestKey = this.store.keys().next().value as string | undefined;
    if (oldestKey !== undefined) {
      this.store.delete(oldestKey);
    }
  }
}

/** Build a deterministic cache key for a search request. */
export function buildSearchCacheKey(kbIds: string[], query: string, options: Record<string, unknown>): string {
  const sortedIds = [...kbIds].sort();
  const opts = JSON.stringify(options);
  return `search:${sortedIds.join(',')}:${query}:${opts}`;
}
