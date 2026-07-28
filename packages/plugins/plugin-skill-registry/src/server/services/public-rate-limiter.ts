import { createHmac } from 'crypto';

import { RegistryError } from '../contracts/errors';

interface Counter {
  get(key: string): Promise<number>;
  incr(key: string, ttl: number): Promise<number>;
  incrby(key: string, value: number, ttl: number): Promise<number>;
}

interface CacheManager {
  defaultStore?: string;
  createCounter(options: { name: string; prefix: string; store?: string }, lockManager?: unknown): Promise<Counter>;
}

interface RateLimitApplication {
  cacheManager: CacheManager;
  lockManager?: unknown;
}

type RateRule = {
  sustainedLimit: number;
  sustainedWindowMs: number;
  burstLimit: number;
  burstWindowMs: number;
};

export interface PublicRateLimitState {
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export interface PublicDownloadLease {
  readonly responseTimeoutMs: number;
  release(): Promise<void>;
}

export type PublicRateLimitScope = 'shared' | 'process-local';

const RATE_RULES: Record<'catalog' | 'detail' | 'download', RateRule> = {
  catalog: { sustainedLimit: 60, sustainedWindowMs: 60_000, burstLimit: 20, burstWindowMs: 5_000 },
  detail: { sustainedLimit: 120, sustainedWindowMs: 60_000, burstLimit: 30, burstWindowMs: 5_000 },
  download: { sustainedLimit: 30, sustainedWindowMs: 600_000, burstLimit: 10, burstWindowMs: 60_000 },
};

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9]\d*$/.test(normalized)) {
    return fallback;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback;
}

function downloadLeaseSettings() {
  const responseTimeoutMs = positiveInteger(
    process.env.SKILL_REGISTRY_DOWNLOAD_RESPONSE_TIMEOUT_MS,
    5 * 60 * 1000,
    30 * 60 * 1000,
  );
  const leaseTtlMs = Math.max(
    responseTimeoutMs + 60_000,
    positiveInteger(process.env.SKILL_REGISTRY_DOWNLOAD_LEASE_TTL_MS, 10 * 60 * 1000, 60 * 60 * 1000),
  );
  return {
    perIpLimit: positiveInteger(process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_PER_IP, 3, 20),
    globalLimit: positiveInteger(process.env.SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_GLOBAL, 20, 200),
    responseTimeoutMs,
    leaseTtlMs,
  };
}

export type PublicRateLimitBucket = keyof typeof RATE_RULES;

type WindowState = {
  limit: number;
  value: number;
  resetSeconds: number;
};

export class PublicRateLimitExceededError extends RegistryError {
  constructor(public readonly rateLimit: PublicRateLimitState) {
    super('RATE_LIMITED', 429, 'Public request limit exceeded. Retry later.');
    this.name = 'PublicRateLimitExceededError';
  }
}

function resolveScope(store: string): PublicRateLimitScope {
  return store.toLowerCase() === 'memory' ? 'process-local' : 'shared';
}

function windowKey(bucket: PublicRateLimitBucket, name: 'sustained' | 'burst', now: number, windowMs: number) {
  const startedAt = Math.floor(now / windowMs) * windowMs;
  return {
    key: `${bucket}:${name}:${startedAt}`,
    ttlMs: Math.max(1, startedAt + windowMs - now),
  };
}

function governingWindow(windows: WindowState[], exceeded: boolean): WindowState {
  const candidates = exceeded ? windows.filter((window) => window.value > window.limit) : windows;
  return candidates.reduce((selected, current) => {
    if (exceeded) {
      return current.resetSeconds > selected.resetSeconds ? current : selected;
    }
    const selectedRemaining = Math.max(0, selected.limit - selected.value);
    const currentRemaining = Math.max(0, current.limit - current.value);
    if (currentRemaining !== selectedRemaining) {
      return currentRemaining < selectedRemaining ? current : selected;
    }
    return current.resetSeconds < selected.resetSeconds ? current : selected;
  });
}

export class PublicRateLimiter {
  private readonly ipSecret =
    process.env.SKILL_REGISTRY_RATE_LIMIT_SECRET || process.env.APP_KEY || 'skill-registry-development';

  private constructor(
    private readonly counter: Counter,
    public readonly scope: PublicRateLimitScope,
  ) {}

  static async create(app: RateLimitApplication): Promise<PublicRateLimiter> {
    const configuredStore = process.env.SKILL_REGISTRY_RATE_LIMIT_STORE?.trim();
    const store = configuredStore || app.cacheManager.defaultStore || 'memory';
    const counter = await app.cacheManager.createCounter(
      {
        name: 'skill-registry-rate-limit',
        prefix: 'skill-registry:rate-limit',
        store,
      },
      app.lockManager,
    );
    return new PublicRateLimiter(counter, resolveScope(store));
  }

  hashIp(ip: string): string {
    return createHmac('sha256', this.ipSecret).update(ip).digest('hex');
  }

  async acquireDownloadLease(ip: string): Promise<PublicDownloadLease> {
    const settings = downloadLeaseSettings();
    const ipKey = `download-active:ip:${this.hashIp(ip)}`;
    const globalKey = 'download-active:global';

    const decrement = async (key: string): Promise<void> => {
      // If a process was paused beyond the safety TTL, the key may already have
      // expired. Do not recreate it at -1 because that would grant extra leases.
      if ((await this.counter.get(key)) > 0) {
        await this.counter.incrby(key, -1, settings.leaseTtlMs);
      }
    };

    const activeForIp = await this.counter.incrby(ipKey, 1, settings.leaseTtlMs);
    if (activeForIp > settings.perIpLimit) {
      await decrement(ipKey);
      throw new PublicRateLimitExceededError({
        limit: settings.perIpLimit,
        remaining: 0,
        resetSeconds: Math.ceil(settings.responseTimeoutMs / 1000),
      });
    }

    let activeGlobally: number;
    try {
      activeGlobally = await this.counter.incrby(globalKey, 1, settings.leaseTtlMs);
    } catch (error) {
      await decrement(ipKey).catch(() => undefined);
      throw error;
    }
    if (activeGlobally > settings.globalLimit) {
      await Promise.all([decrement(globalKey), decrement(ipKey)]);
      throw new PublicRateLimitExceededError({
        limit: settings.globalLimit,
        remaining: 0,
        resetSeconds: Math.ceil(settings.responseTimeoutMs / 1000),
      });
    }

    let released = false;
    return {
      responseTimeoutMs: settings.responseTimeoutMs,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        const results = await Promise.allSettled([decrement(globalKey), decrement(ipKey)]);
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) {
          throw failed.reason;
        }
      },
    };
  }

  async enforce(bucket: PublicRateLimitBucket, ip: string): Promise<PublicRateLimitState> {
    const rule = RATE_RULES[bucket];
    const hash = this.hashIp(ip);
    const now = Date.now();
    const sustainedKey = windowKey(bucket, 'sustained', now, rule.sustainedWindowMs);
    const burstKey = windowKey(bucket, 'burst', now, rule.burstWindowMs);
    const sustainedValue = await this.counter.incr(`${sustainedKey.key}:${hash}`, sustainedKey.ttlMs);
    const burstValue = await this.counter.incr(`${burstKey.key}:${hash}`, burstKey.ttlMs);
    const windows: WindowState[] = [
      {
        limit: rule.sustainedLimit,
        value: sustainedValue,
        resetSeconds: Math.ceil(sustainedKey.ttlMs / 1000),
      },
      {
        limit: rule.burstLimit,
        value: burstValue,
        resetSeconds: Math.ceil(burstKey.ttlMs / 1000),
      },
    ];
    const exceeded = windows.some((window) => window.value > window.limit);
    const governing = governingWindow(windows, exceeded);
    const state: PublicRateLimitState = {
      limit: governing.limit,
      remaining: Math.max(0, governing.limit - governing.value),
      resetSeconds: governing.resetSeconds,
    };
    if (exceeded) {
      throw new PublicRateLimitExceededError(state);
    }
    return state;
  }
}
