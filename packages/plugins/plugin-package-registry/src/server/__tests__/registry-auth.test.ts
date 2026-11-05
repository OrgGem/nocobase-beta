/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { createPackageRegistryRouter } from '../registry-router';

function fixture(authRequired: boolean, authenticated = false) {
  const packageLookup = vi.fn(async () => null);
  const authenticate = vi.fn(async (ctx) => {
    if (authenticated) ctx.state.currentUser = { id: 7 };
    else ctx.throw(401);
  });
  const plugin = {
    app: { dataSourceManager: { get: () => ({}) }, authManager: { middleware: () => authenticate } },
    db: {
      getRepository: (name: string) =>
        name === 'packageRegistries'
          ? { findOne: async () => ({ id: 1, name: 'private', authRequired }) }
          : { findOne: packageLookup },
    },
  };
  const ctx = {
    path: '/api/package-registry/npm/private/example',
    method: 'GET',
    state: {},
    status: 200,
    body: undefined,
    throw: (status: number) => {
      throw Object.assign(new Error('denied'), { status });
    },
  };
  return { plugin, ctx, packageLookup, authenticate };
}

describe('private npm registry authentication', () => {
  it.each([
    '/api/package-registry/npm/private/example',
    '/api/package-registry/npm/private/example/-/example-1.0.0.tgz',
  ])('rejects anonymous access before metadata/cache/file lookup: %s', async (path) => {
    const { plugin, ctx, packageLookup, authenticate } = fixture(true);
    ctx.path = path;
    await createPackageRegistryRouter(plugin)(ctx, vi.fn());
    expect(ctx.status).toBe(401);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(packageLookup).not.toHaveBeenCalled();
  });
  it.each([
    [false, false],
    [true, true],
  ])('allows lookup for public=%s authenticated=%s', async (authRequired, authenticated) => {
    const { plugin, ctx, packageLookup, authenticate } = fixture(authRequired, authenticated);
    await createPackageRegistryRouter(plugin)(ctx, vi.fn());
    expect(packageLookup).toHaveBeenCalled();
    expect(ctx.status).toBe(404);
    expect(authenticate).toHaveBeenCalledTimes(authRequired ? 1 : 0);
  });
});
