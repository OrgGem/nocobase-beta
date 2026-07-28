import {
  PublicRateLimitExceededError,
  PublicRateLimiter,
  type PublicRateLimitBucket,
} from '../services/public-rate-limiter';

type Counter = {
  get(key: string): Promise<number>;
  incr(key: string, ttl: number): Promise<number>;
  incrby(key: string, value: number, ttl: number): Promise<number>;
};

function counter(overrides: Partial<Counter>): Counter {
  return {
    get: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    incrby: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function application(counter: Counter, defaultStore = 'memory') {
  return {
    cacheManager: {
      defaultStore,
      createCounter: vi.fn().mockResolvedValue(counter),
    },
  };
}

describe('PublicRateLimiter', () => {
  const originalStore = process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
  const originalSecret = process.env.SKILL_REGISTRY_RATE_LIMIT_SECRET;
  const originalPerIpConcurrency = process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_PER_IP;
  const originalGlobalConcurrency = process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_GLOBAL;
  const originalResponseTimeout = process.env.SKILL_REGISTRY_DOWNLOAD_RESPONSE_TIMEOUT_MS;
  const originalLeaseTtl = process.env.SKILL_REGISTRY_DOWNLOAD_LEASE_TTL_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:01.000Z'));
    process.env.SKILL_REGISTRY_RATE_LIMIT_SECRET = 'rate-limit-test-secret';
    delete process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
    delete process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_PER_IP;
    delete process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_GLOBAL;
    delete process.env.SKILL_REGISTRY_DOWNLOAD_RESPONSE_TIMEOUT_MS;
    delete process.env.SKILL_REGISTRY_DOWNLOAD_LEASE_TTL_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalStore === undefined) {
      delete process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
    } else {
      process.env.SKILL_REGISTRY_RATE_LIMIT_STORE = originalStore;
    }
    if (originalSecret === undefined) {
      delete process.env.SKILL_REGISTRY_RATE_LIMIT_SECRET;
    } else {
      process.env.SKILL_REGISTRY_RATE_LIMIT_SECRET = originalSecret;
    }
    if (originalPerIpConcurrency === undefined) {
      delete process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_PER_IP;
    } else {
      process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_PER_IP = originalPerIpConcurrency;
    }
    if (originalGlobalConcurrency === undefined) {
      delete process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_GLOBAL;
    } else {
      process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_GLOBAL = originalGlobalConcurrency;
    }
    if (originalResponseTimeout === undefined) {
      delete process.env.SKILL_REGISTRY_DOWNLOAD_RESPONSE_TIMEOUT_MS;
    } else {
      process.env.SKILL_REGISTRY_DOWNLOAD_RESPONSE_TIMEOUT_MS = originalResponseTimeout;
    }
    if (originalLeaseTtl === undefined) {
      delete process.env.SKILL_REGISTRY_DOWNLOAD_LEASE_TTL_MS;
    } else {
      process.env.SKILL_REGISTRY_DOWNLOAD_LEASE_TTL_MS = originalLeaseTtl;
    }
  });

  it('returns headers for the currently binding burst window', async () => {
    const values = new Map<string, number>();
    const rateCounter = counter({
      async incr(key) {
        const value = (values.get(key) || 0) + 1;
        values.set(key, value);
        return value;
      },
    });
    const limiter = await PublicRateLimiter.create(application(rateCounter));

    await expect(limiter.enforce('catalog', '198.51.100.7')).resolves.toEqual({
      limit: 20,
      remaining: 19,
      resetSeconds: 4,
    });
    expect(limiter.scope).toBe('process-local');
  });

  it.each<[PublicRateLimitBucket, number, number]>([
    ['catalog', 60, 59],
    ['detail', 120, 59],
    ['download', 30, 599],
  ])('reports the sustained %s window instead of a hard-coded burst retry', async (bucket, limit, resetSeconds) => {
    const rateCounter = counter({
      async incr(key) {
        return key.includes(':sustained:') ? limit + 1 : 1;
      },
    });
    const limiter = await PublicRateLimiter.create(application(rateCounter));

    let error: unknown;
    try {
      await limiter.enforce(bucket, '203.0.113.4');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PublicRateLimitExceededError);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      rateLimit: { limit, remaining: 0, resetSeconds },
    });
  });

  it('uses the configured or application-default shared cache store', async () => {
    const rateCounter = counter({});
    process.env.SKILL_REGISTRY_RATE_LIMIT_STORE = 'redis';
    const explicitApp = application(rateCounter);
    const explicitLimiter = await PublicRateLimiter.create(explicitApp);

    expect(explicitLimiter.scope).toBe('shared');
    expect(explicitApp.cacheManager.createCounter).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'redis' }),
      undefined,
    );

    delete process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
    const defaultApp = application(rateCounter, 'redis');
    const defaultLimiter = await PublicRateLimiter.create(defaultApp);
    expect(defaultLimiter.scope).toBe('shared');
    expect(defaultApp.cacheManager.createCounter).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'redis' }),
      undefined,
    );
  });

  it('allows at most three active downloads per IP and releases a lease once', async () => {
    const values = new Map<string, number>();
    const rateCounter = counter({
      async get(key) {
        return values.get(key) || 0;
      },
      async incrby(key, value) {
        const next = (values.get(key) || 0) + value;
        values.set(key, next);
        return next;
      },
    });
    const limiter = await PublicRateLimiter.create(application(rateCounter));
    const leases = await Promise.all([
      limiter.acquireDownloadLease('198.51.100.8'),
      limiter.acquireDownloadLease('198.51.100.8'),
      limiter.acquireDownloadLease('198.51.100.8'),
    ]);

    await expect(limiter.acquireDownloadLease('198.51.100.8')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
    });

    await leases[0].release();
    await leases[0].release();
    const replacement = await limiter.acquireDownloadLease('198.51.100.8');
    expect(replacement).toMatchObject({
      responseTimeoutMs: 300_000,
    });
    await Promise.all([leases[1].release(), leases[2].release(), replacement.release()]);
    expect(values.get('download-active:global')).toBe(0);
  });

  it('rolls back the client lease when the global download limit is already full', async () => {
    process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_PER_IP = '3';
    process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_GLOBAL = '1';
    process.env.SKILL_REGISTRY_DOWNLOAD_RESPONSE_TIMEOUT_MS = '1000';
    process.env.SKILL_REGISTRY_DOWNLOAD_LEASE_TTL_MS = '70000';
    const values = new Map<string, number>();
    const rateCounter = counter({
      async get(key) {
        return values.get(key) || 0;
      },
      async incrby(key, value) {
        const next = (values.get(key) || 0) + value;
        values.set(key, next);
        return next;
      },
    });
    const limiter = await PublicRateLimiter.create(application(rateCounter));
    const first = await limiter.acquireDownloadLease('198.51.100.10');

    await expect(limiter.acquireDownloadLease('198.51.100.11')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      rateLimit: { limit: 1, remaining: 0, resetSeconds: 1 },
    });

    const ipValues = [...values.entries()]
      .filter(([key]) => key.startsWith('download-active:ip:'))
      .map(([, value]) => value)
      .sort();
    expect(ipValues).toEqual([0, 1]);
    expect(values.get('download-active:global')).toBe(1);

    await first.release();
    const second = await limiter.acquireDownloadLease('198.51.100.11');
    await second.release();
    expect(values.get('download-active:global')).toBe(0);
  });
});
