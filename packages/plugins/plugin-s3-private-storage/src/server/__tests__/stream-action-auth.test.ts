import { PluginS3PrivateStorageServer } from '../plugin';

function createTestContext() {
  const thrown: Array<{ status: number; message: string }> = [];
  const ctx: any = {
    action: { params: { filterByTk: '1', mode: 'inline', collection: 'attachments' } },
    request: { query: {}, ip: '127.0.0.1' },
    state: {},
    set: () => {},
    throw: (status: number, message: string) => {
      thrown.push({ status, message });
      const err: any = new Error(message);
      err.status = status;
      err.statusCode = status;
      throw err;
    },
    logger: { warn: () => {}, error: () => {}, debug: () => {} },
    db: { getRepository: () => null, collections: new Map() },
  };
  return { ctx, thrown };
}

function createPlugin() {
  const app: any = {
    pm: { get: () => ({ registerStorageType: () => {} }) },
    resourceManager: {
      registerActionHandler: () => {},
      getResource: () => null,
    },
    acl: { allow: () => {}, can: () => ({}) },
    on: () => {},
    environment: null,
    log: {
      child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
    },
    context: { reqId: 'test' },
    db: { getRepository: () => null },
  };
  const plugin = new PluginS3PrivateStorageServer(app, {
    name: 'plugin-s3-private-storage',
    packageName: 'plugin-s3-private-storage',
  });
  return { plugin, app };
}

describe('streamAction authentication', () => {
  it('rejects with 401 when currentUser is not populated', async () => {
    const { plugin } = createPlugin();
    const { ctx, thrown } = createTestContext();
    // rateLimiter stays null so the auth check runs first
    (plugin as any).rateLimiter = null;

    try {
      await plugin.streamAction(ctx);
    } catch (e) {
      // expected throw from ctx.throw
    }

    expect(thrown.length).toBeGreaterThan(0);
    expect(thrown[0].status).toBe(401);
    expect(thrown[0].message).toBe('Unauthenticated');
  });

  it('proceeds when currentUser is present', async () => {
    const { plugin } = createPlugin();
    const { ctx, thrown } = createTestContext();
    ctx.state.currentUser = { id: 1 };
    ctx.state.currentRoles = ['member'];
    (plugin as any).rateLimiter = null;

    try {
      await plugin.streamAction(ctx);
    } catch (e) {
      // The repository is null in the mock, so this would throw 400
      // 'Invalid collection' — but NOT 401, which is what matters.
    }

    expect(thrown.length).toBeGreaterThan(0);
    // Must NOT be a 401: authentication passed, failure is downstream (400 invalid repo)
    expect(thrown[0].status).not.toBe(401);
  });
});

describe('streamAction collection validation', () => {
  function makeCtx(collection: string, repo: any = null) {
    const thrown: Array<{ status: number; message: string }> = [];
    const ctx: any = {
      action: { params: { filterByTk: '1', mode: 'inline', collection } },
      request: { query: {}, ip: '127.0.0.1' },
      state: { currentUser: { id: 1 }, currentRoles: ['member'] },
      set: () => {},
      throw: (status: number, message: string) => {
        thrown.push({ status, message });
        const err: any = new Error(message);
        err.status = status;
        throw err;
      },
      logger: { warn: () => {}, error: () => {}, debug: () => {} },
      db: { getCollection: () => null, getRepository: () => repo, collections: new Map() },
    };
    return { ctx, thrown };
  }

  it('rejects non-file collections with 400', async () => {
    const app: any = {
      pm: { get: () => ({ registerStorageType: () => {} }) },
      resourceManager: { registerActionHandler: () => {}, getResource: () => null },
      acl: { allow: () => {}, can: () => ({}) },
      on: () => {},
      environment: null,
      log: {
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
      },
      context: { reqId: 'test' },
      db: { getRepository: () => null, collections: new Map() },
    };
    const plugin = new PluginS3PrivateStorageServer(app, {
      name: 'plugin-s3-private-storage',
      packageName: 'plugin-s3-private-storage',
    });
    (plugin as any).rateLimiter = null;
    const { ctx, thrown } = makeCtx('users');
    try {
      await plugin.streamAction(ctx);
    } catch (e) {
      // expected
    }
    expect(thrown.length).toBeGreaterThan(0);
    expect(thrown[0].status).toBe(400);
  });

  it('accepts attachments/aiFiles collections', async () => {
    const app: any = {
      pm: { get: () => ({ registerStorageType: () => {} }) },
      resourceManager: { registerActionHandler: () => {}, getResource: () => null },
      acl: { allow: () => {}, can: () => ({}) },
      on: () => {},
      environment: null,
      log: {
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
      },
      context: { reqId: 'test' },
      db: { getRepository: () => null, collections: new Map() },
    };
    const plugin = new PluginS3PrivateStorageServer(app, {
      name: 'plugin-s3-private-storage',
      packageName: 'plugin-s3-private-storage',
    });
    (plugin as any).rateLimiter = null;
    for (const collection of ['attachments', 'aiFiles']) {
      const repo = { collection: { name: collection }, findOne: async () => null };
      const { ctx, thrown } = makeCtx(collection, repo);
      try {
        await plugin.streamAction(ctx);
      } catch (e) {
        // expected: record not found -> 404, NOT 400 (collection whitelist passed)
      }
      expect(thrown.length).toBeGreaterThan(0);
      expect(thrown[0].status).toBe(404);
    }
  });
});
