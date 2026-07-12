import type { Context, Next } from '@nocobase/actions';
import type { Repository } from '@nocobase/database';
import { toSafeErrorMessage } from '../utils/redact';
import type PluginSftpgoIntegrationServer from '../plugin';

export function createTestConnectionAction(plugin: PluginSftpgoIntegrationServer) {
  return async (ctx: Context, next: Next) => {
    const { filterByTk } = ctx.action.params as { filterByTk?: number | string };
    if (!filterByTk) {
      return ctx.throw(400, 'filterByTk is required');
    }
    const repo = ctx.db.getRepository('sftpgoConnections') as Repository;
    const connection = await repo.findOne({ filterByTk });
    if (!connection) {
      return ctx.throw(404, 'Connection not found');
    }
    try {
      const client = await plugin.getClient(connection);
      await client.healthCheck();
      await client.verifyAuth();
      await connection.update({ lastCheckAt: new Date(), lastError: null }, { hooks: false });
      ctx.body = { success: true };
    } catch (err) {
      const message = toSafeErrorMessage(err);
      await connection.update({ lastCheckAt: new Date(), lastError: message }, { hooks: false });
      return ctx.throw(502, message);
    }
    return next();
  };
}
