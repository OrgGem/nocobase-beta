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
const permissionCache = new Map<string, { record: any; expiresAt: number }>();

export function invalidateRolePermissionCache(roleName?: string): void {
  if (roleName) permissionCache.delete(roleName);
  else permissionCache.clear();
}

/**
 * Check whether the authenticated role is allowed to use the AI API.
 * Loads the permission record and stores it in ctx.state.aiApiRolePermission.
 *
 * Returns true if access is allowed (caller may proceed).
 * Returns false if access is denied (403 already written to ctx, caller must return).
 *
 * The 'root' and 'admin' roles always bypass the check.
 */
export async function checkRolePermission(ctx: Context): Promise<boolean> {
  const roleName = ctx.state.currentRoles?.[0] || 'member';

  // root / admin always allowed
  if (roleName === 'root' || roleName === 'admin') {
    return true;
  }

  const cached = permissionCache.get(roleName);
  const record =
    cached && cached.expiresAt > Date.now()
      ? cached.record
      : await ctx.db.getRepository('aiApiRolePermissions').findOne({ filter: { roleName } });
  if (!cached || cached.expiresAt <= Date.now()) {
    permissionCache.set(roleName, { record, expiresAt: Date.now() + PERMISSION_TTL_MS });
  }

  if (!record?.enabled) {
    ctx.status = 403;
    ctx.body = toOpenAIError(
      403,
      `Role '${roleName}' is not authorized to use the AI API. ` +
        `An admin must enable access in Settings → Users & Permissions → [Role] → AI API.`,
      'permission_denied',
      'role_not_permitted',
    );
    return false;
  }

  // Store for downstream handlers
  ctx.state.aiApiRolePermission = record;
  return true;
}

/**
 * Check whether the current role is allowed to use a specific AI Employee.
 * Must be called after checkRolePermission (so ctx.state.aiApiRolePermission is set).
 *
 * Returns true when:
 * - Role is admin/root (no permission record stored)
 * - allowAllEmployees is true
 * - The employeeUsername is in the allowedEmployees list
 */
export function checkEmployeeAccess(ctx: Context, employeeUsername: string): boolean {
  const perm = ctx.state.aiApiRolePermission;
  // admin/root paths have no record stored → always allowed
  if (!perm) return true;
  if (perm.allowAllEmployees) return true;
  return ((perm.allowedEmployees as string[]) || []).includes(employeeUsername);
}
