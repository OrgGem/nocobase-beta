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
import {
  buildAccessScope,
  enforceModelAccess,
  invalidateUserPermissionCache,
  isModelAllowed,
  isServiceAllowed,
  resolveUserAccessScope,
} from '../utils/user-permissions';

const OPENAI = { name: 'openai', title: 'OpenAI' };
const ANTHROPIC = { name: 'anthropic', title: 'Anthropic' };

/** Sequelize instances only expose columns via .get(); rows must be shaped that way. */
function row(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

function mockContext(options: { userId?: number | null; row?: unknown; throws?: boolean; appName?: string } = {}) {
  const findOne = vi.fn(async () => {
    if (options.throws) throw new Error('collection unavailable');
    return options.row ?? null;
  });
  const ctx = {
    state: { currentUser: options.userId === null ? undefined : { id: options.userId ?? 1 } },
    db: { getRepository: () => ({ findOne }) },
    app: { name: options.appName ?? 'main' },
    log: { warn: vi.fn(), error: vi.fn() },
    status: 200,
    body: undefined,
  } as unknown as Context;
  return { ctx, findOne };
}

beforeEach(() => {
  invalidateUserPermissionCache();
});

describe('buildAccessScope', () => {
  it('treats a missing row as "no user-level narrowing"', () => {
    const scope = buildAccessScope(null);
    expect(scope.hasUserRecord).toBe(false);
    expect(scope.denyAll).toBe(false);
    expect(scope.allowedServices).toBeNull();
  });

  it('marks a disabled row as deny-all', () => {
    const scope = buildAccessScope(row({ enabled: false, allowedLlmServices: ['openai'] }));
    expect(scope.denyAll).toBe(true);
    expect(scope.allowedServices).toEqual([]);
  });

  it('reads columns through .get() rather than plain property access', () => {
    const scope = buildAccessScope(
      row({ allowedLlmServices: ['openai'], allowAllModels: false, allowedModels: ['openai/gpt-4o'] }),
    );
    expect(scope.allowedServices).toEqual(['openai']);
    expect(scope.allowAllModels).toBe(false);
    expect(scope.allowedModels.has('openai/gpt-4o')).toBe(true);
  });

  it('defaults allowAllModels to true when the column is unset', () => {
    expect(buildAccessScope(row({ allowedLlmServices: [] })).allowAllModels).toBe(true);
  });

  it('discards non-string entries in the json arrays', () => {
    const scope = buildAccessScope(
      row({ allowedLlmServices: ['openai', null, 42, ''], allowedModels: [{}, 'openai/gpt-4o'] }),
    );
    expect(scope.allowedServices).toEqual(['openai']);
    expect([...scope.allowedModels]).toEqual(['openai/gpt-4o']);
  });
});

describe('isServiceAllowed', () => {
  const noRecord = buildAccessScope(null);

  it('leaves behaviour unchanged for a user with no record', () => {
    expect(isServiceAllowed(noRecord, ['openai'], OPENAI)).toBe(true);
    expect(isServiceAllowed(noRecord, ['openai'], ANTHROPIC)).toBe(false);
    expect(isServiceAllowed(noRecord, [], ANTHROPIC)).toBe(true);
  });

  it('denies everything when the record is disabled', () => {
    const scope = buildAccessScope(row({ enabled: false, allowedLlmServices: ['openai'] }));
    expect(isServiceAllowed(scope, ['openai'], OPENAI)).toBe(false);
  });

  it('denies everything when the service list is empty', () => {
    const scope = buildAccessScope(row({ allowedLlmServices: [] }));
    expect(isServiceAllowed(scope, ['openai'], OPENAI)).toBe(false);
    expect(isServiceAllowed(scope, [], OPENAI)).toBe(false);
  });

  it('never widens the global whitelist (strict subset)', () => {
    const scope = buildAccessScope(row({ allowedLlmServices: ['openai', 'anthropic'] }));
    expect(isServiceAllowed(scope, ['openai'], OPENAI)).toBe(true);
    // Granted to the user, but absent from the global whitelist → still denied.
    expect(isServiceAllowed(scope, ['openai'], ANTHROPIC)).toBe(false);
  });

  it('matches a service by title as well as by name', () => {
    const byTitle = buildAccessScope(row({ allowedLlmServices: ['OpenAI'] }));
    expect(isServiceAllowed(byTitle, ['OpenAI'], OPENAI)).toBe(true);
    expect(isServiceAllowed(byTitle, [], OPENAI)).toBe(true);
    expect(isServiceAllowed(byTitle, [], ANTHROPIC)).toBe(false);
  });

  it('narrows within an empty global whitelist', () => {
    const scope = buildAccessScope(row({ allowedLlmServices: ['openai'] }));
    expect(isServiceAllowed(scope, [], OPENAI)).toBe(true);
    expect(isServiceAllowed(scope, [], ANTHROPIC)).toBe(false);
  });

  it('tolerates a null or malformed global whitelist', () => {
    expect(isServiceAllowed(noRecord, null, OPENAI)).toBe(true);
    expect(isServiceAllowed(noRecord, 'openai', OPENAI)).toBe(true);
  });
});

describe('isModelAllowed', () => {
  it('allows every model when the user has no record', () => {
    expect(isModelAllowed(buildAccessScope(null), 'openai/gpt-4o')).toBe(true);
  });

  it('allows every model of the granted services when allowAllModels is true', () => {
    const scope = buildAccessScope(row({ allowedLlmServices: ['openai'], allowAllModels: true }));
    expect(isModelAllowed(scope, 'openai/anything')).toBe(true);
  });

  it('restricts to the listed models when allowAllModels is false', () => {
    const scope = buildAccessScope(
      row({ allowedLlmServices: ['openai'], allowAllModels: false, allowedModels: ['openai/gpt-4o'] }),
    );
    expect(isModelAllowed(scope, 'openai/gpt-4o')).toBe(true);
    expect(isModelAllowed(scope, 'openai/gpt-4o-mini')).toBe(false);
  });

  it('denies every model when the record is disabled', () => {
    const scope = buildAccessScope(row({ enabled: false, allowAllModels: true }));
    expect(isModelAllowed(scope, 'openai/gpt-4o')).toBe(false);
  });
});

describe('resolveUserAccessScope', () => {
  it('returns the no-record scope for an unauthenticated context', async () => {
    const { ctx, findOne } = mockContext({ userId: null });
    expect((await resolveUserAccessScope(ctx)).hasUserRecord).toBe(false);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('caches the scope per user instead of querying on every request', async () => {
    const { ctx, findOne } = mockContext({ row: row({ allowedLlmServices: ['openai'] }) });
    await resolveUserAccessScope(ctx);
    await resolveUserAccessScope(ctx);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('re-queries after the cache is invalidated for that user', async () => {
    const { ctx, findOne } = mockContext({ userId: 7, row: row({ allowedLlmServices: ['openai'] }) });
    await resolveUserAccessScope(ctx);
    invalidateUserPermissionCache(7);
    await resolveUserAccessScope(ctx);
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('keeps other users cached when one user is invalidated', async () => {
    const first = mockContext({ userId: 1, row: row({ allowedLlmServices: ['openai'] }) });
    const second = mockContext({ userId: 2, row: row({ allowedLlmServices: ['openai'] }) });
    await resolveUserAccessScope(first.ctx);
    await resolveUserAccessScope(second.ctx);
    invalidateUserPermissionCache(2);
    await resolveUserAccessScope(first.ctx);
    expect(first.findOne).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the collection is unavailable', async () => {
    const { ctx } = mockContext({ throws: true });
    const scope = await resolveUserAccessScope(ctx);
    // Treating a failed lookup as "no record" would silently lift every user's restrictions
    // during a rolling upgrade where the table does not exist yet.
    expect(scope.lookupFailed).toBe(true);
    expect(scope.denyAll).toBe(true);
    expect(ctx.log.error).toHaveBeenCalled();
  });

  it('denies every service and model when the lookup failed', async () => {
    const { ctx } = mockContext({ throws: true });
    const scope = await resolveUserAccessScope(ctx);
    expect(isServiceAllowed(scope, [], OPENAI)).toBe(false);
    expect(isModelAllowed(scope, 'openai/gpt-4o')).toBe(false);
  });

  it('does not cache a failed lookup', async () => {
    const { ctx, findOne } = mockContext({ throws: true });
    await resolveUserAccessScope(ctx);
    await resolveUserAccessScope(ctx);
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('does not share a cache entry between apps with the same user id', async () => {
    const main = mockContext({ userId: 1, appName: 'main', row: row({ allowedLlmServices: ['openai'] }) });
    const sub = mockContext({ userId: 1, appName: 'sub', row: row({ allowedLlmServices: ['anthropic'] }) });
    await resolveUserAccessScope(main.ctx);
    const subScope = await resolveUserAccessScope(sub.ctx);
    // Sub-apps share this process but have separate databases, so user 1 in "sub" is a
    // different person than user 1 in "main" and must not inherit their grant.
    expect(sub.findOne).toHaveBeenCalledTimes(1);
    expect(subScope.allowedServices).toEqual(['anthropic']);
  });

  it('invalidates a user across every app', async () => {
    const main = mockContext({ userId: 1, appName: 'main', row: row({ allowedLlmServices: ['openai'] }) });
    const sub = mockContext({ userId: 1, appName: 'sub', row: row({ allowedLlmServices: ['openai'] }) });
    await resolveUserAccessScope(main.ctx);
    await resolveUserAccessScope(sub.ctx);
    invalidateUserPermissionCache(1);
    await resolveUserAccessScope(main.ctx);
    await resolveUserAccessScope(sub.ctx);
    expect(main.findOne).toHaveBeenCalledTimes(2);
    expect(sub.findOne).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate a user whose id is a suffix of another', async () => {
    const first = mockContext({ userId: 1, row: row({ allowedLlmServices: ['openai'] }) });
    const second = mockContext({ userId: 21, row: row({ allowedLlmServices: ['openai'] }) });
    await resolveUserAccessScope(first.ctx);
    await resolveUserAccessScope(second.ctx);
    invalidateUserPermissionCache(1);
    await resolveUserAccessScope(second.ctx);
    expect(second.findOne).toHaveBeenCalledTimes(1);
  });
});

describe('enforceModelAccess', () => {
  it('passes a permitted service and model through untouched', async () => {
    const { ctx } = mockContext({ row: row({ allowedLlmServices: ['openai'] }) });
    expect(await enforceModelAccess(ctx, ['openai'], OPENAI, 'gpt-4o')).toBe(true);
    expect(ctx.status).toBe(200);
  });

  it('returns 403 model_not_available for a denied service', async () => {
    const { ctx } = mockContext({ row: row({ allowedLlmServices: ['openai'] }) });
    expect(await enforceModelAccess(ctx, ['openai', 'anthropic'], ANTHROPIC, 'claude')).toBe(false);
    expect(ctx.status).toBe(403);
    // `permission_denied` is what every other 403 in this plugin reports; keeping the type
    // consistent means OpenAI clients can branch on it uniformly.
    expect(ctx.body).toMatchObject({ error: { code: 'model_not_available', type: 'permission_denied' } });
  });

  it('returns 403 model_not_available for a denied model of a granted service', async () => {
    const { ctx } = mockContext({
      row: row({ allowedLlmServices: ['openai'], allowAllModels: false, allowedModels: ['openai/gpt-4o'] }),
    });
    expect(await enforceModelAccess(ctx, ['openai'], OPENAI, 'gpt-4o-mini')).toBe(false);
    expect(ctx.status).toBe(403);
    expect(ctx.body).toMatchObject({ error: { code: 'model_not_available', type: 'permission_denied' } });
  });

  it('denies a user-granted service that the global whitelist excludes', async () => {
    const { ctx } = mockContext({ row: row({ allowedLlmServices: ['anthropic'] }) });
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
