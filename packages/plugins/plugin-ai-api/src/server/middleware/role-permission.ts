/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { toOpenAIError } from '../utils/openai-format';

const PERMISSION_TTL_MS = 15_000;

export interface RolePermissionRecord {
  roleName?: string;
  enabled?: boolean;
  allowAllEmployees?: boolean;
  allowedEmployees?: string[];
}

const permissionCache = new Map<string, { record: RolePermissionRecord | null; expiresAt: number }>();

export function invalidateRolePermissionCache(roleName?: string): void {
  if (!roleName) {
    permissionCache.clear();
    return;
  }
  const suffix = `:role:${roleName}`;
  for (const key of permissionCache.keys()) {
    if (key.endsWith(suffix)) permissionCache.delete(key);
  }
}

function unwrapRecord(raw: unknown): RolePermissionRecord | null {
  if (!raw) return null;
  if (typeof (raw as { get?: unknown }).get === 'function') {
    const model = raw as { get: (key: string) => unknown };
    return {
      roleName: model.get('roleName') as string | undefined,
      enabled: model.get('enabled') as boolean | undefined,
      allowAllEmployees: model.get('allowAllEmployees') as boolean | undefined,
      allowedEmployees: model.get('allowedEmployees') as string[] | undefined,
    };
  }
  return raw as RolePermissionRecord;
}

async function loadRolePermission(ctx: Context, roleName: string): Promise<RolePermissionRecord | null> {
  const cacheKey = `${ctx.app?.name ?? 'main'}:role:${roleName}`;
  const cached = permissionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.record;
  }
  const record = unwrapRecord(await ctx.db.getRepository('aiApiRolePermissions').findOne({ filter: { roleName } }));
  permissionCache.set(cacheKey, { record, expiresAt: Date.now() + PERMISSION_TTL_MS });
  return record;
}

/**
 * Check whether the authenticated roles are allowed to use the AI API.
 *
 * Every role — including root — must hold an enabled aiApiRolePermissions row;
 * there is no special-case bypass, so a leaked API key stays scoped to whatever
 * its role was granted in Settings → Users & Permissions → [Role] → AI API.
 *
 * Multi-role callers are evaluated with union semantics: the request is allowed
 * when ANY assigned role is enabled, and the enabled records are stored in
 * ctx.state.aiApiRolePermissions for downstream handlers (see checkEmployeeAccess).
 *
 * Returns true if access is allowed (caller may proceed).
 * Returns false if access is denied (403 already written to ctx, caller must return).
 */
export async function checkRolePermission(ctx: Context): Promise<boolean> {
  const roleNames = ctx.state.currentRoles?.length
    ? (ctx.state.currentRoles as string[])
    : [ctx.state.currentRole || 'member'];

  const records = (await Promise.all(roleNames.map((name) => loadRolePermission(ctx, name)))).filter(
    (record): record is RolePermissionRecord => !!record?.enabled,
  );

  if (!records.length) {
    ctx.status = 403;
    ctx.body = toOpenAIError(
      403,
      `None of the roles [${roleNames.join(', ')}] is authorized to use the AI API. ` +
        `An admin must enable access in Settings → Users & Permissions → [Role] → AI API.`,
      'permission_denied',
      'role_not_permitted',
    );
    return false;
  }

  // Store for downstream handlers (employee scoping, usage attribution).
  ctx.state.aiApiRolePermissions = records;
  return true;
}

/**
 * Check whether the current roles may use a specific AI Employee.
 * Must be called after checkRolePermission (so ctx.state.aiApiRolePermissions is set).
 *
 * Returns true when:
 * - Any enabled role has allowAllEmployees=true, or
 * - The employeeUsername appears in the union of the enabled roles' allowedEmployees lists
 */
export function checkEmployeeAccess(ctx: Context, employeeUsername: string): boolean {
  const perms = (ctx.state.aiApiRolePermissions as RolePermissionRecord[] | undefined) || [];
  return perms.some(
    (perm) => perm.allowAllEmployees || ((perm.allowedEmployees as string[]) || []).includes(employeeUsername),
  );
}
