import { describe, expect, it, vi } from 'vitest';
import aiKnowledgeBase from '../resources/ai-knowledge-base';

describe('aiKnowledgeBase.searchAnalytics', () => {
  function makeAdminCtx(db: unknown) {
    return {
      action: { params: {} },
      auth: { user: { id: 1, roles: ['root'] } },
      state: { currentRoles: ['root'] },
      app: { acl: { getRole: vi.fn(() => ({ getStrategy: () => ({ allowConfigure: true }) })) } },
      db,
      throw: vi.fn(),
      body: null,
    } as never;
  }

  it('rejects non-admin users', async () => {
    const ctx = {
      action: { params: {} },
      auth: { user: { id: 7, roles: ['member'] } },
      state: { currentRoles: ['member'] },
      app: { acl: { getRole: vi.fn() } },
      db: {},
      throw: vi.fn(),
      body: null,
    } as never;
    const next = vi.fn();

    await aiKnowledgeBase.actions.searchAnalytics(ctx, next);

    expect((ctx as any).throw).toHaveBeenCalledWith(403, 'Only administrators can view search analytics');
    expect(next).not.toHaveBeenCalled();
  });

  it('aggregates top queries and average latency for admins', async () => {
    const records = [
      {
        query: 'deployment',
        searchLatencyMs: 100,
        toJSON() {
          return this;
        },
      },
      {
        query: 'deployment',
        searchLatencyMs: 200,
        toJSON() {
          return this;
        },
      },
      {
        query: 'pricing',
        searchLatencyMs: 50,
        toJSON() {
          return this;
        },
      },
    ];
    const repo = {
      find: vi.fn(async () => records),
    };
    const ctx = makeAdminCtx({
      getRepository: vi.fn(() => repo),
    }) as any;
    const next = vi.fn();

    await aiKnowledgeBase.actions.searchAnalytics(ctx, next);

    expect(ctx.body.totalSearches).toBe(3);
    expect(ctx.body.averageLatencyMs).toBe(Math.round((100 + 200 + 50) / 3));
    expect(ctx.body.uniqueQueries).toBe(2);
    expect(ctx.body.topQueries[0]).toEqual({ query: 'deployment', count: 2 });
    expect(ctx.body.topQueries[1]).toEqual({ query: 'pricing', count: 1 });
    expect(next).toHaveBeenCalled();
  });

  it('returns zeros when no data exists', async () => {
    const repo = { find: vi.fn(async () => []) };
    const ctx = makeAdminCtx({
      getRepository: vi.fn(() => repo),
    }) as any;
    const next = vi.fn();

    await aiKnowledgeBase.actions.searchAnalytics(ctx, next);

    expect(ctx.body).toEqual({
      periodDays: 30,
      totalSearches: 0,
      averageLatencyMs: 0,
      uniqueQueries: 0,
      topQueries: [],
    });
  });
});
