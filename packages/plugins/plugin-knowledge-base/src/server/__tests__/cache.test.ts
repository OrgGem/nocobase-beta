// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { KbCacheService, buildSearchCacheKey } from '../services/cache';
import { KnowledgeSearchService } from '../services/knowledge-search';

function createExternalSearchFixture() {
  const knowledgeBase = {
    id: 'kb-9',
    name: 'Public external KB',
    type: 'EXTERNAL_RAG',
    enabled: true,
    accessLevel: 'PUBLIC',
    options: { ragProvider: 'test-provider' },
  };
  const repository = { find: vi.fn(async () => [knowledgeBase]) };
  const strategy = vi.fn(async () => [{ content: 'result', score: 0.9 }]);
  const plugin = {
    db: { getRepository: vi.fn(() => repository) },
    getRagSearchStrategy: vi.fn(() => strategy),
  };
  const ctx = {
    auth: { user: { id: '7', roles: ['member'] } },
    state: { currentRoles: ['member'] },
  };
  return { service: new KnowledgeSearchService(plugin), ctx, strategy };
}

describe('KbCacheService', () => {
  it('stores and retrieves values within TTL', async () => {
    const cache = new KbCacheService(60_000);
    await cache.getOrLoad('k1', async () => [1, 2, 3]);
    expect(cache.get('k1')).toEqual([1, 2, 3]);
  });

  it('expires entries after TTL', async () => {
    vi.useFakeTimers();
    const cache = new KbCacheService(10);
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');
    vi.advanceTimersByTime(20);
    expect(cache.get('k')).toBeUndefined();
    vi.useRealTimers();
  });

  it('evicts LRU entry when maxEntries exceeded', () => {
    const cache = new KbCacheService(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // refresh a
    cache.set('c', 3); // evicts b
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.size()).toBe(2);
  });

  it('invalidateKnowledgeBaseIds removes only matching search keys', () => {
    const cache = new KbCacheService(60_000);
    cache.set(buildSearchCacheKey(['kb-1'], 'q1', {}), ['r1']);
    cache.set(buildSearchCacheKey(['kb-2'], 'q2', {}), ['r2']);
    cache.set('other:key', 'keep');

    const removed = cache.invalidateKnowledgeBaseIds(['kb-1']);

    expect(removed).toBe(1);
    expect(cache.get(buildSearchCacheKey(['kb-1'], 'q1', {}))).toBeUndefined();
    expect(cache.get(buildSearchCacheKey(['kb-2'], 'q2', {}))).toEqual(['r2']);
    expect(cache.get('other:key')).toBe('keep');
  });
});

describe('KnowledgeSearchService.searchCached', () => {
  it('caches identical authorized requests and skips the external provider on a hit', async () => {
    const { service, ctx, strategy } = createExternalSearchFixture();
    KnowledgeSearchService.cache.clear();

    const options = { knowledgeBaseIds: ['kb-9'], topK: 5 };
    const first = await service.searchCached(ctx as never, 'hello', options);
    const second = await service.searchCached(ctx as never, 'hello', options);

    expect(first.map((result) => result.content)).toEqual(['result']);
    expect(second.map((result) => result.content)).toEqual(['result']);
    expect(strategy).toHaveBeenCalledTimes(1);

    KnowledgeSearchService.cache.clear();
  });

  it('only matching KB invalidation forces a provider reload', async () => {
    const { service, ctx, strategy } = createExternalSearchFixture();
    KnowledgeSearchService.cache.clear();

    const options = { knowledgeBaseIds: ['kb-9'] };
    await service.searchCached(ctx as never, 'query', options);
    KnowledgeSearchService.invalidateKnowledgeBase('kb-7');
    await service.searchCached(ctx as never, 'query', options);
    expect(strategy).toHaveBeenCalledTimes(1);

    KnowledgeSearchService.invalidateKnowledgeBase('kb-9');
    await service.searchCached(ctx as never, 'query', options);

    expect(strategy).toHaveBeenCalledTimes(2);
    KnowledgeSearchService.cache.clear();
  });
});
