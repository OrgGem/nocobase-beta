/**
 * QueueScanner — discovers all registered queues in the system.
 *
 * Two sources:
 *   1. EventQueue events (registered via app.eventQueue.subscribe)
 *   2. Redis List-based queues (convention *:plugin-*:queue)
 *
 * Used by the Queue Assignment UI to let admins map queues to worker stacks.
 */

import type { Application } from '@nocobase/server';
import { getRedisClient } from './utils/redis';

export type QueueItem = {
  name: string;
  label: string;
  description: string;
  type: 'event-queue' | 'redis-list';
  pending: number | null;
};

const KNOWN_QUEUE_LABELS: Record<string, { label: string; description: string }> = {
  'workflow:process': {
    label: 'Workflow',
    description: 'Process workflow executions (plugin-workflow)',
  },
  'async-task:process': {
    label: 'Async Tasks',
    description: 'Execute async tasks (plugin-async-task-manager)',
  },
  'knowledge-base:document-vectorize': {
    label: 'Document Vectorization',
    description: 'Vectorize knowledge base documents (plugin-knowledge-base)',
  },
  'git-review:process': {
    label: 'Git Review',
    description: 'AI code review jobs (plugin-git-manager)',
  },
  'build-guide:process': {
    label: 'Build Guide',
    description: 'Build user guide pages (plugin-build-guide-block)',
  },
  'build-ui-template:process': {
    label: 'Build UI Template',
    description: 'Build UI template pages (plugin-build-ui-template)',
  },
};

/** Redis key patterns for List-based queues (same as event-queue-monitor.ts) */
const REDIS_QUEUE_PATTERNS = ['*:plugin-git-manager:review:queue', '*:plugin-build-guide-block:build:queue'];

function describeRedisQueueKey(key: string): { label: string; description: string } {
  const parts = String(key).split(':');
  const plugin = parts[parts.length - 3] || 'unknown';
  const queue = parts[parts.length - 2] || key;
  return {
    label: `${queue} (${plugin})`,
    description: `Redis List queue from ${plugin}`,
  };
}

/**
 * Discover all queues from EventQueue subscribers.
 */
function scanEventQueue(app: Application): QueueItem[] {
  const eq = (app as any).eventQueue;
  if (!eq || !eq.events) return [];

  const events: Map<string, { concurrency?: number; interval?: number; shared?: boolean }> = eq.events;
  const items: QueueItem[] = [];

  for (const [channel] of events.entries()) {
    const known = KNOWN_QUEUE_LABELS[channel];
    items.push({
      name: channel,
      label: known?.label ?? channel,
      description: known?.description ?? `EventQueue channel: ${channel}`,
      type: 'event-queue',
      pending: null,
    });
  }

  return items;
}

/**
 * Discover Redis List-based queues via SCAN.
 */
async function scanRedisQueues(app: Application): Promise<QueueItem[]> {
  const redis = getRedisClient(app);
  if (!redis) {
    return [];
  }

  const seen = new Set<string>();
  const items: QueueItem[] = [];

  for (const pattern of REDIS_QUEUE_PATTERNS) {
    try {
      const keys: string[] = await redis.sendCommand(['SCAN', '0', 'MATCH', pattern, 'COUNT', '200']);
      const keyList: string[] = typeof keys[1]?.length === 'number' ? keys[1] : [];

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
        });
      }
    } catch {
      // SCAN not supported or permission denied
    }
  }

  return items;
}

/**
 * Full queue scan — merges EventQueue + Redis results.
 */
export async function scanQueues(app: Application): Promise<{ queues: QueueItem[]; total: number }> {
  const eventQueues = scanEventQueue(app);
  const redisQueues = await scanRedisQueues(app);

  // Deduplicate: if a queue name appears in both sources, prefer EventQueue
  const seenNames = new Set<string>();
  const merged: QueueItem[] = [];

  for (const q of eventQueues) {
    merged.push(q);
    seenNames.add(q.name);
  }
  for (const q of redisQueues) {
    if (!seenNames.has(q.name)) {
      merged.push(q);
      seenNames.add(q.name);
    }
  }

  return { queues: merged, total: merged.length };
}
