import { Context } from '@nocobase/actions';
import { scanKeys } from '../utils/redis';

const REDIS_QUEUE_CONNECTION = 'cluster-manager:queue-monitor';
const REDIS_QUEUE_PATTERNS = ['*:plugin-git-manager:review:queue', '*:plugin-build-guide-block:build:queue'];

function getQueueRedisUrl() {
  return process.env.QUEUE_ADAPTER_REDIS_URL || process.env.REDIS_URL;
}

async function getQueueRedis(ctx: Context) {
  const url = getQueueRedisUrl();
  const manager = (ctx.app as any).redisConnectionManager;
  if (!url || !manager?.getConnectionSync) {
    return null;
  }
  return manager.getConnectionSync(REDIS_QUEUE_CONNECTION, { connectionString: url });
}

function knownRedisQueueKeys(ctx: Context) {
  const appName = (ctx.app as any).name || process.env.APP_NAME || 'main';
  return [`${appName}:plugin-git-manager:review:queue`, `${appName}:plugin-build-guide-block:build:queue`];
}

function isKnownRedisQueueKey(key: string) {
  return REDIS_QUEUE_PATTERNS.some((pattern) => {
    const suffix = pattern.replace('*:', '');
    return key === suffix || key.endsWith(`:${suffix}`);
  });
}

function describeRedisQueueKey(key: string) {
  const parts = String(key).split(':');
  const queue = parts[parts.length - 2] || key;
  const plugin = parts[parts.length - 3] || 'unknown';
  const appName = parts.slice(0, Math.max(1, parts.length - 3)).join(':') || 'main';
  return {
    appName,
    plugin,
    queue,
    channel: `${plugin}.${queue}`,
  };
}

async function getRedisQueues(ctx: Context) {
  const redis = await getQueueRedis(ctx);
  if (!redis) {
    return {
      connected: false,
      urlConfigured: Boolean(getQueueRedisUrl()),
      queues: [],
      note: 'Redis queue connection is not configured',
    };
  }

  const keys = new Set<string>(knownRedisQueueKeys(ctx));
  for (const pattern of REDIS_QUEUE_PATTERNS) {
    try {
      const scanned = await scanKeys(redis, pattern, 200);
      scanned.forEach((key) => keys.add(key));
    } catch {
      // Keep known keys even if SCAN is not available.
    }
  }

  const queues = [];
  for (const key of keys) {
    if (!isKnownRedisQueueKey(key)) continue;
    let pending = 0;
    try {
      pending = Number(await redis.sendCommand(['LLEN', key])) || 0;
    } catch {
      pending = 0;
    }
    queues.push({
      source: 'redis',
      key,
      type: 'list',
      pending,
      ...describeRedisQueueKey(key),
    });
  }

  return {
    connected: true,
    urlConfigured: true,
    queues,
    totalPending: queues.reduce((sum, queue) => sum + (queue.pending || 0), 0),
  };
}

function parseRedisQueueMessage(raw: string, key: string, index: number) {
  let content: any = raw;
  try {
    content = JSON.parse(raw);
  } catch {
    // Keep the raw string for non-JSON messages.
  }
  const queuedAt = content?.queuedAt ? Date.parse(content.queuedAt) : null;
  return {
    id: `${key}:${index}`,
    index,
    content,
    raw,
    timestamp: Number.isFinite(queuedAt) ? queuedAt : null,
  };
}

export const eventQueueActions = {
  /**
   * GET /clusterManagerQueue:stats
   * Returns event queue statistics
   */
  async stats(ctx: Context, next: () => Promise<void>) {
    const eq = ctx.app.eventQueue;
    if (!eq) {
      ctx.throw(503, 'Event queue is not available');
    }

    const adapter = (eq as any).adapter;
    const events = (eq as any).events as Map<string, any>;
    const adapterName = adapter?.constructor?.name || 'unknown';
    const connected = eq.isConnected();

    const channels: any[] = [];
    if (events) {
      for (const [channel, opts] of events.entries()) {
        const queueData: any = { channel };
        queueData.concurrency = opts.concurrency || 1;
        queueData.interval = opts.interval || 250;

        // For MemoryEventQueueAdapter, we can peek at queue depth
        if (adapter?.queues) {
          const fullChannel = eq.getFullChannel(channel, opts.shared);
          const queue = adapter.queues.get(fullChannel);
          queueData.pending = queue?.length || 0;
        } else {
          queueData.pending = null; // Unknown for external adapters
        }

        channels.push(queueData);
      }
    }

    const totalPending = channels.reduce((sum, c) => sum + (c.pending || 0), 0);
    const redisQueues = await getRedisQueues(ctx);

    ctx.body = {
      adapter: adapterName,
      connected,
      totalChannels: channels.length,
      totalPending,
      redisQueues,
      channels,
    };
    await next();
  },

  /**
   * GET /clusterManagerQueue:messages
   * List pending messages in a specific channel (memory adapter only)
   */
  async messages(ctx: Context, next: () => Promise<void>) {
    const eq = ctx.app.eventQueue;
    if (!eq) {
      ctx.throw(503, 'Event queue is not available');
    }

    const { channel, key, source, page = 1, pageSize = 20 } = ctx.action.params;
    if (source === 'redis') {
      const redisKey = String(key || channel || '');
      if (!redisKey || !isKnownRedisQueueKey(redisKey)) {
        ctx.throw(400, 'Invalid Redis queue key');
      }

      const redis = await getQueueRedis(ctx);
      if (!redis) {
        ctx.body = {
          data: [],
          meta: { count: 0, page: 1, pageSize: 20, note: 'Redis queue connection is not configured' },
        };
        await next();
        return;
      }

      const currentPage = Number(page);
      const currentPageSize = Number(pageSize);
      const start = (currentPage - 1) * currentPageSize;
      const end = start + currentPageSize - 1;
      const count = Number(await redis.sendCommand(['LLEN', redisKey])) || 0;
      const rows = (await redis.sendCommand(['LRANGE', redisKey, String(start), String(end)])) as string[];

      ctx.body = {
        data: rows.map((raw, offset) => parseRedisQueueMessage(raw, redisKey, start + offset)),
        meta: { count, page: currentPage, pageSize: currentPageSize, source: 'redis', key: redisKey },
      };
      await next();
      return;
    }

    const adapter = (eq as any).adapter;

    if (!adapter?.queues) {
      ctx.body = {
        data: [],
        meta: { count: 0, page: 1, pageSize: 20, note: 'Message inspection not available for this adapter' },
      };
      await next();
      return;
    }

    const events = (eq as any).events as Map<string, any>;
    let fullChannel = channel;
    if (events?.has(channel)) {
      fullChannel = eq.getFullChannel(channel, events.get(channel)?.shared);
    }

    const queue = adapter.queues.get(fullChannel) || [];
    const start = (Number(page) - 1) * Number(pageSize);
    const slice = queue.slice(start, start + Number(pageSize));

    ctx.body = {
      data: slice.map((msg: any) => ({
        id: msg.id,
        content: msg.content,
        timestamp: msg.options?.timestamp,
        retried: msg.options?.retried || 0,
        maxRetries: msg.options?.maxRetries || 0,
      })),
      meta: { count: queue.length, page: Number(page), pageSize: Number(pageSize) },
    };
    await next();
  },
};
