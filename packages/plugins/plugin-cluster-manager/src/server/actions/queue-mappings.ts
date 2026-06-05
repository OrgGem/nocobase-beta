/**
 * Queue Mappings Actions
 *
 * CRUD for workerQueueMappings + scanQueues action that discovers
 * all registered queues via QueueScanner.
 */

import { Context } from '@nocobase/actions';
import { scanQueues } from '../queue-scanner';

export const queueMappingsActions = {
  /**
   * GET /workerQueueMappings:scanQueues
   * Scans all registered queues (EventQueue + Redis) and merges with existing mappings.
   */
  async scanQueues(ctx: Context, next: () => Promise<void>) {
    const result = await scanQueues(ctx.app);

    // Load existing mappings from DB
    const repo = ctx.db.getRepository('workerQueueMappings');
    let existingMappings: any[] = [];
    try {
      existingMappings = await repo.find();
    } catch {
      // Table may not exist yet
    }

    const mappedNames = new Set(existingMappings.map((m) => m.get('queueName') as string));

    ctx.body = {
      discovered: result.queues,
      total: result.total,
      registered: existingMappings.map((m) => ({
        id: m.get('id'),
        queueName: m.get('queueName'),
        label: m.get('label'),
        stackId: m.get('stackId'),
        enabled: m.get('enabled'),
        type: m.get('type'),
      })),
      unmapped: result.queues
        .filter((q) => !mappedNames.has(q.name))
        .map((q) => ({
          name: q.name,
          type: q.type,
          label: q.label,
          description: q.description,
        })),
    };
    await next();
  },

  /**
   * POST /workerQueueMappings:autoMap
   * Auto-create mappings for any discovered queues that don't have one yet.
   * Body: { stackId?: number } — optional default stack for new mappings
   */
  async autoMap(ctx: Context, next: () => Promise<void>) {
    const { stackId } = ctx.action.params.values || {};
    const result = await scanQueues(ctx.app);
    const repo = ctx.db.getRepository('workerQueueMappings');

    let existingMappings: any[] = [];
    try {
      existingMappings = await repo.find();
    } catch {
      // Table may not exist yet
    }

    const mappedNames = new Set(existingMappings.map((m) => m.get('queueName') as string));
    const created: string[] = [];

    for (const q of result.queues) {
      if (mappedNames.has(q.name)) continue;
      await repo.create({
        values: {
          queueName: q.name,
          label: q.label,
          description: q.description,
          type: q.type,
          stackId: stackId || null,
          enabled: true,
        },
      });
      created.push(q.name);
    }

    ctx.body = {
      created,
      count: created.length,
    };
    await next();
  },
};
