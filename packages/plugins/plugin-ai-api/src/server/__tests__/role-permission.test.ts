/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import { checkEmployeeAccess, checkRolePermission, invalidateRolePermissionCache } from '../middleware/role-permission';

function makeCtx(roleNames: string[], permissionsByRole: Record<string, Record<string, unknown> | null> = {}) {
  const findOne = vi
    .fn()
    .mockImplementation(({ filter }: { filter: { roleName: string } }) =>
      Promise.resolve(permissionsByRole[filter.roleName] ?? null),
    );
  const ctx: Partial<Context> = {
    app: { name: 'main' } as Context['app'],
    state: { currentRoles: roleNames },
    db: { getRepository: () => ({ findOne }) } as unknown as Context['db'],
  };
  return { ctx: ctx as Context, findOne };
}

describe('checkRolePermission', () => {
  it('denies root without a permission record (no built-in bypass)', async () => {
    invalidateRolePermissionCache('root');
    const { ctx } = makeCtx(['root']);
    await expect(checkRolePermission(ctx)).resolves.toBe(false);
    expect(ctx.status).toBe(403);
  });

  it('allows root when an enabled permission record exists', async () => {
    invalidateRolePermissionCache('root');
    const { ctx } = makeCtx(['root'], { root: { roleName: 'root', enabled: true, allowAllEmployees: true } });
    await expect(checkRolePermission(ctx)).resolves.toBe(true);
    expect(ctx.state.aiApiRolePermissions).toHaveLength(1);
  });

  it('denies a role when the permission record is disabled', async () => {
    invalidateRolePermissionCache('admin');
    const { ctx } = makeCtx(['admin'], { admin: { roleName: 'admin', enabled: false } });
    await expect(checkRolePermission(ctx)).resolves.toBe(false);
    expect(ctx.status).toBe(403);
  });

  it('allows a multi-role user when any role is enabled (union semantics)', async () => {
    invalidateRolePermissionCache();
    const { ctx } = makeCtx(['member', 'operator'], {
      member: null,
      operator: { roleName: 'operator', enabled: true, allowAllEmployees: true },
    });
    await expect(checkRolePermission(ctx)).resolves.toBe(true);
    const records = ctx.state.aiApiRolePermissions as Array<{ roleName: string }>;
    expect(records.map((r) => r.roleName)).toEqual(['operator']);
  });

  it('collects every enabled role for downstream union checks', async () => {
    invalidateRolePermissionCache();
    const { ctx } = makeCtx(['alpha', 'beta'], {
      alpha: { roleName: 'alpha', enabled: true, allowAllEmployees: false, allowedEmployees: ['a'] },
      beta: { roleName: 'beta', enabled: true, allowAllEmployees: false, allowedEmployees: ['b'] },
    });
    await expect(checkRolePermission(ctx)).resolves.toBe(true);
    expect(ctx.state.aiApiRolePermissions).toHaveLength(2);
  });

  it('does not share cached permissions between applications', async () => {
    invalidateRolePermissionCache();
    const { ctx: first } = makeCtx(['member'], { member: { roleName: 'member', enabled: true } });
    const { ctx: second, findOne } = makeCtx(['member'], { member: null });
    second.app.name = 'second';

    await expect(checkRolePermission(first)).resolves.toBe(true);
    await expect(checkRolePermission(second)).resolves.toBe(false);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('re-reads the record after invalidateRolePermissionCache (what the sync message triggers)', async () => {
    // Simulate a role being revoked on another node: the sync message handler calls
    // invalidateRolePermissionCache(roleName), so the next check must re-read the DB.
    invalidateRolePermissionCache('admin');
    const { ctx, findOne } = makeCtx(['admin'], { admin: { roleName: 'admin', enabled: true } });
    await expect(checkRolePermission(ctx)).resolves.toBe(true);
    expect(findOne).toHaveBeenCalledTimes(1);

    // The DB now returns a disabled record (revoked on another node).
    findOne.mockImplementation(({ filter }: { filter: { roleName: string } }) =>
      Promise.resolve(filter.roleName === 'admin' ? { roleName: 'admin', enabled: false } : null),
    );

    // Without invalidation the cached enabled record would still be served.
    await expect(checkRolePermission(ctx)).resolves.toBe(true);
    expect(findOne).toHaveBeenCalledTimes(1);

    // After invalidation the next check re-reads and sees the revocation.
    invalidateRolePermissionCache('admin');
    await expect(checkRolePermission(ctx)).resolves.toBe(false);
    expect(findOne).toHaveBeenCalledTimes(2);
  });
});

describe('checkEmployeeAccess', () => {
  it('allows when any role has allowAllEmployees', () => {
    const ctx = {
      state: { aiApiRolePermissions: [{ allowAllEmployees: true }] },
    } as unknown as Context;
    expect(checkEmployeeAccess(ctx, 'any-employee')).toBe(true);
  });

  it('denies when no permission records are stored', () => {
    const ctx = { state: {} } as unknown as Context;
    expect(checkEmployeeAccess(ctx, 'any-employee')).toBe(false);
  });

  it('allows an employee listed in any role (union of allowedEmployees)', () => {
    const ctx = {
      state: {
        aiApiRolePermissions: [
          { allowAllEmployees: false, allowedEmployees: ['alice'] },
          { allowAllEmployees: false, allowedEmployees: ['bob'] },
        ],
      },
    } as unknown as Context;
    expect(checkEmployeeAccess(ctx, 'alice')).toBe(true);
    expect(checkEmployeeAccess(ctx, 'bob')).toBe(true);
    expect(checkEmployeeAccess(ctx, 'carol')).toBe(false);
  });

  it('denies when no role grants the employee', () => {
    const ctx = {
      state: { aiApiRolePermissions: [{ allowAllEmployees: false, allowedEmployees: ['alice'] }] },
    } as unknown as Context;
    expect(checkEmployeeAccess(ctx, 'bob')).toBe(false);
  });
});
