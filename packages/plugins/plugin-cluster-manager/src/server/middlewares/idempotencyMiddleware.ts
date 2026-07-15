import type { Context } from '@nocobase/actions';
import { createHash, randomUUID } from 'crypto';
import { getRedisClient } from '../utils/redis';

const PROCESSING_TTL_SECONDS = 300;
const COMPLETED_TTL_SECONDS = 86_400;
const PROTECTED_RESOURCE_PREFIXES = ['clusterManager', 'workerOrchestrator', 'orchestratorStacks', 'workerPackages'];

type IdempotencyRecord = {
  state: 'processing' | 'completed';
  owner: string;
  fingerprint: string;
  status?: number;
  body?: unknown;
};

const COMPLETE_SCRIPT = `
local current = redis.call('get', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.owner ~= ARGV[1] then return 0 end
redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

const DELETE_SCRIPT = `
local current = redis.call('get', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.owner ~= ARGV[1] then return 0 end
return redis.call('del', KEYS[1])
`;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = stableValue((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createIdempotencyMiddleware(app: any) {
  return async function idempotencyMiddleware(ctx: Context, next: () => Promise<void>) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)) return next();
    const resource = ctx.action?.resourceName || '';
    if (!PROTECTED_RESOURCE_PREFIXES.some((prefix) => resource.startsWith(prefix))) return next();

    const idempotencyKey = String(ctx.get?.('Idempotency-Key') || ctx.headers['idempotency-key'] || '').trim();
    if (!idempotencyKey) return next();
    if (idempotencyKey.length > 200) ctx.throw(400, 'Idempotency-Key must not exceed 200 characters');

    const redis = getRedisClient(app);
    if (!redis) ctx.throw(503, 'Redis is required for idempotent cluster operations');

    const userId = String(ctx.state?.currentUser?.id || 'anonymous');
    const action = ctx.action?.actionName || '';
    const fingerprint = hash(
      JSON.stringify(stableValue({ method: ctx.method, resource, action, params: ctx.action?.params || {} })),
    );
    const redisKey = `nocobase:${app.name}:cluster-manager:idempotency:${hash(
      `${userId}:${resource}:${action}:${idempotencyKey}`,
    )}`;
    const owner = randomUUID();
    const processing: IdempotencyRecord = { state: 'processing', owner, fingerprint };
    const acquired = await redis.sendCommand([
      'SET',
      redisKey,
      JSON.stringify(processing),
      'NX',
      'EX',
      String(PROCESSING_TTL_SECONDS),
    ]);

    if (acquired !== 'OK') {
      const raw = await redis.sendCommand(['GET', redisKey]);
      if (typeof raw !== 'string') ctx.throw(409, 'The idempotent operation is already in progress');
      const existing = JSON.parse(raw) as IdempotencyRecord;
      if (existing.fingerprint !== fingerprint) {
        ctx.throw(409, 'The same Idempotency-Key was used with a different request payload');
      }
      if (existing.state === 'completed') {
        ctx.status = existing.status || 200;
        ctx.body = existing.body;
        ctx.set('Idempotency-Replayed', 'true');
        return;
      }
      ctx.set('Retry-After', '2');
      ctx.throw(409, 'The idempotent operation is already in progress');
    }

    try {
      await next();
    } catch (error) {
      await redis.sendCommand(['EVAL', DELETE_SCRIPT, '1', redisKey, owner]).catch(() => 0);
      throw error;
    }

    try {
      const completed: IdempotencyRecord = {
        state: 'completed',
        owner,
        fingerprint,
        status: ctx.status,
        body: ctx.body,
      };
      await redis.sendCommand([
        'EVAL',
        COMPLETE_SCRIPT,
        '1',
        redisKey,
        owner,
        JSON.stringify(completed),
        String(COMPLETED_TTL_SECONDS),
      ]);
      ctx.set('Idempotency-Replayed', 'false');
    } catch (error: unknown) {
      await redis.sendCommand(['EVAL', DELETE_SCRIPT, '1', redisKey, owner]).catch(() => 0);
      app.logger.error(
        `[ClusterManager] Failed to persist idempotency result for ${resource}:${action}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}
