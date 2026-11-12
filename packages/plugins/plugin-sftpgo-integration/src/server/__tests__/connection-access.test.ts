// SPDX-License-Identifier: Apache-2.0

import { ACL, NoPermissionError } from '@nocobase/acl';
import type { Context, Next } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import { describe, expect, it, vi } from 'vitest';
import type PluginSftpgoIntegrationServer from '../plugin';
import { createTestConnectionAction } from '../actions/sftpgo-connections';
import { createSftpgoProxyActions } from '../actions/sftpgo-proxy';
import type { SftpgoClient } from '../sftpgo-client';

type ConnectionRow = Record<string, unknown> & { id: number };

interface ContextOptions {
  hasReadGrant?: boolean;
  readFilter?: Record<string, unknown>;
  actionFilter?: Record<string, unknown>;
  row?: ConnectionRow | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesFilter(row: ConnectionRow, filter: unknown): boolean {
  if (!isRecord(filter)) return true;
  if (Array.isArray(filter.$and)) return filter.$and.every((item: unknown) => matchesFilter(row, item));
  return Object.entries(filter).every(([field, value]) => field.startsWith('$') || row[field] === value);
}

async function createContext(params: Record<string, unknown>, options: ContextOptions = {}) {
  const acl = new ACL();
  acl.setAvailableAction('view', { aliases: ['get', 'list'] });
  const actions: Record<string, { filter?: Record<string, unknown> }> = {};
  if (options.hasReadGrant !== false) {
    actions['sftpgoConnections:view'] = options.readFilter ? { filter: options.readFilter } : {};
  }
  if (options.actionFilter) {
    actions['sftpgoConnections:testConnection'] = { filter: options.actionFilter };
  }
  acl.define({ role: 'operator', actions });

  const row: ConnectionRow | null =
    options.row === undefined ? { id: 1, enabled: true, authMethod: 'admin', ownerId: 7, region: 'east' } : options.row;
  const connection = row
    ? ({
        get: (field: string) => row[field],
        update: vi.fn().mockResolvedValue(undefined),
      } as unknown as Model)
    : null;
  const repository = {
    findOne: vi.fn(async (query: Record<string, unknown>) => {
      if (!connection || !row || String(query.filterByTk) !== String(row.id)) return null;
      return matchesFilter(row, query.filter) ? connection : null;
    }),
  };
  const state = { currentRole: 'operator', currentUser: { id: 7 } };
  const contextObject: Record<string, unknown> = {
    action: { resourceName: 'sftpgoUsers', actionName: 'list', params },
    state,
    db: { getRepository: vi.fn(() => repository) },
    can: vi.fn((request: { resource: string; action: string }) =>
      acl.can({ roles: ['operator'], resource: request.resource, action: request.action }),
    ),
    acl,
    permission: {},
    t: (value: string) => value,
    throw: (status: number, message: string) => {
      throw Object.assign(new Error(message), { status });
    },
  };

  if (options.actionFilter) {
    const actionPermission = await acl.resolveActionParams(contextObject, {
      resourceName: 'sftpgoConnections',
      actionName: 'testConnection',
      params: {},
      useCurrentRepository: false,
    });
    contextObject.permission = { parsedParams: actionPermission.parsedParams };
  }

  return { ctx: contextObject as unknown as Context, acl, repository, connection };
}

function createPlugin(client: Partial<SftpgoClient>): PluginSftpgoIntegrationServer {
  return {
    getClient: vi.fn().mockResolvedValue(client),
  } as unknown as PluginSftpgoIntegrationServer;
}

const next: Next = vi.fn(async () => undefined);
const proxyActions = ['list', 'get', 'create', 'update', 'destroy'] as const;

function paramsFor(actionName: (typeof proxyActions)[number]) {
  return {
    connectionId: 1,
    filterByTk: 'remote-user',
    values: { username: 'remote-user' },
    ...(actionName === 'list' ? { limit: 20, offset: 0 } : {}),
  };
}

describe('SFTPGo connection row authorization', () => {
  it.each(proxyActions)('denies %s when the caller has no get permission', async (actionName) => {
    const client = {
      listResources: vi.fn(),
      getResource: vi.fn(),
      createResource: vi.fn(),
      updateResource: vi.fn(),
      deleteResource: vi.fn(),
    };
    const plugin = createPlugin(client);
    const { ctx } = await createContext(paramsFor(actionName), { hasReadGrant: false });

    await expect(createSftpgoProxyActions(plugin, 'users')[actionName](ctx, next)).rejects.toMatchObject({
      status: 403,
      message: 'No permissions',
    });
    expect(plugin.getClient).not.toHaveBeenCalled();
    expect(client.listResources).not.toHaveBeenCalled();
    expect(client.getResource).not.toHaveBeenCalled();
    expect(client.createResource).not.toHaveBeenCalled();
    expect(client.updateResource).not.toHaveBeenCalled();
    expect(client.deleteResource).not.toHaveBeenCalled();
  });

  it.each(proxyActions)('hides an out-of-scope connection from %s', async (actionName) => {
    const client = {
      listResources: vi.fn(),
      getResource: vi.fn(),
      createResource: vi.fn(),
      updateResource: vi.fn(),
      deleteResource: vi.fn(),
    };
    const plugin = createPlugin(client);
    const { ctx, repository } = await createContext(paramsFor(actionName), {
      readFilter: { ownerId: '{{ ctx.state.currentUser.id }}' },
      row: { id: 1, enabled: true, authMethod: 'admin', ownerId: 99, region: 'east' },
    });

    await expect(createSftpgoProxyActions(plugin, 'users')[actionName](ctx, next)).rejects.toMatchObject({
      status: 404,
      message: 'Connection not found',
    });
    expect(repository.findOne).toHaveBeenCalledWith({
      filterByTk: 1,
      filter: { ownerId: 7 },
      context: ctx,
    });
    expect(plugin.getClient).not.toHaveBeenCalled();
    expect(client.listResources).not.toHaveBeenCalled();
    expect(client.getResource).not.toHaveBeenCalled();
    expect(client.createResource).not.toHaveBeenCalled();
    expect(client.updateResource).not.toHaveBeenCalled();
    expect(client.deleteResource).not.toHaveBeenCalled();
  });

  it.each(proxyActions)('permits %s for a visible connection with a dynamic get filter', async (actionName) => {
    const client = {
      listResources: vi.fn().mockResolvedValue([]),
      getResource: vi.fn().mockResolvedValue({ username: 'remote-user' }),
      createResource: vi.fn().mockResolvedValue({ username: 'remote-user' }),
      updateResource: vi.fn().mockResolvedValue({ username: 'remote-user' }),
      deleteResource: vi.fn().mockResolvedValue(undefined),
    };
    const plugin = createPlugin(client);
    const { ctx, repository } = await createContext(paramsFor(actionName), {
      readFilter: { ownerId: '{{ ctx.state.currentUser.id }}' },
    });

    await createSftpgoProxyActions(plugin, 'users')[actionName](ctx, next);

    expect(repository.findOne).toHaveBeenCalledWith({
      filterByTk: 1,
      filter: { ownerId: 7 },
      context: ctx,
    });
    expect(plugin.getClient).toHaveBeenCalledTimes(1);
    if (actionName === 'list') expect(client.listResources).toHaveBeenCalledTimes(1);
    if (actionName === 'get') expect(client.getResource).toHaveBeenCalledTimes(1);
    if (actionName === 'create') expect(client.createResource).toHaveBeenCalledTimes(1);
    if (actionName === 'update') expect(client.updateResource).toHaveBeenCalledTimes(1);
    if (actionName === 'destroy') expect(client.deleteResource).toHaveBeenCalledTimes(1);
  });

  it('permits an unscoped get grant for an existing connection', async () => {
    const client = { listResources: vi.fn().mockResolvedValue([]) };
    const plugin = createPlugin(client);
    const { ctx, repository } = await createContext(paramsFor('list'));

    await createSftpgoProxyActions(plugin, 'users').list(ctx, next);

    expect(repository.findOne).toHaveBeenCalledWith({ filterByTk: 1, filter: undefined, context: ctx });
    expect(plugin.getClient).toHaveBeenCalledTimes(1);
    expect(client.listResources).toHaveBeenCalledTimes(1);
  });

  it('requires get permission before testConnection creates a client', async () => {
    const client = { healthCheck: vi.fn(), verifyAuth: vi.fn() };
    const plugin = createPlugin(client);
    const { ctx } = await createContext({ filterByTk: 1 }, { hasReadGrant: false });
    ctx.action.resourceName = 'sftpgoConnections';
    ctx.action.actionName = 'testConnection';

    await expect(createTestConnectionAction(plugin)(ctx, next)).rejects.toMatchObject({ status: 403 });
    expect(plugin.getClient).not.toHaveBeenCalled();
    expect(client.healthCheck).not.toHaveBeenCalled();
    expect(client.verifyAuth).not.toHaveBeenCalled();
  });

  it('intersects testConnection scope with the dynamic get filter before client creation', async () => {
    const client = { healthCheck: vi.fn(), verifyAuth: vi.fn() };
    const plugin = createPlugin(client);
    const { ctx, repository } = await createContext(
      { filterByTk: 1 },
      {
        readFilter: { ownerId: '{{ ctx.state.currentUser.id }}' },
        actionFilter: { region: 'west' },
      },
    );
    ctx.action.resourceName = 'sftpgoConnections';
    ctx.action.actionName = 'testConnection';

    await expect(createTestConnectionAction(plugin)(ctx, next)).rejects.toMatchObject({ status: 404 });
    expect(repository.findOne).toHaveBeenCalledWith({
      filterByTk: 1,
      filter: { $and: [{ ownerId: 7 }, { region: 'west' }] },
      context: ctx,
    });
    expect(plugin.getClient).not.toHaveBeenCalled();
    expect(client.healthCheck).not.toHaveBeenCalled();
    expect(client.verifyAuth).not.toHaveBeenCalled();
  });

  it('runs testConnection when the row matches both read and action scopes', async () => {
    const client = {
      healthCheck: vi.fn().mockResolvedValue({}),
      verifyAuth: vi.fn().mockResolvedValue(undefined),
    };
    const plugin = createPlugin(client);
    const { ctx, connection } = await createContext(
      { filterByTk: 1 },
      {
        readFilter: { ownerId: '{{ ctx.state.currentUser.id }}' },
        actionFilter: { region: 'east' },
      },
    );
    ctx.action.resourceName = 'sftpgoConnections';
    ctx.action.actionName = 'testConnection';

    await createTestConnectionAction(plugin)(ctx, next);

    expect(plugin.getClient).toHaveBeenCalledTimes(1);
    expect(client.healthCheck).toHaveBeenCalledTimes(1);
    expect(client.verifyAuth).toHaveBeenCalledTimes(1);
    expect(connection?.update).toHaveBeenCalledWith(expect.objectContaining({ lastError: null }), { hooks: false });
  });

  it('uses the core no-permission error for missing read grants', async () => {
    const acl = new ACL();
    await expect(
      acl.resolveActionParams(
        { state: { currentRole: 'operator' } },
        { resourceName: 'sftpgoConnections', actionName: 'get', params: {}, useCurrentRepository: false },
      ),
    ).rejects.toBeInstanceOf(NoPermissionError);
  });
});
