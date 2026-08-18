import type { Context } from '@nocobase/actions';
import { randomUUID } from 'crypto';
import type { PluginClusterManagerServer } from '../plugin';
import { getRedisClient } from '../utils/redis';

type CheckResult = { status: 'ok' | 'error'; detail?: string; latencyMs?: number };

async function runCheck(check: () => Promise<void>): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    await check();
    return { status: 'ok', latencyMs: Date.now() - startedAt };
  } catch (error: unknown) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  }
}

export const healthActions = {
  async liveness(ctx: Context, next: () => Promise<void>) {
    ctx.body = { status: 'ok', timestamp: new Date().toISOString() };
    await next();
  },

  async readiness(ctx: Context, next: () => Promise<void>) {
    const plugin = ctx.app.pm.get('plugin-cluster-manager') as PluginClusterManagerServer | undefined;
    const probeKey = `cluster-manager:readiness:${randomUUID()}`;
    const checks: Record<string, CheckResult> = {};

    checks.database = await runCheck(async () => {
      await ctx.app.db.sequelize.query('SELECT 1');
    });

    checks.cache = await runCheck(async () => {
      const expected = randomUUID();
      await ctx.app.cache.set(probeKey, expected, 10_000);
      const actual = await ctx.app.cache.get(probeKey);
      await ctx.app.cache.del(probeKey);
      if (actual !== expected) throw new Error('Shared cache read-after-write check failed');
    });

    checks.redis = await runCheck(async () => {
      const redis = getRedisClient(ctx.app);
      if (!redis) throw new Error('Cluster Redis is not configured');
      const result = await redis.sendCommand(['PING']);
      if (result !== 'PONG') throw new Error(`Unexpected Redis PING response: ${String(result)}`);
    });

    checks.pubsub = await runCheck(async () => {
      if (!(await ctx.app.pubSubManager.isConnected())) throw new Error('Redis Pub/Sub adapter is not connected');
    });

    checks.queue = await runCheck(async () => {
      if (!ctx.app.eventQueue.isConnected()) throw new Error('Redis event queue is not connected');
    });

    checks.lock = await runCheck(async () => {
      const lock = await ctx.app.lockManager.tryAcquire(`readiness:${randomUUID()}`);
      await lock.release();
    });

    checks.workerId = await runCheck(async () => {
      const status = plugin?.workerIdAllocator?.getStatus();
      if (status) {
        if (!status.healthy || status.workerId === null) {
          throw new Error(status.lastError || 'Worker ID lease is unhealthy');
        }
        return;
      }
      const allocator = ctx.app.workerIdAllocator as unknown as { adapter?: unknown };
      if (!allocator.adapter) throw new Error('Redis Worker ID allocator is not configured');
    });

    const failed = Object.entries(checks)
      .filter(([, result]) => result.status === 'error')
      .map(([name]) => name);
    const ready = failed.length === 0 && !ctx.app.maintainingMessage;
    if (!ready) ctx.status = 503;

    // This endpoint is public (load balancers and docker healthchecks call it
    // without a session). Raw check errors can expose internal topology
    // (DB host/port, Redis address, auth failures), so detailed results are
    // only returned to authenticated callers.
    const includeDetails = Boolean(ctx.state?.currentUser);
    ctx.body = {
      status: ready ? 'ready' : 'not-ready',
      maintaining: ctx.app.maintainingMessage || null,
      failed,
      timestamp: new Date().toISOString(),
      ...(includeDetails
        ? {
            version: process.env.NOCOBASE_VERSION || process.version,
            mode: process.env.WORKER_MODE || 'main',
            checks,
          }
        : {}),
    };
    await next();
  },
};
