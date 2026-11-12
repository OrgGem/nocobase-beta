// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import { toSafeErrorMessage } from '../utils/redact';
import type PluginSftpgoIntegrationServer from '../plugin';
import { SftpgoEnvironmentPermissionError } from '../utils/environment-permission';
import { loadAuthorizedConnection } from '../utils/load-authorized-connection';

export function createTestConnectionAction(plugin: PluginSftpgoIntegrationServer) {
  return async (ctx: Context, next: Next) => {
    const { filterByTk } = ctx.action.params as { filterByTk?: number | string };
    if (!filterByTk) {
      return ctx.throw(400, 'filterByTk is required');
    }
    const connection = await loadAuthorizedConnection(ctx, filterByTk, true);
    try {
      const client = await plugin.getClient(connection, ctx);
      await client.healthCheck();
      await client.verifyAuth();
      await connection.update({ lastCheckAt: new Date(), lastError: null }, { hooks: false });
      ctx.body = { success: true };
    } catch (err) {
      if (err instanceof SftpgoEnvironmentPermissionError) throw err;
      const message = toSafeErrorMessage(err);
      await connection.update({ lastCheckAt: new Date(), lastError: message }, { hooks: false });
      return ctx.throw(502, message);
    }
    return next();
  };
}
