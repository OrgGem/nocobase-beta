/**
 * Core HA integration helpers.
 *
 * NocoBase core already owns the HA building blocks (worker ID allocation,
 * Pub/Sub, event queue, distributed locks). This module does NOT re-implement
 * them; it only makes sure a Redis-backed implementation is installed when the
 * deployment asks for one, and it never overwrites an adapter that another
 * party (core itself or another plugin) has already registered.
 *
 * Keeping this logic in one place means the cluster manager behaves the same
 * whether it runs on stock open-source core or on a build where core wires the
 * Redis adapters natively from environment configuration.
 */

export type HaIntegrationOutcome = 'installed' | 'already-registered' | 'disabled' | 'unavailable';

export interface HaIntegrationResult {
  component: string;
  outcome: HaIntegrationOutcome;
  message: string;
}

export interface HaLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const SCOPE = '[ClusterManager]';

function resolveUrl(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) {
      return value;
    }
  }
  return '';
}

/** Minimal structural view of core objects we must inspect without overwriting. */
interface WorkerIdAllocatorState {
  adapter?: unknown;
  setAdapter?: (adapter: unknown) => void;
}

interface PubSubManagerState {
  adapter?: unknown;
  setAdapter?: (adapter: unknown) => void;
}

interface EventQueueState {
  adapter?: unknown;
  setAdapter?: (adapter: unknown) => void;
  isConnected?: () => boolean;
  connect?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface LockManagerState {
  registry?: {
    get?: (name: string) => unknown;
    register?: (name: string, config: unknown) => void;
  };
}

export interface RedisAdapterFactories {
  createWorkerIdAllocator: (url: string) => unknown;
  createPubSubAdapter: (url: string) => unknown;
  createEventQueueAdapter: (url: string, app: unknown) => unknown;
  redisLockAdapter:
    | {
        Adapter: new (...args: unknown[]) => unknown;
        options: Record<string, unknown>;
      }
    | undefined;
}

/**
 * Install the Redis worker ID allocator on core's WorkerIdAllocator.
 *
 * Core allocates the Snowflake worker ID during `Application.load()`, after all
 * plugins ran `afterAdd()`, so registering here is early enough on every node.
 * An adapter that is already present is never replaced: whoever installed it
 * first owns the lease lifecycle.
 */
export function ensureRedisWorkerIdAllocator(options: {
  allocator: WorkerIdAllocatorState | undefined;
  url: string;
  logger: HaLogger;
  createAdapter: (url: string) => unknown;
}): HaIntegrationResult {
  const component = 'workerIdAllocator';
  const { allocator, url, logger, createAdapter } = options;

  if (!allocator) {
    return { component, outcome: 'unavailable', message: `${SCOPE} core workerIdAllocator is not available` };
  }
  if (allocator.adapter) {
    return {
      component,
      outcome: 'already-registered',
      message: `${SCOPE} worker ID allocator already registered; keeping the existing adapter`,
    };
  }
  if (!url) {
    const message =
      `${SCOPE} WORKER_ID_REDIS_URL/REDIS_URL is missing; HA worker ID allocation is unavailable ` +
      '(Snowflake IDs fall back to a random worker ID)';
    logger.warn(message);
    return { component, outcome: 'disabled', message };
  }

  allocator.setAdapter(createAdapter(url));
  return { component, outcome: 'installed', message: `${SCOPE} Redis worker ID allocator registered` };
}

/**
 * Install the Redis Pub/Sub adapter on core's PubSubManager.
 *
 * Pub/Sub carries the cluster manager command channels (restart, log request,
 * doctor collect, package install) and core's own sync messages, so a missing
 * adapter breaks cross-node control rather than just monitoring.
 */
export function ensureRedisPubSubAdapter(options: {
  pubSubManager: PubSubManagerState | undefined;
  url: string;
  logger: HaLogger;
  createAdapter: (url: string) => unknown;
}): HaIntegrationResult {
  const component = 'pubSubManager';
  const { pubSubManager, url, logger, createAdapter } = options;

  if (!pubSubManager) {
    return { component, outcome: 'unavailable', message: `${SCOPE} core pubSubManager is not available` };
  }
  if (pubSubManager.adapter) {
    return {
      component,
      outcome: 'already-registered',
      message: `${SCOPE} PubSub adapter already registered; keeping the existing adapter`,
    };
  }
  if (!url) {
    const message = `${SCOPE} PUBSUB_ADAPTER_REDIS_URL/REDIS_URL is not set; cross-node commands use in-process Pub/Sub only`;
    logger.info(message);
    return { component, outcome: 'disabled', message };
  }

  pubSubManager.setAdapter(createAdapter(url));
  return { component, outcome: 'installed', message: `${SCOPE} Redis PubSub adapter registered` };
}

/**
 * Install the Redis event queue adapter on core's EventQueue.
 *
 * Only the in-memory default is replaced. If core (or another plugin) already
 * installed a persistent adapter, it is left untouched and the cluster manager
 * simply monitors it.
 */
export async function ensureRedisEventQueueAdapter(options: {
  eventQueue: EventQueueState | undefined;
  enabled: boolean;
  url: string;
  logger: HaLogger;
  createAdapter: (url: string) => unknown;
}): Promise<HaIntegrationResult> {
  const component = 'eventQueue';
  const { eventQueue, enabled, url, logger, createAdapter } = options;

  if (!eventQueue) {
    return { component, outcome: 'unavailable', message: `${SCOPE} core eventQueue is not available` };
  }
  if (!enabled) {
    return {
      component,
      outcome: 'disabled',
      message: `${SCOPE} QUEUE_ADAPTER/QUEUE_ADAPTER_REDIS_URL is not set; keeping the current queue adapter`,
    };
  }
  if (!url) {
    const message = `${SCOPE} QUEUE_ADAPTER=redis but QUEUE_ADAPTER_REDIS_URL/REDIS_URL is not set`;
    logger.warn(message);
    return { component, outcome: 'disabled', message };
  }

  const existingName = (eventQueue.adapter as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  if (existingName && existingName !== 'MemoryEventQueueAdapter') {
    return {
      component,
      outcome: 'already-registered',
      message: `${SCOPE} EventQueue adapter already registered (${existingName}); keeping the existing adapter`,
    };
  }

  const wasConnected = Boolean(eventQueue.isConnected?.());
  if (wasConnected) {
    await eventQueue.close?.();
  }
  eventQueue.setAdapter?.(createAdapter(url));
  if (wasConnected) {
    await eventQueue.connect?.();
  }
  return { component, outcome: 'installed', message: `${SCOPE} Redis EventQueue adapter registered` };
}

/**
 * Register the Redis lock adapter on core's LockManager.
 *
 * Core ships only the local (in-process) adapter, so without this a multi-node
 * deployment would take per-process locks. A pre-registered `redis` adapter is
 * respected.
 */
export function ensureRedisLockAdapter(options: {
  lockManager: LockManagerState | undefined;
  url: string;
  logger: HaLogger;
  adapterConfig: RedisAdapterFactories['redisLockAdapter'];
}): HaIntegrationResult {
  const component = 'lockManager';
  const { lockManager, url, logger, adapterConfig } = options;

  if (!lockManager?.registry?.register) {
    return { component, outcome: 'unavailable', message: `${SCOPE} core lockManager is not available` };
  }
  if (lockManager.registry.get?.('redis')) {
    return {
      component,
      outcome: 'already-registered',
      message: `${SCOPE} Redis lock adapter already registered; keeping the existing adapter`,
    };
  }
  if (!url) {
    const message = `${SCOPE} LOCK_ADAPTER_REDIS_URL/REDIS_URL is not set; locks stay process-local`;
    logger.warn(message);
    return { component, outcome: 'disabled', message };
  }
  if (!adapterConfig) {
    return { component, outcome: 'unavailable', message: `${SCOPE} Redis lock adapter factory is not available` };
  }

  lockManager.registry.register('redis', {
    Adapter: adapterConfig.Adapter,
    options: { ...adapterConfig.options, url },
  });
  return { component, outcome: 'installed', message: `${SCOPE} Redis lock adapter registered` };
}

/** Resolve every Redis endpoint the HA integration may need from the environment. */
export function resolveHaRedisUrls() {
  const fallback = process.env.REDIS_URL;
  return {
    workerId: resolveUrl(process.env.WORKER_ID_REDIS_URL, fallback),
    pubSub: resolveUrl(process.env.PUBSUB_ADAPTER_REDIS_URL, fallback),
    eventQueue: resolveUrl(process.env.QUEUE_ADAPTER_REDIS_URL, fallback),
    lock: resolveUrl(process.env.LOCK_ADAPTER_REDIS_URL, fallback),
  };
}

/** True when the deployment expects a Redis-backed event queue. */
export function isRedisEventQueueEnabled(): boolean {
  return process.env.QUEUE_ADAPTER === 'redis' || Boolean(process.env.QUEUE_ADAPTER_REDIS_URL?.trim());
}

export function summarizeHaIntegration(results: HaIntegrationResult[]): string {
  return results.map((result) => `${result.component}=${result.outcome}`).join(', ');
}
