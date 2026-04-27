import { Plugin } from '@nocobase/server';

/**
 * Custom resource for the Swarm Tracing admin UI (Phase 5).
 * Queries the dedicated orchestratorLogs collection instead of
 * filtering aiConversations by JSONB (P2 fix: DB-engine agnostic).
 */
export function registerTracingResource(plugin: Plugin) {
  const app = plugin.app;

  app.resource({
    name: 'orchestratorTracing',
    actions: {
      /**
       * List all delegation execution logs.
       */
      async list(ctx, next) {
        const repo = ctx.db.getRepository('orchestratorLogs');
        const { page = 1, pageSize = 50, sort = ['-createdAt'], filter = {} } = ctx.action.params;

        try {
          const [rows, count] = await repo.findAndCount({
            filter,
            sort,
            offset: (Number(page) - 1) * Number(pageSize),
            limit: Number(pageSize),
          });

          ctx.body = {
            data: rows.map((row: any) => ({
              id: row.id,
              leaderUsername: row.leaderUsername,
              subAgentUsername: row.subAgentUsername,
              toolName: row.toolName,
              task: row.task,
              context: row.context,
              result: row.result,
              status: row.status,
              depth: row.depth,
              durationMs: row.durationMs,
              error: row.error,
              userId: row.userId,
              createdAt: row.createdAt,
              traceCount: Array.isArray(row.trace) ? row.trace.length : 0,
              messageCount: Array.isArray(row.messages) ? row.messages.length : 0,
            })),
            meta: {
              count,
              page: Number(page),
              pageSize: Number(pageSize),
              totalPage: Math.ceil(count / Number(pageSize)),
            },
          };
        } catch (e) {
          ctx.log.error('[AgentOrchestrator] Tracing list error', e);
          ctx.body = { data: [], meta: { count: 0 } };
        }

        await next();
      },

      /**
       * Get a single delegation log by ID.
       */
      async get(ctx, next) {
        const { filterByTk } = ctx.action.params;

        if (!filterByTk) {
          ctx.throw(400, 'id is required');
          return;
        }

        try {
          const repo = ctx.db.getRepository('orchestratorLogs');
          const log = await repo.findOne({
            filter: { id: filterByTk },
          });

          ctx.body = { data: log?.toJSON?.() || log || null };
        } catch (e) {
          ctx.log.error('[AgentOrchestrator] Tracing get error', e);
          ctx.body = { data: null };
        }

        await next();
      },
    },
  });

  // ACL: allow admin access to tracing endpoints
  app.acl.registerSnippet({
    name: `pm.${plugin.name}.tracing`,
    actions: ['orchestratorTracing:list', 'orchestratorTracing:get'],
  });
}
