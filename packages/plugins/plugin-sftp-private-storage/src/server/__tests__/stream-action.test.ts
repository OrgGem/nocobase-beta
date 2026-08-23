import { describe, it, expect, vi } from 'vitest';
import { PluginSftpPrivateStorageServer } from '../plugin';

function createPluginForStream(collections: Array<{ name: string; template?: string }>) {
  const warn = vi.fn();
  const collectionMap = new Map<string, any>();
  for (const c of collections) {
    collectionMap.set(c.name, {
      name: c.name,
      options: c.template ? { template: c.template } : {},
      fields: new Map(),
    });
  }

  const db: any = {
    collections: collectionMap,
    getRepository: vi.fn().mockImplementation((name: string) => ({
      collection: collectionMap.get(name),
      findOne: vi.fn().mockResolvedValue(null),
    })),
    getCollection: vi.fn().mockImplementation((name: string) => collectionMap.get(name)),
    on: vi.fn(),
  };

  const app: any = {
    pm: { get: () => null },
    environment: null,
    context: { reqId: 'test' },
    log: { warn, info: vi.fn(), error: vi.fn(), child: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
    resourceManager: { registerActionHandler: vi.fn() },
    acl: { allow: vi.fn(), registerSnippet: vi.fn(), can: vi.fn().mockReturnValue(false) },
    on: vi.fn(),
    db,
  };
  app.db = db;

  const plugin = new PluginSftpPrivateStorageServer(app, {
    name: 'plugin-sftp-private-storage',
    packageName: 'plugin-sftp-private-storage',
  });
  return { plugin, warn };
}

function createCtx(collection: string) {
  const thrown: Array<{ status: number; message: string }> = [];
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const ctx: any = {
    action: { params: { filterByTk: 1, collection } },
    request: { query: {} },
    state: { currentRoles: ['member'], currentUser: { id: 99 } },
    db: undefined, // injected per test
    logger,
    throw: (status: number, message: string) => {
      thrown.push({ status, message });
      const err = new Error(message) as Error & { status: number };
      err.status = status;
      throw err;
    },
    set: vi.fn(),
  };
  return { ctx, thrown, logger };
}

describe('streamAction collection whitelist', () => {
  it('rejects a non-file collection with 400', async () => {
    const { plugin } = createPluginForStream([
      { name: 'attachments', template: 'file' },
      { name: 'users' },
    ]);
    const { ctx, thrown } = createCtx('users');
    ctx.db = (plugin as any).app.db;

    await expect(plugin.streamAction(ctx)).rejects.toMatchObject({ status: 400 });
    expect(thrown[0].message).toBe('Invalid collection parameter');
  });

  it('accepts a file-template collection and proceeds past the whitelist', async () => {
    const { plugin } = createPluginForStream([
      { name: 'attachments', template: 'file' },
      { name: 'users' },
    ]);
    const { ctx, thrown } = createCtx('attachments');
    ctx.db = (plugin as any).app.db;

    // Record not found -> 404, which proves the whitelist let it through.
    await expect(plugin.streamAction(ctx)).rejects.toMatchObject({ status: 404 });
    expect(thrown.map((t) => t.status)).not.toContain(400);
  });

  it('does not leak filterByTk or collection name in the not-found log', async () => {
    const { plugin } = createPluginForStream([{ name: 'attachments', template: 'file' }]);
    const { ctx, logger } = createCtx('attachments');
    ctx.db = (plugin as any).app.db;

    await expect(plugin.streamAction(ctx)).rejects.toMatchObject({ status: 404 });
    const allLogs = [...logger.warn.mock.calls, ...logger.error.mock.calls].flat().join(' ');
    expect(allLogs).not.toContain('filterByTk=');
    expect(allLogs).not.toContain('collection=');
  });
});
