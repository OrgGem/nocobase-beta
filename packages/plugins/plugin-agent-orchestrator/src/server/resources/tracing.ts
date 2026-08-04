import type { Plugin } from '@nocobase/server';
import { LoopRunAccessError, LoopRunRepository } from '../services/LoopRunRepository';
import { requestActor, throwResourceError } from './resource-helpers';

type TraceRecord = Record<string, unknown>;

function plainRecord(raw: unknown): TraceRecord {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as { toJSON?: () => TraceRecord };
  return typeof record.toJSON === 'function' ? record.toJSON() : (raw as TraceRecord);
}

function normalizeSpanFilter(filter: Record<string, unknown> = {}) {
  const next = { ...filter };
  if (next.subAgentUsername) {
    next.employeeUsername = next.subAgentUsername;
    delete next.subAgentUsername;
  }
  return next;
}

function mergeFilter(filter: Record<string, unknown>, required: Record<string, unknown>) {
  return Object.keys(filter).length > 0 ? { $and: [filter, required] } : required;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function positiveId(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function spanTitle(row: TraceRecord) {
  if (typeof row.title === 'string' && row.title) return row.title;
  if (row.type === 'sub_agent') return `${String(row.leaderUsername || '-')} -> ${String(row.employeeUsername || '-')}`;
  return String(row.toolName || row.type || 'span');
}

function formatSpanListRow(raw: unknown) {
  const row = plainRecord(raw);
  const metadata = asObject(row.metadata);
  const input = asObject(row.input);
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

function buildSpanTree(rows: unknown[]) {
  const byId = new Map<string, TraceRecord & { children: TraceRecord[] }>();
  const roots: Array<TraceRecord & { children: TraceRecord[] }> = [];

  for (const raw of rows) {
    const row = plainRecord(raw);
    byId.set(String(row.id), { ...row, children: [] });
  }

  for (const row of byId.values()) {
    const parent = row.parentSpanId ? byId.get(String(row.parentSpanId)) : undefined;
    if (parent) parent.children.push(row);
    else roots.push(row);
  }

  const sortTree = (items: Array<TraceRecord & { children: TraceRecord[] }>) => {
    items.sort(
      (left, right) =>
        new Date(String(left.startedAt || left.createdAt || 0)).getTime() -
        new Date(String(right.startedAt || right.createdAt || 0)).getTime(),
    );
    for (const item of items) sortTree(item.children as Array<TraceRecord & { children: TraceRecord[] }>);
  };
  sortTree(roots);
  return roots;
}

function flattenSpanTimeline(rows: unknown[]) {
  return rows
    .map(plainRecord)
    .sort(
      (left, right) =>
        new Date(String(left.startedAt || left.createdAt || 0)).getTime() -
        new Date(String(right.startedAt || right.createdAt || 0)).getTime(),
    )
    .map((row) => {
      const input = asObject(row.input);
      const metadata = asObject(row.metadata);
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

export function registerTracingResource(plugin: Plugin) {
  const runs = new LoopRunRepository(plugin.db);

  plugin.app.resource({
    name: 'orchestratorTracing',
    actions: {
      async list(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const { page = 1, pageSize = 50, sort = ['-createdAt'], filter = {} } = ctx.action.params;
          const ownedRunIds = actor.isAdmin ? [] : await runs.listOwnedRunIds(actor.userId, false);
          const spanAccess = actor.isAdmin
            ? {}
            : {
                $or: [
                  { agentLoopRunId: { $in: ownedRunIds.length > 0 ? ownedRunIds : [-1] } },
                  { agentLoopRunId: null, userId: actor.userId },
                ],
              };
          const spanFilter = mergeFilter(
            { ...normalizeSpanFilter(filter), parentSpanId: null, type: 'sub_agent' },
            spanAccess,
          );
          const spanRepo = ctx.db.getRepository('agentExecutionSpans');
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

          const logFilter = actor.isAdmin ? filter : mergeFilter(filter, { userId: actor.userId });
          const [rows, count] = await ctx.db.getRepository('orchestratorLogs').findAndCount({
            filter: logFilter,
            sort,
            offset: (Number(page) - 1) * Number(pageSize),
            limit: Number(pageSize),
          });

          ctx.body = {
            data: rows.map((raw) => {
              const row = plainRecord(raw);
              return {
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
                traceCount: asArray(row.trace).length,
                messageCount: asArray(row.messages).length,
                hasUnifiedTrace: false,
              };
            }),
            meta: {
              count,
              page: Number(page),
              pageSize: Number(pageSize),
              totalPage: Math.ceil(count / Number(pageSize)),
            },
          };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },

      async get(ctx, next) {
        try {
          const actor = requestActor(ctx);
          const { filterByTk, source } = ctx.action.params;
          if (!filterByTk) ctx.throw(400, 'id is required');

          const spanRepo = ctx.db.getRepository('agentExecutionSpans');
          if (source !== 'log') {
            const span = await spanRepo.findOne({ filterByTk });
            if (span) {
              const plainSpan = plainRecord(span);
              const runId = positiveId(plainSpan.agentLoopRunId);
              if (runId) await runs.requireOwnedRun(runId, actor.userId, actor.isAdmin);
              else if (!actor.isAdmin && Number(plainSpan.userId) !== actor.userId) {
                throw new LoopRunAccessError(403, 'You cannot access this execution trace.');
              }

              const rows = await spanRepo.find({
                filter: { rootRunId: plainSpan.rootRunId },
                sort: ['createdAt'],
              });
              const metadata = asObject(plainSpan.metadata);
              ctx.body = {
                data: {
                  ...formatSpanListRow(plainSpan),
                  input: plainSpan.input,
                  output: plainSpan.output,
                  metadata,
                  trace: flattenSpanTimeline(rows),
                  messages: asArray(metadata.messages),
                  children: buildSpanTree(rows),
                },
              };
              await next();
              return;
            }
          }

          const log = source === 'span' ? null : await ctx.db.getRepository('orchestratorLogs').findOne({ filterByTk });
          if (!log) throw new LoopRunAccessError(404, `Execution trace ${String(filterByTk)} was not found.`);
          const plainLog = plainRecord(log);
          if (!actor.isAdmin && Number(plainLog.userId) !== actor.userId) {
            throw new LoopRunAccessError(403, 'You cannot access this execution trace.');
          }
          ctx.body = { data: { ...plainLog, hasUnifiedTrace: false } };
        } catch (error) {
          throwResourceError(ctx, error);
        }
        await next();
      },
    },
  });
}
