import { Context } from '@nocobase/actions';
import { getRedisOrThrow } from '../utils/redis';
import { redactText } from './doctor';

function parseRedisInfo(raw: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = 'default';

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      current = trimmed.replace(/^#\s*/, '').toLowerCase();
      sections[current] = sections[current] || {};
      continue;
    }
    const idx = trimmed.indexOf(':');
    if (idx > 0) {
      sections[current] = sections[current] || {};
      sections[current][trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  return sections;
}


export const redisActions = {
  async info(ctx: Context, next: () => Promise<void>) {
    const redis = getRedisOrThrow(ctx);
    const raw = await redis.info();
    const parsed = parseRedisInfo(raw);

    const server = parsed.server || {};
    const memory = parsed.memory || {};
    const stats = parsed.stats || {};
    const clients = parsed.clients || {};
    const keyspace = parsed.keyspace || {};

    // Parse keyspace: db0 = "keys=123,expires=45,avg_ttl=67890"
    const databases: Record<string, Record<string, string>> = {};
    for (const [db, val] of Object.entries(keyspace)) {
      const entries: Record<string, string> = {};
      for (const part of val.split(',')) {
        const [k, v] = part.split('=');
        if (k && v) entries[k] = v;
      }
      databases[db] = entries;
    }

    ctx.body = {
      server: {
        version: server.redis_version,
        uptime_seconds: Number(server.uptime_in_seconds || 0),
        uptime_days: Number(server.uptime_in_days || 0),
        process_id: server.process_id,
        tcp_port: server.tcp_port,
      },
      memory: {
        used: memory.used_memory_human,
        used_bytes: Number(memory.used_memory || 0),
        peak: memory.used_memory_peak_human,
        peak_bytes: Number(memory.used_memory_peak || 0),
        fragmentation_ratio: Number(memory.mem_fragmentation_ratio || 0),
        max_memory: memory.maxmemory_human || 'unlimited',
        max_memory_policy: memory.maxmemory_policy,
      },
      clients: {
        connected: Number(clients.connected_clients || 0),
        blocked: Number(clients.blocked_clients || 0),
        max_clients: Number(clients.maxclients || 0),
      },
      stats: {
        ops_per_sec: Number(stats.instantaneous_ops_per_sec || 0),
        total_commands: Number(stats.total_commands_processed || 0),
        total_connections: Number(stats.total_connections_received || 0),
        keyspace_hits: Number(stats.keyspace_hits || 0),
        keyspace_misses: Number(stats.keyspace_misses || 0),
        hit_rate: (() => {
          const hits = Number(stats.keyspace_hits || 0);
          const misses = Number(stats.keyspace_misses || 0);
          const total = hits + misses;
          return total > 0 ? Math.round((hits / total) * 10000) / 100 : 0;
        })(),
        expired_keys: Number(stats.expired_keys || 0),
        evicted_keys: Number(stats.evicted_keys || 0),
      },
      keyspace: databases,
    };
    await next();
  },

  async clients(ctx: Context, next: () => Promise<void>) {
    const redis = getRedisOrThrow(ctx);
    const raw = await redis.sendCommand(['CLIENT', 'LIST']);

    const clients = String(raw)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry: Record<string, string> = {};
        for (const part of line.split(' ')) {
          const idx = part.indexOf('=');
          if (idx > 0) {
            entry[part.slice(0, idx)] = part.slice(idx + 1);
          }
        }
        return entry;
      });

    ctx.body = { data: clients, meta: { count: clients.length } };
    await next();
  },

  async pubsub(ctx: Context, next: () => Promise<void>) {
    const redis = getRedisOrThrow(ctx);

    const channels = (await redis.sendCommand(['PUBSUB', 'CHANNELS'])) as string[];

    const channelStats: Record<string, number> = {};
    if (channels.length > 0) {
      const result = (await redis.sendCommand(['PUBSUB', 'NUMSUB', ...channels])) as string[];
      for (let i = 0; i < result.length; i += 2) {
        channelStats[result[i]] = Number(result[i + 1] || 0);
      }
    }

    ctx.body = {
      channels: channelStats,
      total_channels: channels.length,
    };
    await next();
  },

  async slowlog(ctx: Context, next: () => Promise<void>) {
    const redis = getRedisOrThrow(ctx);
    const { count = 20 } = ctx.action.params;

    const entries = (await redis.sendCommand(['SLOWLOG', 'GET', String(count)])) as any[];

    const logs = (entries || []).map((entry: any) => ({
      id: entry[0],
      timestamp: entry[1],
      duration_us: entry[2],
      // Slowlog arguments can carry secrets (e.g. SET token ...); apply the
      // same redaction policy as the doctor report.
      command: redactText(Array.isArray(entry[3]) ? entry[3].join(' ') : String(entry[3])),
    }));

    ctx.body = { data: logs };
    await next();
  },

  /**
   * GET /clusterManagerRedis:syncMessages
   * Returns info about NocoBase sync message channels (pub/sub layer)
   */
  async syncMessages(ctx: Context, next: () => Promise<void>) {
    const pubSubManager = ctx.app.pubSubManager;
    const syncManager = ctx.app.syncMessageManager;

    const info: any = {
      pubSubConnected: false,
      channels: [],
    };

    try {
      info.pubSubConnected = await pubSubManager?.isConnected();
    } catch {
      // Ignore
    }

    // Get subscribed channels from handler manager
    try {
      const handlerManager = (pubSubManager as any)?.handlerManager;
      if (handlerManager?.handlers) {
        const handlers = handlerManager.handlers as Map<string, any>;
        for (const [channel] of handlers.entries()) {
          info.channels.push({ channel });
        }
      }
    } catch {
      // Ignore
    }

    ctx.body = info;
    await next();
  },
};
