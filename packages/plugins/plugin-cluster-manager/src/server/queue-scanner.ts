/**
 * QueueScanner discovers process keys and queue aliases that can be assigned
 * to worker stacks. The worker deployment should receive process keys in
 * WORKER_MODE; physical EventQueue/Redis names are exposed as aliases only.
 */

import type { Application } from '@nocobase/server';
import {
  getWorkerProcessDefinition,
  resolveWorkerProcessName,
  WORKER_PROCESS_DEFINITIONS,
} from '../shared/worker-processes';
import { getRedisClient } from './utils/redis';

export type QueueItem = {
  name: string;
  label: string;
  description: string;
  type: 'event-queue' | 'redis-list' | 'db-poll';
  pending: number | null;
  workerProcessName?: string;
};

const REDIS_QUEUE_PATTERNS = [
  '*:plugin-git-manager:review:queue',
  '*:plugin-build-guide-block:build:queue',
  '*:plugin-build-visualization-block:build:queue',
  'file-preview-auth.ocr.queue',
];

function describeRedisQueueKey(key: string): { label: string; description: string; workerProcessName?: string } {
  const workerProcessName = resolveWorkerProcessName(key);
  const definition = getWorkerProcessDefinition(workerProcessName);
  if (definition) {
    return {
      label: definition.label,
      description: definition.description,
      workerProcessName: definition.name,
    };
  }

  const parts = String(key).split(':');
  const plugin = parts[parts.length - 3] || 'unknown';
  const queue = parts[parts.length - 2] || key;
  return {
    label: `${queue} (${plugin})`,
    description: `Redis List queue from ${plugin}`,
  };
}

function scanEventQueue(app: Application): QueueItem[] {
  const eq = (app as any).eventQueue;
  if (!eq?.events) return [];

  const events: Map<string, { concurrency?: number; interval?: number; shared?: boolean }> = eq.events;
  const items: QueueItem[] = [];

  for (const [channel] of events.entries()) {
    const workerProcessName = resolveWorkerProcessName(channel);
    const known = getWorkerProcessDefinition(workerProcessName);
    items.push({
      name: channel,
      label: known?.label ?? channel,
      description: known?.description ?? `EventQueue channel: ${channel}`,
      type: 'event-queue',
      pending: null,
      workerProcessName: known?.name,
    });
  }

  return items;
}

function scanKnownWorkerModes(app: Application): QueueItem[] {
  const pluginManager = (app as unknown as { pm?: { get?: (name: string) => unknown } }).pm;
  if (!pluginManager?.get) return [];

  const hasPlugin = (name: string) => {
    try {
      return Boolean(pluginManager.get?.(name));
    } catch {
      return false;
    }
  };

  return WORKER_PROCESS_DEFINITIONS.filter(
    (definition) =>
      definition.common && !definition.sandbox && (!definition.pluginName || hasPlugin(definition.pluginName)),
  ).map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    type:
      definition.kind === 'redis-list'
        ? ('redis-list' as const)
        : definition.kind === 'db-poll'
          ? ('db-poll' as const)
          : ('event-queue' as const),
    pending: null,
    workerProcessName: definition.name,
  }));
}

async function scanRedisQueues(app: Application): Promise<QueueItem[]> {
  const redis = getRedisClient(app);
  if (!redis) {
    return [];
  }

  const seen = new Set<string>();
  const items: QueueItem[] = [];

  for (const pattern of REDIS_QUEUE_PATTERNS) {
    try {
      const result = await redis.sendCommand(['SCAN', '0', 'MATCH', pattern, 'COUNT', '200']);
      const keyList: string[] = Array.isArray(result?.[1]) ? result[1] : [];

      for (const key of keyList) {
        if (seen.has(key)) continue;
        seen.add(key);

        const desc = describeRedisQueueKey(key);
        let pending = 0;
        try {
          pending = Number(await redis.sendCommand(['LLEN', key])) || 0;
        } catch {
          pending = 0;
        }

        items.push({
          name: key,
          label: desc.label,
          description: desc.description,
          type: 'redis-list',
          pending,
          workerProcessName: desc.workerProcessName,
        });
      }
    } catch {
      // SCAN not supported or permission denied
    }
  }

  return items;
}

export async function scanQueues(app: Application): Promise<{ queues: QueueItem[]; total: number }> {
  const eventQueues = scanEventQueue(app);
  const knownWorkerModes = scanKnownWorkerModes(app);
  const redisQueues = await scanRedisQueues(app);

  const seenNames = new Set<string>();
  const merged: QueueItem[] = [];

  for (const q of eventQueues) {
    merged.push(q);
    seenNames.add(q.name);
  }
  for (const q of knownWorkerModes) {
    if (!seenNames.has(q.name)) {
      merged.push(q);
      seenNames.add(q.name);
    }
  }
  for (const q of redisQueues) {
    if (!seenNames.has(q.name)) {
      merged.push(q);
      seenNames.add(q.name);
    }
  }

  return { queues: merged, total: merged.length };
}
