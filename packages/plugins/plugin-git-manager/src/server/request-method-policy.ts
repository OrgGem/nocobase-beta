/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';

const READ_ACTIONS = new Set([
  'diff',
  'status',
  'log',
  'branches',
  'fileTree',
  'fileContent',
  'commitDetail',
  'mergeRequests',
  'mergeRequestDetail',
  'mergeRequestNotes',
  'pollerStatus',
  'rolePermissions',
]);

export async function enforceGitRequestMethod(ctx: Context, next: () => Promise<void>) {
  if (ctx.action?.resourceName === 'gitManager') {
    const allowed = READ_ACTIONS.has(ctx.action.actionName) ? ['GET', 'HEAD', 'POST'] : ['POST'];
    if (!allowed.includes(ctx.method.toUpperCase())) {
      ctx.set('Allow', allowed.join(', '));
      ctx.throw(405, ctx.t('Method not allowed', { ns: 'plugin-git-manager' }));
    }
  }
  try {
    await next();
  } catch (error) {
    const securityMessages = [
      'Invalid repository or account URL',
      'Only HTTPS repository and account URLs are allowed',
      'Repository URL must match the Git account origin',
      'GitHub accounts currently require github.com',
      'Invalid local path',
      'Invalid local path: path traversal detected or path is outside the allowed base directory',
    ];
    if (
      ctx.action?.resourceName === 'gitManager' &&
      error instanceof Error &&
      securityMessages.includes(error.message)
    ) {
      ctx.throw(400, ctx.t(error.message, { ns: 'plugin-git-manager' }));
    }
    throw error;
  }
}
