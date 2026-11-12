// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import PluginSftpgoIntegrationServer from '../plugin';

type PluginApp = ConstructorParameters<typeof PluginSftpgoIntegrationServer>[0];
type LogRedactionContext = {
  action?: {
    actionName: string;
    params: { values?: Record<string, unknown> };
    resourceName: string;
  };
  request: { body?: Record<string, unknown> };
  body?: unknown;
};
type Middleware = (ctx: LogRedactionContext, next: () => Promise<void>) => Promise<void>;

async function loadMiddlewares(): Promise<{ log: Middleware; resource: Middleware[] }> {
  const middlewares: Middleware[] = [];
  const resourceMiddlewares: Middleware[] = [];
  const app = {
    use: vi.fn((middleware: Middleware) => middlewares.push(middleware)),
    resourceManager: {
      define: vi.fn(),
      registerActionHandlers: vi.fn(),
      use: vi.fn((middleware: Middleware) => resourceMiddlewares.push(middleware)),
    },
    acl: { registerSnippet: vi.fn() },
  };
  const plugin = new PluginSftpgoIntegrationServer(app as unknown as PluginApp);
  await plugin.load();
  const log = middlewares[0];
  if (!log) throw new Error('SFTPGo log redaction middleware was not registered');
  if (resourceMiddlewares.length !== 3) throw new Error('SFTPGo resource middleware chain was not registered');
  return { log, resource: resourceMiddlewares };
}

describe('SFTPGo connection credential log redaction', () => {
  it('redacts API keys and passwords from action params and request bodies after success', async () => {
    const { log: middleware } = await loadMiddlewares();
    const actionValues = { name: 'primary', apiKey: 'plain-api-key', password: 'plain-password' };
    const body = { name: 'primary', apiKey: 'plain-api-key', password: 'plain-password' };
    const ctx: LogRedactionContext = { request: { body } };

    await middleware(ctx, async () => {
      ctx.action = {
        resourceName: 'sftpgoConnections',
        actionName: 'create',
        params: { values: actionValues },
      };
    });

    expect(ctx.action?.params.values).toEqual({ name: 'primary', apiKey: '••••••••', password: '••••••••' });
    expect(body).toEqual({ name: 'primary', apiKey: '••••••••', password: '••••••••' });
  });

  it('redacts credentials when a downstream save fails', async () => {
    const { log: middleware } = await loadMiddlewares();
    const actionValues = { name: 'primary', apiKey: 'plain-api-key', password: 'plain-password' };
    const ctx: LogRedactionContext = {
      action: {
        resourceName: 'sftpgoConnections',
        actionName: 'update',
        params: { values: actionValues },
      },
      request: { body: { ...actionValues } },
    };
    const failure = new Error('database unavailable');

    await expect(middleware(ctx, async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(ctx.action.params.values).toEqual({ name: 'primary', apiKey: '••••••••', password: '••••••••' });
    expect(ctx.request.body).toEqual({ name: 'primary', apiKey: '••••••••', password: '••••••••' });
  });

  it.each(['firstOrCreate', 'updateOrCreate'])('redacts credentials for the %s compound action', async (actionName) => {
    const { log: middleware } = await loadMiddlewares();
    const values = { name: 'primary', apiKey: 'plain-api-key', password: 'plain-password' };
    const ctx: LogRedactionContext = {
      action: { resourceName: 'sftpgoConnections', actionName, params: { values } },
      request: { body: { ...values } },
    };

    await middleware(ctx, async () => undefined);

    expect(ctx.action?.params.values?.apiKey).toBe('••••••••');
    expect(ctx.request.body?.password).toBe('••••••••');
  });

  it('masks paginated connection rows after the collection response is wrapped, preserving metadata and the source models', async () => {
    const { resource } = await loadMiddlewares();
    const storedRow = {
      id: 10,
      name: 'primary',
      password: 'encrypted-password',
      apiKey: 'encrypted-api-key',
      toJSON: () => ({
        id: 10,
        name: 'primary',
        password: 'encrypted-password',
        apiKey: 'encrypted-api-key',
      }),
    };
    const body = {
      data: { rows: [storedRow], count: 101 },
      meta: { page: 2, pageSize: 50, count: 101 },
    };
    const ctx: LogRedactionContext = {
      action: { resourceName: 'sftpgoConnections', actionName: 'list', params: {} },
      request: {},
    };

    const runResourceChain = async (index: number): Promise<void> => {
      const middleware = resource[index];
      if (!middleware) {
        ctx.body = body;
        return;
      }
      await middleware(ctx, () => runResourceChain(index + 1));
    };
    await runResourceChain(0);

    expect(ctx.body).toEqual({
      data: {
        rows: [{ id: 10, name: 'primary', password: '••••••••', apiKey: '••••••••' }],
        count: 101,
      },
      meta: { page: 2, pageSize: 50, count: 101 },
    });
    expect(storedRow.password).toBe('encrypted-password');
    expect(storedRow.apiKey).toBe('encrypted-api-key');
  });
});
