// SPDX-License-Identifier: Apache-2.0

import { NoPermissionError } from '@nocobase/acl';
import type { Context } from '@nocobase/actions';
import type { Filter, Model, Repository } from '@nocobase/database';

export async function loadAuthorizedConnection(
  ctx: Context,
  connectionId: unknown,
  includeActionScope = false,
): Promise<Model> {
  if (
    (typeof connectionId !== 'string' && typeof connectionId !== 'number') ||
    !String(connectionId).trim() ||
    (typeof connectionId === 'number' && (!Number.isSafeInteger(connectionId) || connectionId <= 0))
  ) {
    return ctx.throw(400, ctx.t('connectionId is required', { ns: 'plugin-sftpgo-integration' }));
  }

  if (
    typeof ctx.can !== 'function' ||
    !ctx.can({ resource: 'sftpgoConnections', action: 'get' }) ||
    typeof ctx.acl?.resolveActionParams !== 'function'
  ) {
    return ctx.throw(403, ctx.t('No permissions', { ns: 'plugin-sftpgo-integration' }));
  }

  let readFilter: Filter | undefined;
  try {
    const resolved = await ctx.acl.resolveActionParams(ctx, {
      resourceName: 'sftpgoConnections',
      actionName: 'get',
      params: {},
      useCurrentRepository: false,
    });
    readFilter = resolved.parsedParams?.filter as Filter | undefined;
  } catch (error) {
    if (error instanceof NoPermissionError) {
      return ctx.throw(403, ctx.t('No permissions', { ns: 'plugin-sftpgo-integration' }));
    }
    throw error;
  }

  const actionFilter = includeActionScope ? (ctx.permission?.parsedParams?.filter as Filter | undefined) : undefined;
  const filters = [readFilter, actionFilter].filter((value): value is Filter => value != null);
  const filter = filters.length > 1 ? { $and: filters } : filters[0];
  const repo = ctx.db.getRepository('sftpgoConnections') as Repository;
  const connection = await repo.findOne({ filterByTk: connectionId, filter, context: ctx });
  if (!connection) return ctx.throw(404, ctx.t('Connection not found', { ns: 'plugin-sftpgo-integration' }));
  return connection;
}
