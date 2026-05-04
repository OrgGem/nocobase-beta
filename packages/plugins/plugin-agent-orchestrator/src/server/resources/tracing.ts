import { Plugin } from '@nocobase/server';

function toPlain(row: any) {
  return row?.toJSON?.() || row;
}

function normalizeSpanFilter(filter: any = {}) {
  const next = { ...filter };
  if (next.subAgentUsername) {
    next.employeeUsername = next.subAgentUsername;
    delete next.subAgentUsername;
  }
  return next;
}

function spanTitle(row: any) {
  if (row.title) return row.title;
  if (row.type === 'sub_agent') return `${row.leaderUsername || '-'} -> ${row.employeeUsername || '-'}`;
  return row.toolName || row.type || 'span';
}

function formatSpanListRow(raw: any) {
  const row = toPlain(raw);
  const metadata = row.metadata || {};
  const input = row.input || {};
  return {
    id: row.id,
    rootRunId: row.rootRunId,
    parentSpanId: row.parentSpanId,
    type: row.type,
    leaderUsername: row.leaderUsername,
    subAgentUsername: row.employeeUsername,
    employeeUsername: row.employeeUsername,
    toolName: row.toolName,
    task: input.task || metadata.task || row.title || '',
    context: input.context || '',
    result: row.output,
    status: row.status,
    depth: metadata.depth ?? 0,
    durationMs: row.durationMs,
    error: row.error,
    userId: row.userId,
    createdAt: row.createdAt || row.startedAt,
    traceCount: metadata.traceCount || 0,
    messageCount: Array.isArray(metadata.messages) ? metadata.messages.length : metadata.messageCount || 0,
    hasUnifiedTrace: true,
  };
}

function buildSpanTree(rows: any[]) {
  const plainRows = rows.map(toPlain);
  const byId = new Map<string, any>();
  const roots: any[] = [];

  for (const row of plainRows) {
    const node = { ...row, children: [] };
    byId.set(String(row.id), node);
  }

  for (const row of byId.values()) {
    if (row.parentSpanId && byId.has(String(row.parentSpanId))) {
      byId.get(String(row.parentSpanId)).children.push(row);
    } else {
      roots.push(row);
    }
  }

  const sortTree = (items: any[]) => {
    items.sort(
      (a, b) =>
        new Date(a.startedAt || a.createdAt || 0).getTime() -
        new Date(b.startedAt || b.createdAt || 0).getTime(),
    );
    for (const item of items) sortTree(item.children || []);
  };
  sortTree(roots);
  return roots;
}

function flattenSpanTimeline(rows: any[]) {
  return rows
    .map(toPlain)
    .sort(
      (a, b) =>
        new Date(a.startedAt || a.createdAt || 0).getTime() -
        new Date(b.startedAt || b.createdAt || 0).getTime(),
    )
    .map((row) => {
      const input = row.input || {};
      const metadata = row.metadata || {};
      return {
        type: row.type,
        at: row.startedAt || row.createdAt,
        title: spanTitle(row),
        toolName: row.toolName,
        args: row.type === 'tool' || row.type === 'skill' ? input : undefined,
        status: row.status,
        content: row.output || row.error || input.task || metadata.summary || '',
        spanId: row.id,
        parentSpanId: row.parentSpanId,
        skillExecutionId: row.skillExecutionId,
      };
    });
}

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
        const { page = 1, pageSize = 50, sort = ['-createdAt'], filter = {} } = ctx.action.params;

        try {
          const spanRepo = ctx.db.getRepository('agentExecutionSpans');
          if (spanRepo) {
            const spanFilter = {
              ...normalizeSpanFilter(filter),
              parentSpanId: null,
              type: 'sub_agent',
            };
            const [spanRows, spanCount] = await spanRepo.findAndCount({
              filter: spanFilter,
              sort,
              offset: (Number(page) - 1) * Number(pageSize),
              limit: Number(pageSize),
            });

            if (spanCount > 0) {
              ctx.body = {
                data: spanRows.map(formatSpanListRow),
                meta: {
                  count: spanCount,
                  page: Number(page),
                  pageSize: Number(pageSize),
                  totalPage: Math.ceil(spanCount / Number(pageSize)),
                },
              };
              await next();
              return;
            }
          }

          const repo = ctx.db.getRepository('orchestratorLogs');
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
              hasUnifiedTrace: false,
            })),
            meta: {
              count,
              page: Number(page),
              pageSize: Number(pageSize),
              totalPage: Math.ceil(count / Number(pageSize)),
            },
          };
        } catch (e: any) {
          // Bubble up so the admin sees an error toast instead of an empty grid.
          ctx.log.error('[AgentOrchestrator] Tracing list error', e);
          ctx.throw(500, e?.message || 'Failed to load tracing logs');
        }

        await next();
      },

      /**
       * Get a single delegation log by ID.
       */
      async get(ctx, next) {
        const { filterByTk, source } = ctx.action.params;

        if (!filterByTk) {
          ctx.throw(400, 'id is required');
          return;
        }

        try {
          const spanRepo = ctx.db.getRepository('agentExecutionSpans');
          if (spanRepo && source !== 'log') {
            const span = await spanRepo.findOne({
              filter: { id: filterByTk },
            });

            if (span) {
              const plainSpan = toPlain(span);
              const rows = await spanRepo.find({
                filter: { rootRunId: plainSpan.rootRunId },
                sort: ['createdAt'],
              });
              const tree = buildSpanTree(rows);
              const timeline = flattenSpanTimeline(rows);
              const rootRow = formatSpanListRow(plainSpan);
              const metadata = plainSpan.metadata || {};

              ctx.body = {
                data: {
                  ...rootRow,
                  input: plainSpan.input,
                  output: plainSpan.output,
                  metadata,
                  trace: timeline,
                  messages: metadata.messages || [],
                  children: tree,
                },
              };
              await next();
              return;
            }
          }

          const repo = ctx.db.getRepository('orchestratorLogs');
          const log =
            source === 'span'
              ? null
              : await repo.findOne({
                  filter: { id: filterByTk },
                });

          const plainLog = log?.toJSON?.() || log;
          ctx.body = { data: plainLog ? { ...plainLog, hasUnifiedTrace: false } : null };
        } catch (e: any) {
          ctx.log.error('[AgentOrchestrator] Tracing get error', e);
          ctx.throw(500, e?.message || 'Failed to load tracing log');
        }

        await next();
      },
    },
  });

  // ACL: access is granted by the parent plugin's snippet (pm.plugin-agent-orchestrator → orchestratorTracing:*)
}
