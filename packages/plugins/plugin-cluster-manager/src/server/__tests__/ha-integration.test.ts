import {
  ensureRedisEventQueueAdapter,
  ensureRedisLockAdapter,
  ensureRedisPubSubAdapter,
  ensureRedisWorkerIdAllocator,
  isRedisEventQueueEnabled,
  resolveHaRedisUrls,
  type HaLogger,
} from '../ha/core-ha-integration';

const logger: HaLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('core HA integration', () => {
  it('installs the Redis worker ID allocator when core has none', () => {
    const adapter = { getWorkerId: async () => 3, release: async () => undefined };
    const allocator: { adapter?: unknown; setAdapter: (value: unknown) => void } = {
      setAdapter(value) {
        allocator.adapter = value;
      },
    };

    const result = ensureRedisWorkerIdAllocator({
      allocator,
      url: 'redis://test',
      logger,
      createAdapter: () => adapter,
    });

    expect(result.outcome).toBe('installed');
    expect(allocator.adapter).toBe(adapter);
  });

  it('never overwrites a worker ID allocator registered by someone else', () => {
    const existing = { getWorkerId: async () => 7, release: async () => undefined };
    const allocator = { adapter: existing, setAdapter: vi.fn() };

    const result = ensureRedisWorkerIdAllocator({
      allocator,
      url: 'redis://test',
      logger,
      createAdapter: () => ({ getWorkerId: async () => 0, release: async () => undefined }),
    });

    expect(result.outcome).toBe('already-registered');
    expect(allocator.setAdapter).not.toHaveBeenCalled();
    expect(allocator.adapter).toBe(existing);
  });

  it('preserves an existing PubSub adapter', () => {
    const existing = { isConnected: () => true };
    const pubSubManager = { adapter: existing, setAdapter: vi.fn() };

    const result = ensureRedisPubSubAdapter({
      pubSubManager,
      url: 'redis://test',
      logger,
      createAdapter: () => ({ isConnected: () => true }),
    });

    expect(result.outcome).toBe('already-registered');
    expect(pubSubManager.setAdapter).not.toHaveBeenCalled();
  });

  it('replaces only the in-memory event queue adapter', async () => {
    class MemoryEventQueueAdapter {}
    const memory = new MemoryEventQueueAdapter();
    const replacement = { isConnected: () => true, connect: async () => undefined, close: async () => undefined };
    const eventQueue: { adapter: unknown; setAdapter: (value: unknown) => void; isConnected: () => boolean } = {
      adapter: memory,
      setAdapter(value) {
        eventQueue.adapter = value;
      },
      isConnected: () => false,
    };

    const result = await ensureRedisEventQueueAdapter({
      eventQueue,
      enabled: true,
      url: 'redis://test',
      logger,
      createAdapter: () => replacement,
    });

    expect(result.outcome).toBe('installed');
    expect(eventQueue.adapter).toBe(replacement);
  });

  it('leaves a persistent event queue adapter untouched', async () => {
    class RedisEventQueueAdapter {}
    const existing = new RedisEventQueueAdapter();
    const eventQueue = { adapter: existing, setAdapter: vi.fn() };

    const result = await ensureRedisEventQueueAdapter({
      eventQueue,
      enabled: true,
      url: 'redis://test',
      logger,
      createAdapter: () => ({ isConnected: () => true }),
    });

    expect(result.outcome).toBe('already-registered');
    expect(eventQueue.setAdapter).not.toHaveBeenCalled();
    expect(eventQueue.adapter).toBe(existing);
  });

  it('registers the Redis lock adapter only when core has none', () => {
    const register = vi.fn();
    const lockManager = {
      registry: {
        get: () => undefined,
        register,
      },
    };
    class Adapter {}

    const result = ensureRedisLockAdapter({
      lockManager,
      url: 'redis://test',
      logger,
      adapterConfig: { Adapter, options: { app: {} } },
    });

    expect(result.outcome).toBe('installed');
    expect(register).toHaveBeenCalledWith('redis', {
      Adapter,
      options: { app: {}, url: 'redis://test' },
    });
  });

  it('keeps a pre-registered Redis lock adapter', () => {
    class ExistingAdapter {}
    const register = vi.fn();
    const lockManager = {
      registry: {
        get: () => ExistingAdapter,
        register,
      },
    };

    const result = ensureRedisLockAdapter({
      lockManager,
      url: 'redis://test',
      logger,
      adapterConfig: { Adapter: class {}, options: {} },
    });

    expect(result.outcome).toBe('already-registered');
    expect(register).not.toHaveBeenCalled();
  });

  it('reports a disabled outcome when no Redis URL is configured', () => {
    const result = ensureRedisWorkerIdAllocator({
      allocator: { setAdapter: vi.fn() },
      url: '',
      logger,
      createAdapter: () => ({}),
    });

    expect(result.outcome).toBe('disabled');
  });

  it('falls back to REDIS_URL for every component', () => {
    const previous = { ...process.env };
    try {
      process.env.REDIS_URL = 'redis://fallback';
      delete process.env.WORKER_ID_REDIS_URL;
      delete process.env.PUBSUB_ADAPTER_REDIS_URL;
      delete process.env.QUEUE_ADAPTER_REDIS_URL;
      delete process.env.LOCK_ADAPTER_REDIS_URL;

      expect(resolveHaRedisUrls()).toEqual({
        workerId: 'redis://fallback',
        pubSub: 'redis://fallback',
        eventQueue: 'redis://fallback',
        lock: 'redis://fallback',
      });
    } finally {
      process.env = previous;
    }
  });

  it('detects the Redis queue opt-in from either signal', () => {
    const previous = { ...process.env };
    try {
      delete process.env.QUEUE_ADAPTER;
      delete process.env.QUEUE_ADAPTER_REDIS_URL;
      expect(isRedisEventQueueEnabled()).toBe(false);

      process.env.QUEUE_ADAPTER = 'redis';
      expect(isRedisEventQueueEnabled()).toBe(true);

      delete process.env.QUEUE_ADAPTER;
      process.env.QUEUE_ADAPTER_REDIS_URL = 'redis://queue';
      expect(isRedisEventQueueEnabled()).toBe(true);
    } finally {
      process.env = previous;
    }
  });

  it('does not touch the event queue when the Redis opt-in is absent', async () => {
    const eventQueue = { adapter: {}, setAdapter: vi.fn() };

    const result = await ensureRedisEventQueueAdapter({
      eventQueue,
      enabled: false,
      url: 'redis://test',
      logger,
      createAdapter: () => ({}),
    });

    expect(result.outcome).toBe('disabled');
    expect(eventQueue.setAdapter).not.toHaveBeenCalled();
  });
});
