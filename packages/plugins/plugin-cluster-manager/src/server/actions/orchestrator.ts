/**
 * Orchestrator Actions
 *
 * API endpoints for container management. Write operations (scale, start, stop, remove)
 * are guarded by leader election — only the leader node can execute them.
 */

import { Context } from '@nocobase/actions';
import { getRedisClient } from '../utils/redis';
import type { IOrchestratorAdapter, StackConfig } from '../orchestrator/types';
import { normalizeWorkerMode } from '../../shared/worker-processes';
import { resolveWorkerTemplate, type WorkerTemplateVariable } from '../orchestrator/worker-template';

type QueueMappingRecord = {
  get: (key: string) => unknown;
};

/** Helper: get orchestrator adapter from plugin instance */
function getAdapter(ctx: Context): IOrchestratorAdapter {
  const plugin = ctx.app.pm.get('plugin-cluster-manager') as any;
  if (!plugin?.orchestrator) {
    ctx.throw(503, 'Orchestrator adapter not configured. Configure it in Cluster Manager settings.');
  }
  return plugin.orchestrator;
}

/** Helper: check if this node is the leader (fresh Redis check for fencing) */
async function assertLeader(ctx: Context) {
  const plugin = ctx.app.pm.get('plugin-cluster-manager') as any;
  if (!plugin?.leaderElection) {
    ctx.throw(503, 'Orchestrator leader election is not initialized.');
  }
  if (!plugin.leaderElection.isLeader) {
    const reason = plugin.leaderElection.disabledReason;
    ctx.throw(409, reason || 'This node is not the orchestrator leader. The leader handles write operations.');
  }
  // Re-check against Redis: the in-memory flag can be stale if this node was
  // paused past the lock TTL and another node took over.
  const verified = await plugin.leaderElection.verifyLeadership();
  if (!verified) {
    ctx.throw(409, 'Leadership was lost during the request. The leader handles write operations.');
  }
}

/** Helper: get stack by ID */
async function getStack(ctx: Context, stackId?: number | string): Promise<StackConfig> {
  const id = stackId || ctx.action.params.values?.stackId || ctx.action.params.filterByTk;
  if (!id) ctx.throw(400, 'stackId is required');

  const repo = ctx.db.getRepository('orchestratorStacks');
  const stack = await repo.findOne({ filterByTk: id });
  if (!stack) ctx.throw(404, `Stack #${id} not found`);
  return stack.toJSON() as StackConfig;
}

async function assertManagedContainer(
  ctx: Context,
  adapter: IOrchestratorAdapter,
  stack: StackConfig,
  containerId: string,
) {
  try {
    await adapter.assertManagedByStack(stack, containerId);
  } catch (err: any) {
    ctx.throw(403, err.message || `Container ${containerId} is not managed by stack "${stack.name}"`);
  }
}

function applyWorkerMode(stack: StackConfig, workerMode: string) {
  stack.workerMode = workerMode;
}

async function resolveWorkerStack(ctx: Context, stack: StackConfig): Promise<StackConfig> {
  const templateRepo = ctx.db.getRepository('workerTemplateVariables');
  const rows = await templateRepo.find({ sort: ['scope', 'stackId', 'sort', 'key'] });
  const variables = rows.map((row) => row.toJSON() as unknown as WorkerTemplateVariable);
  const resolved = resolveWorkerTemplate({
    stack,
    variables,
    inheritedEnv: {
      CLUSTER_MANAGER_WORKER_READY_URL: process.env.CLUSTER_MANAGER_WORKER_READY_URL,
      CLUSTER_MANAGER_WORKER_IMAGE: process.env.CLUSTER_MANAGER_WORKER_IMAGE,
    },
    fallbackReadyUrl: process.env.CLUSTER_MANAGER_WORKER_READY_URL,
  });

  for (const warning of resolved.warnings) {
    ctx.app.logger.warn(`[Orchestrator] ${warning}`);
  }
  return {
    ...stack,
    image: resolved.image || '',
    command: undefined,
    envVars: resolved.envVars,
    templateHash: resolved.templateHash,
  };
}

async function resolveMappedWorkerMode(ctx: Context, stack: StackConfig): Promise<string | undefined> {
  const mappingsRepo = ctx.db.getRepository('workerQueueMappings');
  const assigned = (await mappingsRepo.find({
    filter: {
      stackId: stack.id,
      enabled: true,
    },
  })) as QueueMappingRecord[];

  return normalizeWorkerMode(
    assigned
      .map((mapping) => String(mapping.get('queueName') || ''))
      .filter(Boolean)
      .join(','),
  );
}

export const orchestratorActions = {
  /**
   * GET /workerOrchestrator:ping
   * Test connectivity to the container runtime
   */
  async ping(ctx: Context, next: () => Promise<void>) {
    const adapter = getAdapter(ctx);
    const ok = await adapter.ping();
    ctx.body = {
      adapter: adapter.name,
      connected: ok,
      leader: (ctx.app.pm.get('plugin-cluster-manager') as any)?.leaderElection?.isLeader ?? false,
      leaderId: (ctx.app.pm.get('plugin-cluster-manager') as any)?.leaderElection?.leaderId,
      leaderDisabledReason: (ctx.app.pm.get('plugin-cluster-manager') as any)?.leaderElection?.disabledReason,
    };
    await next();
  },

  /**
   * GET /workerOrchestrator:containers?stackId=1
   * List live containers for a stack
   */
  async containers(ctx: Context, next: () => Promise<void>) {
    const adapter = getAdapter(ctx);
    const { stackId } = ctx.action.params;
    const stack = await getStack(ctx, stackId);

    const containers = await adapter.listContainers(stack);

    // Fetch package status from Redis
    const redisClient = getRedisClient(ctx.app);
    if (redisClient) {
      for (const c of containers) {
        try {
          const rawStatus = await redisClient.sendCommand(['GET', `orchestrator:pkg-status:${c.name}`]);
          if (rawStatus && typeof rawStatus === 'string') {
            (c as any).packageStatus = JSON.parse(rawStatus);
          }
        } catch {
          // Redis may not be configured — skip package status
        }
      }
    }

    // Update replicas count in DB (reconciliation)
    const running = containers.filter((c) => c.status === 'running').length;
    const repo = ctx.db.getRepository('orchestratorStacks');
    await repo.update({
      filterByTk: stack.id,
      values: { replicas: running },
    });

    ctx.body = {
      data: containers,
      meta: {
        stackName: stack.name,
        running,
        total: containers.length,
      },
    };
    await next();
  },

  /**
   * POST /workerOrchestrator:scale
   * Body: { stackId: 1, replicas: 3 }
   * Leader-only
   *
   * Before scaling, resolves the stack-level worker mode and injects
   * WORKER_MODE into envVars so new containers process only selected queues.
   * Queue mappings remain as a fallback for legacy stacks.
   */
  async scale(ctx: Context, next: () => Promise<void>) {
    await assertLeader(ctx);
    const adapter = getAdapter(ctx);

    const { stackId, replicas } = ctx.action.params.values || ctx.action.params;
    if (replicas === undefined || replicas === null) ctx.throw(400, 'replicas is required');
    if (replicas < 0 || replicas > 20) ctx.throw(400, 'replicas must be between 0 and 20');

    const stack = await getStack(ctx, stackId);

    const stackWorkerMode = normalizeWorkerMode(stack.workerMode);
    const envWorkerMode = normalizeWorkerMode(stack.envVars?.WORKER_MODE);

    if (stackWorkerMode) {
      applyWorkerMode(stack, stackWorkerMode);
      ctx.app.logger.info(`[Orchestrator] Using stack WORKER_MODE=${stackWorkerMode} for "${stack.name}"`);
    } else if (envWorkerMode && envWorkerMode !== '*') {
      applyWorkerMode(stack, envWorkerMode);
      ctx.app.logger.info(`[Orchestrator] Using env WORKER_MODE=${envWorkerMode} for "${stack.name}"`);
    } else {
      try {
        const mappedWorkerMode = await resolveMappedWorkerMode(ctx, stack);

        if (mappedWorkerMode) {
          applyWorkerMode(stack, mappedWorkerMode);
          ctx.app.logger.info(`[Orchestrator] Using mapped WORKER_MODE=${mappedWorkerMode} for "${stack.name}"`);
        } else {
          const fallbackWorkerMode = envWorkerMode || '*';
          applyWorkerMode(stack, fallbackWorkerMode);
          ctx.app.logger.info(`[Orchestrator] Using fallback WORKER_MODE=${fallbackWorkerMode} for "${stack.name}"`);
        }
      } catch (err: any) {
        const fallbackWorkerMode = envWorkerMode || '*';
        ctx.app.logger.debug(`[Orchestrator] Queue mappings not available: ${err.message}`);
        applyWorkerMode(stack, fallbackWorkerMode);
      }
    }

    let workerStack: StackConfig;
    try {
      workerStack = await resolveWorkerStack(ctx, stack);
    } catch (error) {
      ctx.throw(400, error instanceof Error ? error.message : String(error));
      return;
    }

    const result = await adapter.scale(workerStack, Number(replicas));

    // Update DB
    const repo = ctx.db.getRepository('orchestratorStacks');
    await repo.update({
      filterByTk: stack.id,
      values: {
        replicas: result.currentReplicas,
        desiredReplicas: Number(replicas),
      },
    });

    ctx.app.logger.info(
      `[Orchestrator] Scaled "${stack.name}": ${result.previousReplicas} → ${result.currentReplicas}`,
    );

    ctx.body = result;
    await next();
  },

  /**
   * POST /workerOrchestrator:start
   * Body: { stackId: 1, containerId: "abc123" }
   * Leader-only
   */
  async start(ctx: Context, next: () => Promise<void>) {
    await assertLeader(ctx);
    const adapter = getAdapter(ctx);

    const { stackId, containerId } = ctx.action.params.values || ctx.action.params;
    if (!stackId) ctx.throw(400, 'stackId is required');
    if (!containerId) ctx.throw(400, 'containerId is required');

    const stack = await getStack(ctx, stackId);
    await assertManagedContainer(ctx, adapter, stack, containerId);
    await adapter.startContainer(containerId);
    ctx.app.logger.info(`[Orchestrator] Started container ${containerId}`);
    ctx.body = { success: true, containerId };
    await next();
  },

  /**
   * POST /workerOrchestrator:stop
   * Body: { stackId: 1, containerId: "abc123" }
   * Leader-only
   */
  async stop(ctx: Context, next: () => Promise<void>) {
    await assertLeader(ctx);
    const adapter = getAdapter(ctx);

    const { stackId, containerId } = ctx.action.params.values || ctx.action.params;
    if (!stackId) ctx.throw(400, 'stackId is required');
    if (!containerId) ctx.throw(400, 'containerId is required');

    const stack = await getStack(ctx, stackId);
    await assertManagedContainer(ctx, adapter, stack, containerId);
    await adapter.stopContainer(containerId);
    ctx.app.logger.info(`[Orchestrator] Stopped container ${containerId}`);
    ctx.body = { success: true, containerId };
    await next();
  },

  /**
   * POST /workerOrchestrator:remove
   * Body: { stackId: 1, containerId: "abc123" }
   * Leader-only
   */
  async remove(ctx: Context, next: () => Promise<void>) {
    await assertLeader(ctx);
    const adapter = getAdapter(ctx);

    const { stackId, containerId } = ctx.action.params.values || ctx.action.params;
    if (!stackId) ctx.throw(400, 'stackId is required');
    if (!containerId) ctx.throw(400, 'containerId is required');

    const stack = await getStack(ctx, stackId);
    await assertManagedContainer(ctx, adapter, stack, containerId);
    await adapter.removeContainer(containerId);
    ctx.app.logger.info(`[Orchestrator] Removed container ${containerId}`);
    ctx.body = { success: true, containerId };
    await next();
  },

  /**
   * GET /workerOrchestrator:stats?containerId=abc123
   * Get real-time stats for a container
   */
  async stats(ctx: Context, next: () => Promise<void>) {
    const adapter = getAdapter(ctx);
    const { stackId, containerId } = ctx.action.params;
    if (!stackId) ctx.throw(400, 'stackId is required');
    if (!containerId) ctx.throw(400, 'containerId is required');

    const stack = await getStack(ctx, stackId);
    await assertManagedContainer(ctx, adapter, stack, containerId);

    try {
      const stats = await adapter.getStats(containerId);
      ctx.body = stats;
    } catch (err: any) {
      ctx.throw(404, `Container ${containerId} not found or not running: ${err.message}`);
    }
    await next();
  },

  /**
   * GET /workerOrchestrator:logs?containerId=abc123&tail=100
   * Get tail logs from a container
   */
  async logs(ctx: Context, next: () => Promise<void>) {
    const adapter = getAdapter(ctx);
    const { stackId, containerId, tail = 200 } = ctx.action.params;
    if (!stackId) ctx.throw(400, 'stackId is required');
    if (!containerId) ctx.throw(400, 'containerId is required');

    const maxTail = Math.min(Number(tail) || 200, 1000);
    const stack = await getStack(ctx, stackId);
    await assertManagedContainer(ctx, adapter, stack, containerId);

    try {
      const logs = await adapter.getLogs(containerId, maxTail);
      ctx.body = { containerId, lines: logs.split('\n'), count: logs.split('\n').length };
    } catch (err: any) {
      ctx.throw(404, `Container ${containerId} not found: ${err.message}`);
    }
    await next();
  },

  /**
   * GET /workerOrchestrator:networks
   * List available networks (if supported by adapter)
   */
  async networks(ctx: Context, next: () => Promise<void>) {
    const adapter = getAdapter(ctx);
    if (!adapter.listNetworks) {
      ctx.body = { data: [] };
    } else {
      try {
        const networks = await adapter.listNetworks();
        ctx.body = { data: networks };
      } catch (err: any) {
        ctx.app.logger.warn(`Failed to list networks: ${err.message}`);
        ctx.body = { data: [] };
      }
    }
    await next();
  },
};
