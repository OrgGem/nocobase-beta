import { getStreamRateLimitConfigFromEnv, SlidingWindowRateLimiter } from '../rate-limit';
import { PluginS3PrivateStorageServer } from '../plugin';

describe('Rate limiter config integration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('getStreamRateLimitConfigFromEnv reads enabled=false and slimer is not created when disabled', () => {
    process.env.S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED = 'false';
    const config = getStreamRateLimitConfigFromEnv();
    expect(config.enabled).toBe(false);
  });

  it('getStreamRateLimitConfigFromEnv reads enabled=true by default', () => {
    delete process.env.S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED;
    const config = getStreamRateLimitConfigFromEnv();
    expect(config.enabled).toBe(true);
  });

  it('SlidingWindowRateLimiter constructor uses max and windowMs from config', () => {
    const config = getStreamRateLimitConfigFromEnv({
      S3_PRIVATE_STREAM_RATE_LIMIT_MAX: '5',
      S3_PRIVATE_STREAM_RATE_LIMIT_WINDOW_MS: '1000',
    });
    const limiter = new SlidingWindowRateLimiter({ max: config.max, windowMs: config.windowMs });
    // max=5 per 1000ms: 5 allowed, 6th rejected
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('k', 100 * i).allowed).toBe(true);
    }
    expect(limiter.check('k', 500).allowed).toBe(false);
    limiter.dispose();
  });

  it('SlidingWindowRateLimiter constructor throws on invalid config', () => {
    expect(() => new SlidingWindowRateLimiter({ max: 0, windowMs: 1000 })).toThrow();
    expect(() => new SlidingWindowRateLimiter({ max: 5, windowMs: 0 })).toThrow();
  });
});
describe('PluginS3PrivateStorageServer.load() rate limiter guard', () => {
  const originalEnv = { ...process.env };

  function createPlugin() {
    const app: any = {
      pm: { get: () => ({ registerStorageType: () => {} }) },
      resourceManager: {
        registerActionHandler: () => {},
        getResource: () => null,
      },
      acl: { allow: () => {} },
      on: () => {},
      environment: null,
      log: {
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
      },
      context: { reqId: 'test' },
    };

    const plugin = new PluginS3PrivateStorageServer(app, {
      name: 'plugin-s3-private-storage',
      packageName: 'plugin-s3-private-storage',
    });
    return { plugin, app };
  }

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates the limiter when enabled by default', async () => {
    delete process.env.S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED;
    const { plugin } = createPlugin();
    await plugin.load();
    const limiter = (plugin as any).rateLimiter;
    expect(limiter).not.toBeNull();
    limiter?.dispose();
  });

  it('keeps rateLimiter null when S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED=false', async () => {
    process.env.S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED = 'false';
    const { plugin } = createPlugin();
    await plugin.load();
    expect((plugin as any).rateLimiter).toBeNull();
  });

  it('applies configured max/windowMs to the limiter', async () => {
    process.env.S3_PRIVATE_STREAM_RATE_LIMIT_MAX = '3';
    process.env.S3_PRIVATE_STREAM_RATE_LIMIT_WINDOW_MS = '2000';
    const { plugin } = createPlugin();
    await plugin.load();
    const limiter = (plugin as any).rateLimiter;
    expect(limiter).not.toBeNull();
    expect(limiter.check('u').allowed).toBe(true);
    expect(limiter.check('u').allowed).toBe(true);
    expect(limiter.check('u').allowed).toBe(true);
    expect(limiter.check('u').allowed).toBe(false);
    limiter?.dispose();
  });
});
describe('PluginS3PrivateStorageServer.afterAdd()', () => {
  it('throws when file-manager plugin is missing', async () => {
    const app: any = {
      pm: { get: () => null },
      log: {
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
      },
      context: { reqId: 'test' },
    };
    const plugin = new PluginS3PrivateStorageServer(app, {
      name: 'plugin-s3-private-storage',
      packageName: 'plugin-s3-private-storage',
    });
    await expect(plugin.afterAdd()).rejects.toThrow('@nocobase/plugin-file-manager is required');
  });

  it('resolves when file-manager plugin exists (either name)', async () => {
    for (const name of ['file-manager', '@nocobase/plugin-file-manager']) {
      const app: any = {
        pm: { get: (n: string) => (n === name ? {} : null) },
        log: {
          child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
        },
        context: { reqId: 'test' },
      };
      const plugin = new PluginS3PrivateStorageServer(app, {
        name: 'plugin-s3-private-storage',
        packageName: 'plugin-s3-private-storage',
      });
      await expect(plugin.afterAdd()).resolves.toBeUndefined();
    }
  });
});
