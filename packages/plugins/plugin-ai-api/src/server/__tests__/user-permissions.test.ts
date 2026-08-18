/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiApiUsageGroup } from '../quota-groups';
import {
  buildAccessScope,
  enforceModelAccess,
  invalidateGroupAccessCache,
  isModelAllowed,
  isServiceAllowed,
  resolveUserAccessScope,
} from '../utils/user-permissions';

const OPENAI = { name: 'openai', title: 'OpenAI' };
const ANTHROPIC = { name: 'anthropic', title: 'Anthropic' };

function group(values: Partial<AiApiUsageGroup> = {}): AiApiUsageGroup {
  return {
    id: 1,
    name: 'Test group',
    isDefault: false,
    quotaMode: 'per_user',
    rateLimitPerMinute: 60,
    enabled: false,
    periodType: 'monthly',
    timezone: 'UTC',
    requestLimit: null,
    totalTokenLimit: null,
    costLimit: null,
    currency: 'USD',
    rejectUnpricedModel: true,
    missingUsageBehavior: 'use_reserved',
    contextOverflowBehavior: 'reject',
    allowedLlmServices: [],
    allowAllModels: true,
    allowedModels: [],
    ...values,
  };
}

/** Sequelize models expose columns via .get(); .get() with no argument returns the full record. */
function row(values: Record<string, unknown>) {
  return { get: (key?: string) => (key === undefined ? values : values[key]) };
}

const DEFAULT_GROUP_ROW = row({
  id: 99,
  name: 'Default',
  isDefault: true,
  allowedLlmServices: [],
  allowAllModels: true,
  allowedModels: [],
});

interface MockOptions {
  /** Default 1; null simulates an unauthenticated caller. */
  userId?: number | null;
  /** The group row attached to the caller's membership; omit = no membership row. */
  memberGroup?: unknown;
  /** Membership exists but points at a missing group. */
  memberWithoutGroup?: boolean;
  /** Default group row; omit = DEFAULT_GROUP_ROW, null = missing (lazy-create path). */
  defaultGroup?: unknown;
  throws?: boolean;
  appName?: string;
}

function mockContext(options: MockOptions = {}) {
  const memberGroup = options.memberGroup ?? null;
  const memberFindOne = vi.fn(async () => {
    if (options.throws) throw new Error('collection unavailable');
    if (options.memberWithoutGroup) return row({ group: null });
    if (!memberGroup) return null;
    return row({ group: memberGroup });
  });
  const hasDefault = 'defaultGroup' in options;
  const groupFindOne = vi.fn(async () => {
    if (options.throws) throw new Error('collection unavailable');
    return hasDefault ? options.defaultGroup : DEFAULT_GROUP_ROW;
  });
  const groupCreate = vi.fn(async ({ values }: { values: Record<string, unknown> }) =>
    row({ id: 99, isDefault: true, allowedLlmServices: [], allowAllModels: true, allowedModels: [], ...values }),
  );
  const ctx = {
    state: { currentUser: options.userId === null ? undefined : { id: options.userId ?? 1 } },
    db: {
      getRepository: (name: string) =>
        name === 'aiApiGroupMembers' ? { findOne: memberFindOne } : { findOne: groupFindOne, create: groupCreate },
    },
    app: { name: options.appName ?? 'main' },
    log: { warn: vi.fn(), error: vi.fn() },
    status: 200,
    body: undefined,
  } as unknown as Context;
  return {
    ctx,
    memberFindOne,
    groupFindOne,
    groupCreate,
  };
}

beforeEach(() => {
  invalidateGroupAccessCache();
});

describe('buildAccessScope', () => {
  it('treats empty group lists as no narrowing', () => {
    const scope = buildAccessScope(group());
    expect(scope.allowedServices).toEqual([]);
    expect(scope.allowAllModels).toBe(true);
    expect(scope.allowedModels.size).toBe(0);
    expect(scope.lookupFailed).toBe(false);
  });

  it('carries the group id for cache keying', () => {
    expect(buildAccessScope(group({ id: 7 })).groupId).toBe(7);
  });

  it('narrows services and models from the group settings', () => {
    const scope = buildAccessScope(
      group({ allowedLlmServices: ['openai'], allowAllModels: false, allowedModels: ['openai/gpt-4o'] }),
    );
    expect(scope.allowedServices).toEqual(['openai']);
    expect(scope.allowAllModels).toBe(false);
    expect(scope.allowedModels.has('openai/gpt-4o')).toBe(true);
  });

  it('defaults allowAllModels to true when the column is unset', () => {
    expect(buildAccessScope(group({ allowAllModels: undefined })).allowAllModels).toBe(true);
  });

  it('discards non-string entries in the json arrays', () => {
    const scope = buildAccessScope(
      group({
        allowedLlmServices: ['openai', null, 42, ''] as unknown as string[],
        allowedModels: [{}, 'openai/gpt-4o'] as unknown as string[],
      }),
    );
    expect(scope.allowedServices).toEqual(['openai']);
    expect([...scope.allowedModels]).toEqual(['openai/gpt-4o']);
  });
});

describe('isServiceAllowed', () => {
  const open = buildAccessScope(group());

  it('an open group inherits the global whitelist', () => {
    expect(isServiceAllowed(open, ['openai'], OPENAI)).toBe(true);
    expect(isServiceAllowed(open, ['openai'], ANTHROPIC)).toBe(false);
    expect(isServiceAllowed(open, [], ANTHROPIC)).toBe(true);
  });

  it('never widens the global whitelist (strict subset)', () => {
    const scope = buildAccessScope(group({ allowedLlmServices: ['openai', 'anthropic'] }));
    expect(isServiceAllowed(scope, ['openai'], OPENAI)).toBe(true);
    // Granted to the group, but absent from the global whitelist → still denied.
    expect(isServiceAllowed(scope, ['openai'], ANTHROPIC)).toBe(false);
  });

  it('narrows within an empty global whitelist', () => {
    const scope = buildAccessScope(group({ allowedLlmServices: ['openai'] }));
    expect(isServiceAllowed(scope, [], OPENAI)).toBe(true);
    expect(isServiceAllowed(scope, [], ANTHROPIC)).toBe(false);
  });

  it('matches a service by title as well as by name', () => {
    const scope = buildAccessScope(group({ allowedLlmServices: ['OpenAI'] }));
    expect(isServiceAllowed(scope, [], OPENAI)).toBe(true);
    expect(isServiceAllowed(scope, [], ANTHROPIC)).toBe(false);
  });

  it('denies everything when the lookup failed', () => {
    const failed = { ...open, lookupFailed: true };
    expect(isServiceAllowed(failed, [], OPENAI)).toBe(false);
    expect(isServiceAllowed(failed, ['openai'], OPENAI)).toBe(false);
  });

  it('tolerates a null or malformed global whitelist', () => {
    expect(isServiceAllowed(open, null, OPENAI)).toBe(true);
    expect(isServiceAllowed(open, 'openai', OPENAI)).toBe(true);
  });
});

describe('isModelAllowed', () => {
  it('allows every model when the group allows all', () => {
    expect(isModelAllowed(buildAccessScope(group()), 'openai/gpt-4o')).toBe(true);
  });

  it('restricts to the listed models when allowAllModels is false', () => {
    const scope = buildAccessScope(group({ allowAllModels: false, allowedModels: ['openai/gpt-4o'] }));
    expect(isModelAllowed(scope, 'openai/gpt-4o')).toBe(true);
    expect(isModelAllowed(scope, 'openai/gpt-4o-mini')).toBe(false);
  });

  it('denies every model when the lookup failed', () => {
    const failed = { ...buildAccessScope(group()), lookupFailed: true };
    expect(isModelAllowed(failed, 'openai/gpt-4o')).toBe(false);
  });
});

describe('resolveUserAccessScope', () => {
  it('resolves the default group for an unauthenticated caller without a membership lookup', async () => {
    const { ctx, memberFindOne, groupFindOne } = mockContext({ userId: null });
    const scope = await resolveUserAccessScope(ctx);
    expect(scope.allowedServices).toEqual([]);
    expect(scope.allowAllModels).toBe(true);
    expect(memberFindOne).not.toHaveBeenCalled();
    expect(groupFindOne).toHaveBeenCalledTimes(1);
  });

  it('lazily creates the default group when it is missing', async () => {
    const { ctx, groupCreate } = mockContext({ userId: null, defaultGroup: null });
    const scope = await resolveUserAccessScope(ctx);
    expect(groupCreate).toHaveBeenCalledTimes(1);
    expect(scope.allowAllModels).toBe(true);
  });

  it('narrows the scope by the membership group', async () => {
    const { ctx } = mockContext({ memberGroup: row(group({ id: 5, allowedLlmServices: ['openai'] })) });
    const scope = await resolveUserAccessScope(ctx);
    expect(scope.groupId).toBe(5);
    expect(scope.allowedServices).toEqual(['openai']);
  });

  it('falls back to the default group when the membership points at a missing group', async () => {
    const { ctx, groupFindOne } = mockContext({ memberWithoutGroup: true });
    const scope = await resolveUserAccessScope(ctx);
    expect(scope.allowedServices).toEqual([]);
    expect(groupFindOne).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the cached scope when the group row changes within the TTL', async () => {
    const first = mockContext({ memberGroup: row(group({ id: 5, allowedLlmServices: ['openai'] })) });
    expect((await resolveUserAccessScope(first.ctx)).allowedServices).toEqual(['openai']);

    // The next request resolves membership live, but the scope for group 5 is still cached.
    const second = mockContext({ memberGroup: row(group({ id: 5, allowedLlmServices: ['anthropic'] })) });
    expect((await resolveUserAccessScope(second.ctx)).allowedServices).toEqual(['openai']);
    expect(second.memberFindOne).toHaveBeenCalledTimes(1);

    invalidateGroupAccessCache(5);
    const third = mockContext({ memberGroup: row(group({ id: 5, allowedLlmServices: ['anthropic'] })) });
    expect((await resolveUserAccessScope(third.ctx)).allowedServices).toEqual(['anthropic']);
  });

  it('needs no invalidation when a user moves to another group', async () => {
    const first = mockContext({ memberGroup: row(group({ id: 5, allowedLlmServices: ['openai'] })) });
    expect((await resolveUserAccessScope(first.ctx)).allowedServices).toEqual(['openai']);

    // The next request resolves the new membership live, so no cache invalidation is needed.
    const second = mockContext({ memberGroup: row(group({ id: 6, allowedLlmServices: ['anthropic'] })) });
    expect((await resolveUserAccessScope(second.ctx)).allowedServices).toEqual(['anthropic']);
  });

  it('shares one cache entry between members of the same group', async () => {
    const first = mockContext({ userId: 1, memberGroup: row(group({ id: 5, allowedLlmServices: ['openai'] })) });
    const second = mockContext({ userId: 2, memberGroup: row(group({ id: 5, allowedLlmServices: ['openai'] })) });
    const a = await resolveUserAccessScope(first.ctx);
    const b = await resolveUserAccessScope(second.ctx);
    expect(b).toBe(a);
  });

  it('fails closed when the membership lookup is unavailable', async () => {
    const { ctx } = mockContext({ throws: true });
    const scope = await resolveUserAccessScope(ctx);
    // Treating a failed lookup as "open" would silently lift every user's restrictions
    // during a rolling upgrade where the tables do not exist yet.
    expect(scope.lookupFailed).toBe(true);
    expect(ctx.log.error).toHaveBeenCalled();
    expect(isServiceAllowed(scope, [], OPENAI)).toBe(false);
    expect(isModelAllowed(scope, 'openai/gpt-4o')).toBe(false);
  });

  it('does not cache a failed lookup', async () => {
    const { ctx, memberFindOne } = mockContext({ throws: true });
    await resolveUserAccessScope(ctx);
    await resolveUserAccessScope(ctx);
    expect(memberFindOne).toHaveBeenCalledTimes(2);
  });

  it('does not share a cache entry between apps with the same group id', async () => {
    const main = mockContext({ appName: 'main', memberGroup: row(group({ id: 5, allowedLlmServices: ['openai'] })) });
    const sub = mockContext({ appName: 'sub', memberGroup: row(group({ id: 5, allowedLlmServices: ['anthropic'] })) });
    expect((await resolveUserAccessScope(main.ctx)).allowedServices).toEqual(['openai']);
    // Sub-apps share this process but have separate databases, so group 5 in "sub" is a
    // different group than group 5 in "main" and must not inherit its cached scope.
    expect((await resolveUserAccessScope(sub.ctx)).allowedServices).toEqual(['anthropic']);
    expect(sub.memberFindOne).toHaveBeenCalledTimes(1);
  });

  it('invalidates a group across every app', async () => {
    const main = mockContext({ appName: 'main', memberGroup: row(group({ id: 5, allowedLlmServices: ['openai'] })) });
    const sub = mockContext({ appName: 'sub', memberGroup: row(group({ id: 5, allowedLlmServices: ['openai'] })) });
    const mainBefore = await resolveUserAccessScope(main.ctx);
    const subBefore = await resolveUserAccessScope(sub.ctx);

    invalidateGroupAccessCache(5);

    expect(await resolveUserAccessScope(main.ctx)).not.toBe(mainBefore);
    expect(await resolveUserAccessScope(sub.ctx)).not.toBe(subBefore);
  });

  it('does not invalidate a group whose id is a suffix of another', async () => {
    const first = mockContext({ userId: 1, memberGroup: row(group({ id: 1, allowedLlmServices: ['openai'] })) });
    const second = mockContext({ userId: 2, memberGroup: row(group({ id: 21, allowedLlmServices: ['openai'] })) });
    const secondBefore = await resolveUserAccessScope(second.ctx);
    await resolveUserAccessScope(first.ctx);

    invalidateGroupAccessCache(1);

    expect(await resolveUserAccessScope(second.ctx)).toBe(secondBefore);
  });
});

describe('enforceModelAccess', () => {
  it('passes a permitted service and model through untouched', async () => {
    const { ctx } = mockContext({});
    expect(await enforceModelAccess(ctx, ['openai'], OPENAI, 'gpt-4o')).toBe(true);
    expect(ctx.status).toBe(200);
  });

  it('returns 403 model_not_available for a denied service', async () => {
    const { ctx } = mockContext({ memberGroup: row(group({ id: 5, allowedLlmServices: ['openai'] })) });
    expect(await enforceModelAccess(ctx, ['openai', 'anthropic'], ANTHROPIC, 'claude')).toBe(false);
    expect(ctx.status).toBe(403);
    // `permission_denied` is what every other 403 in this plugin reports; keeping the type
    // consistent means OpenAI clients can branch on it uniformly.
    expect(ctx.body).toMatchObject({ error: { code: 'model_not_available', type: 'permission_denied' } });
  });

  it('returns 403 model_not_available for a denied model of a granted service', async () => {
    const { ctx } = mockContext({
      memberGroup: row(
        group({ id: 5, allowedLlmServices: ['openai'], allowAllModels: false, allowedModels: ['openai/gpt-4o'] }),
      ),
    });
    expect(await enforceModelAccess(ctx, ['openai'], OPENAI, 'gpt-4o-mini')).toBe(false);
    expect(ctx.status).toBe(403);
    expect(ctx.body).toMatchObject({ error: { code: 'model_not_available', type: 'permission_denied' } });
  });

  it('denies a group-granted service that the global whitelist excludes', async () => {
    const { ctx } = mockContext({ memberGroup: row(group({ id: 5, allowedLlmServices: ['anthropic'] })) });
    expect(await enforceModelAccess(ctx, ['openai'], ANTHROPIC, 'claude')).toBe(false);
    expect(ctx.status).toBe(403);
  });

  it('returns a retryable 503 rather than allowing access when the lookup fails', async () => {
    const { ctx } = mockContext({ throws: true });
    expect(await enforceModelAccess(ctx, [], OPENAI, 'gpt-4o')).toBe(false);
    // 503 not 403: the failure is ours, so clients should back off rather than treat the
    // grant as permanently revoked.
    expect(ctx.status).toBe(503);
    expect(ctx.body).toMatchObject({ error: { code: 'permission_check_failed' } });
  });
});
