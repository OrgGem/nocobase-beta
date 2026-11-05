/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';

export interface BrowserAccess {
  userId: number;
  isAdmin: boolean;
}

export function getBrowserAccess(ctx: Context): BrowserAccess {
  const userId = Number(ctx.state?.currentUser?.id || ctx.auth?.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw Object.assign(new Error(ctx.t('Browser session access denied.', { ns: 'plugin-ai-browser' })), {
      status: 403,
    });
  }
  const roles = ctx.state?.currentRoles?.length ? ctx.state.currentRoles : [ctx.state?.currentRole];
  return {
    userId,
    isAdmin: Boolean(ctx.app.acl.can({ roles, resource: 'aiBrowser', action: 'setConfig' })),
  };
}

export function browserOwnerFilter(access: BrowserAccess): { ownerId?: number } {
  // Reject missing identity even when a caller bypasses the HTTP authentication middleware.
  if (!access || !Number.isSafeInteger(access.userId) || access.userId <= 0) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }
  return access.isAdmin ? {} : { ownerId: access.userId };
}
