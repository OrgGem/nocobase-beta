import { describe, expect, it, vi } from 'vitest';
import { KbCacheService, buildSearchCacheKey } from '../services/cache';
import { KnowledgeSearchService } from '../services/knowledge-search';

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
  it('caches identical requests and skips loader on hit', async () => {
    const loader = vi.fn(async () => [{ content: 'result' }]);
    const plugin: any = {};
    const service = new KnowledgeSearchService(plugin);
    // Replace internal search via prototype stubbing
    const originalSearch = (service as unknown as { search: unknown }).search;
    (service as unknown as { search: unknown }).search = loader;

    KnowledgeSearchService.cache.clear();

    const options = { knowledgeBaseIds: ['kb-9'], topK: 5 };
    const first = await service.searchCached({} as never, 'hello', options);
    const second = await service.searchCached({} as never, 'hello', options);

    expect(first).toEqual([{ content: 'result' }]);
    expect(second).toEqual([{ content: 'result' }]);
    expect(loader).toHaveBeenCalledTimes(1);

    (service as unknown as { search: unknown }).search = originalSearch;
    KnowledgeSearchService.cache.clear();
  });

  it('invalidation by KB id forces reload', async () => {
    let callCount = 0;
    const loader = vi.fn(async () => {
      callCount += 1;
      return [{ content: `call-${callCount}` }];
    });
    const service = new KnowledgeSearchService({} as never);
    (service as unknown as { search: unknown }).search = loader;

    KnowledgeSearchService.cache.clear();

    const options = { knowledgeBaseIds: ['kb-7'] };
    await service.searchCached({} as never, 'query', options);
    KnowledgeSearchService.invalidateKnowledgeBase('kb-7');
    await service.searchCached({} as never, 'query', options);

    expect(loader).toHaveBeenCalledTimes(2);
    KnowledgeSearchService.cache.clear();
  });
});
