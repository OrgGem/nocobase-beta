import type { Plugin } from '@nocobase/server';
import { asObject, currentUserId, isAdminUser, toPlain, trimText } from '../utils/ctx-utils';
import { makeNativeRunId, NATIVE_SOURCE } from '../services/NativeSubAgentObserver';

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function readValue(record: unknown, key: string) {
  const model = record as { get?: (name: string) => unknown; [key: string]: unknown };
  return typeof model?.get === 'function' ? model.get(key) : model?.[key];
}

function isAdmin(ctx: unknown) {
  const context = ctx as { state?: { currentRoles?: string[] } };
  if (isAdminUser(ctx)) return true;
  const roles = context?.state?.currentRoles;
  return Array.isArray(roles) && roles.some((role) => role === 'root' || role === 'admin');
}

function statusFromNative(status: unknown) {
  if (status === 'completed' || status === 'done' || status === 'success') return 'success';
  if (status === 'error' || status === 'failed') return 'error';
  return 'running';
}

function formatDuration(ms: unknown) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function formatSpanListRow(raw: unknown) {
  const row = toPlain(raw);
  const input = asObject(row?.input);
  const metadata = asObject(row?.metadata);
  return {
    id: row?.id,
    rootRunId: row?.rootRunId,
    source: row?.source || metadata.source,
    parentSessionId: row?.parentSessionId || metadata.parentSessionId,
    subSessionId: row?.subSessionId || metadata.subSessionId,
    toolCallId: row?.toolCallId || metadata.toolCallId,
    leaderUsername: row?.leaderUsername,
    employeeUsername: row?.employeeUsername,
    subAgentUsername: row?.employeeUsername,
    toolName: row?.toolName || 'dispatch-sub-agent-task',
    task: input.question || input.task || row?.title || '',
    status: row?.status,
    durationMs: row?.durationMs,
    error: row?.error,
    userId: row?.userId,
    memoryContextApplied: Boolean(metadata.memoryContextApplied),
    memoryScopes: metadata.memoryScopes || [],
    harnessTag: metadata.harnessTag || 'default',
    createdAt: row?.createdAt || row?.startedAt,
    startedAt: row?.startedAt,
    endedAt: row?.endedAt,
  };
}

function buildSpanTree(rows: unknown[]) {
  const byId = new Map<string, Record<string, unknown> & { children: unknown[] }>();
  const roots: Array<Record<string, unknown> & { children: unknown[] }> = [];

  for (const raw of rows) {
    const row = toPlain(raw);
    byId.set(String(row.id), { ...row, children: [] });
  }

  for (const row of byId.values()) {
    const parentSpanId = normalizeString(row.parentSpanId);
    if (parentSpanId && byId.has(parentSpanId)) {
      byId.get(parentSpanId)?.children.push(row);
    } else {
      roots.push(row);
    }
  }

  const sort = (items: Array<Record<string, unknown> & { children: unknown[] }>) => {
    items.sort(
      (a, b) =>
        new Date(String(a.startedAt || a.createdAt || 0)).getTime() -
        new Date(String(b.startedAt || b.createdAt || 0)).getTime(),
    );
    for (const item of items) sort(item.children as Array<Record<string, unknown> & { children: unknown[] }>);
  };
  sort(roots);
  return roots;
}

function flattenTimeline(rows: unknown[]) {
  return rows
    .map(toPlain)
    .sort(
      (a, b) =>
        new Date(String(a.startedAt || a.createdAt || 0)).getTime() -
        new Date(String(b.startedAt || b.createdAt || 0)).getTime(),
    )
    .map((row) => ({
      id: row.id,
      type: row.type,
      at: row.startedAt || row.createdAt,
      title: row.title || row.toolName || row.type,
      toolName: row.toolName,
      status: row.status,
      durationMs: row.durationMs,
      content: row.output || row.error || asObject(row.input).question || '',
      parentSpanId: row.parentSpanId,
      input: row.input,
      output: row.output,
      error: row.error,
    }));
}

async function findConversation(ctx: any, sessionId?: string) {
  if (!sessionId) return null;
  try {
    return toPlain(
      await ctx.db.getRepository('aiConversations').findOne({
        filter: { sessionId },
      }),
    );
  } catch {
    return null;
  }
}

async function findToolMessages(ctx: any, sessionIds: string[]) {
  const repo = ctx.db.getRepository('aiToolMessages');
  const rows: unknown[] = [];
  for (const sessionId of Array.from(new Set(sessionIds.filter(Boolean)))) {
    try {
      const list = await repo.find({
        filter: { sessionId },
        sort: ['messageId', 'id'],
      });
      rows.push(...list);
    } catch {
      // Keep monitor read-only and best-effort across plugin-ai versions.
    }
  }
  return rows.map(toPlain);
}

async function findNativeMessages(ctx: any, parentSessionId?: string, subSessionId?: string) {
  const repo = ctx.db.getRepository('aiMessages');
  const rows: unknown[] = [];
  for (const sessionId of [parentSessionId, subSessionId].filter(Boolean)) {
    try {
      const list = await repo.find({
        filter: { sessionId },
        sort: ['messageId'],
        limit: 200,
      });
      rows.push(...list);
    } catch {
      // Optional native details only.
    }
  }
  return rows.map(toPlain);
}

async function backfillFromMetadata(ctx: any, spanRepo: any, limit: number) {
  const messageRepo = ctx.db.getRepository('aiMessages');
  const toolRepo = ctx.db.getRepository('aiToolMessages');
  const conversationRepo = ctx.db.getRepository('aiConversations');
  const messages = await messageRepo.find({
    sort: ['-messageId'],
    limit,
  });
  let created = 0;
  let skipped = 0;

  for (const rawMessage of messages) {
    const message = toPlain(rawMessage);
    const conversations = asObject(message.metadata).subAgentConversations;
    if (!Array.isArray(conversations)) continue;

    for (const item of conversations) {
      const subSessionId = normalizeString(item?.sessionId);
      const toolCallId = normalizeString(item?.toolCallId);
      if (!subSessionId || !toolCallId) {
        skipped += 1;
        continue;
      }

      const existing = await spanRepo.findOne({
        filter: {
          source: NATIVE_SOURCE,
          subSessionId,
          toolCallId,
          type: 'sub_agent',
        },
      });
      if (existing) {
        skipped += 1;
        continue;
      }

      const toolMessage = toPlain(
        await toolRepo.findOne({
          filter: { toolCallId },
        }),
      );
      const parentSessionId = normalizeString(toolMessage?.sessionId) || normalizeString(message.sessionId);
      const parentConversation = parentSessionId
        ? toPlain(await conversationRepo.findOne({ filter: { sessionId: parentSessionId } }))
        : null;
      const subConversation = toPlain(await conversationRepo.findOne({ filter: { sessionId: subSessionId } }));
      const invokeStart = Number(toolMessage?.invokeStartTime);
      const invokeEnd = Number(toolMessage?.invokeEndTime);
      const durationMs =
        Number.isFinite(invokeStart) && Number.isFinite(invokeEnd) && invokeEnd >= invokeStart
          ? invokeEnd - invokeStart
          : undefined;
      const rootRunId = makeNativeRunId([
        parentSessionId,
        subSessionId,
        toolCallId,
        subConversation?.aiEmployeeUsername,
      ]);
      const content = asObject(toolMessage?.content);

      await spanRepo.create({
        values: {
          rootRunId,
          parentSpanId: null,
          source: NATIVE_SOURCE,
          parentSessionId,
          subSessionId,
          toolCallId,
          type: 'sub_agent',
          status: statusFromNative(item?.status || toolMessage?.status),
          leaderUsername: parentConversation?.aiEmployeeUsername,
          employeeUsername: subConversation?.aiEmployeeUsername,
          toolName: 'dispatch-sub-agent-task',
          title:
            subConversation?.title ||
            `${parentConversation?.aiEmployeeUsername || 'main'} -> ${
              subConversation?.aiEmployeeUsername || 'sub-agent'
            }`,
          input: {
            question: subConversation?.title,
            parentSessionId,
            subSessionId,
          },
          output: trimText(content.answer || toolMessage?.content, 20000),
          durationMs: formatDuration(durationMs),
          startedAt: invokeStart ? new Date(invokeStart) : new Date(),
          endedAt: invokeEnd ? new Date(invokeEnd) : undefined,
          metadata: {
            source: NATIVE_SOURCE,
            backfilled: true,
            messageId: message.messageId,
            toolMessageId: toolMessage?.id,
            nativeStatus: item?.status,
          },
          userId: parentConversation?.userId || subConversation?.userId,
          createdAt: new Date(),
        },
      });
      created += 1;
    }
  }

  return { created, skipped };
}

async function backfillFromToolMessages(ctx: any, spanRepo: any, limit: number) {
  const toolRepo = ctx.db.getRepository('aiToolMessages');
  const toolMessages = await toolRepo.find({
    filter: { toolName: 'dispatch-sub-agent-task' },
    sort: ['-id'],
    limit,
  });
  let created = 0;
  let skipped = 0;

  for (const rawToolMessage of toolMessages) {
    const toolMessage = toPlain(rawToolMessage);
    const content = asObject(toolMessage.content);
    const subSessionId = normalizeString(content.sessionId);
    const toolCallId = normalizeString(toolMessage.toolCallId);
    if (!subSessionId || !toolCallId) {
      skipped += 1;
      continue;
    }

    const existing = await spanRepo.findOne({
      filter: {
        source: NATIVE_SOURCE,
        subSessionId,
        toolCallId,
        type: 'sub_agent',
      },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const parentSessionId = normalizeString(toolMessage.sessionId);
    const parentConversation = await findConversation(ctx, parentSessionId);
    const subConversation = await findConversation(ctx, subSessionId);
    const invokeStart = Number(toolMessage.invokeStartTime);
    const invokeEnd = Number(toolMessage.invokeEndTime);
    const rootRunId = makeNativeRunId([parentSessionId, subSessionId, toolCallId, subConversation?.aiEmployeeUsername]);

    await spanRepo.create({
      values: {
        rootRunId,
        parentSpanId: null,
        source: NATIVE_SOURCE,
        parentSessionId,
        subSessionId,
        toolCallId,
        type: 'sub_agent',
        status: statusFromNative(toolMessage.status),
        leaderUsername: parentConversation?.aiEmployeeUsername,
        employeeUsername: subConversation?.aiEmployeeUsername,
        toolName: 'dispatch-sub-agent-task',
        title:
          subConversation?.title ||
          `${parentConversation?.aiEmployeeUsername || 'main'} -> ${
            subConversation?.aiEmployeeUsername || 'sub-agent'
          }`,
        input: {
          question: subConversation?.title,
          parentSessionId,
          subSessionId,
        },
        output: trimText(content.answer || toolMessage.content, 20000),
        durationMs:
          Number.isFinite(invokeStart) && Number.isFinite(invokeEnd) && invokeEnd >= invokeStart
            ? invokeEnd - invokeStart
            : undefined,
        startedAt: invokeStart ? new Date(invokeStart) : new Date(),
        endedAt: invokeEnd ? new Date(invokeEnd) : undefined,
        metadata: {
          source: NATIVE_SOURCE,
          backfilled: true,
          toolMessageId: toolMessage.id,
        },
        userId: parentConversation?.userId || subConversation?.userId,
        createdAt: new Date(),
      },
    });
    created += 1;
  }

  return { created, skipped };
}

export function registerAgentMonitorResource(plugin: Plugin) {
  plugin.app.resource({
    name: 'agentMonitor',
    actions: {
      async list(ctx, next) {
        const { page = 1, pageSize = 20, sort = ['-createdAt'], filter = {} } = ctx.action.params;
        const requestedFilter = asObject(filter);
        const spanFilter: Record<string, unknown> = {
          source: NATIVE_SOURCE,
          type: 'sub_agent',
          parentSpanId: null,
        };

        for (const key of [
          'leaderUsername',
          'employeeUsername',
          'status',
          'parentSessionId',
          'subSessionId',
          'toolCallId',
        ]) {
          if (requestedFilter[key]) spanFilter[key] = requestedFilter[key];
        }
        if (requestedFilter.subAgentUsername) spanFilter.employeeUsername = requestedFilter.subAgentUsername;
        if (requestedFilter.sessionId) spanFilter.parentSessionId = requestedFilter.sessionId;

        if (!isAdmin(ctx)) {
          const userId = currentUserId(ctx);
          if (!userId) ctx.throw(401, 'Not authenticated');
          spanFilter.userId = userId;
        } else if (requestedFilter.userId) {
          spanFilter.userId = requestedFilter.userId;
        }

        const repo = ctx.db.getRepository('agentExecutionSpans');
        const [rows, count] = await repo.findAndCount({
          filter: spanFilter,
          sort,
          offset: (Number(page) - 1) * Number(pageSize),
          limit: Number(pageSize),
        });

        ctx.body = {
          data: rows.map(formatSpanListRow),
          meta: {
            count,
            page: Number(page),
            pageSize: Number(pageSize),
            totalPage: Math.ceil(count / Number(pageSize)),
          },
        };
        await next();
      },

      async get(ctx, next) {
        const { filterByTk } = ctx.action.params;
        if (!filterByTk) {
          ctx.throw(400, 'span id is required');
          return;
        }

        const repo = ctx.db.getRepository('agentExecutionSpans');
        const span = toPlain(
          await repo.findOne({
            filter: { id: filterByTk },
          }),
        );
        if (!span) {
          ctx.throw(404, 'span not found');
          return;
        }

        if (!isAdmin(ctx) && String(span.userId || '') !== String(currentUserId(ctx) || '')) {
          ctx.throw(403, 'You cannot view this agent run.');
          return;
        }

        const rows = await repo.find({
          filter: { rootRunId: span.rootRunId },
          sort: ['createdAt'],
        });
        const parentSessionId = normalizeString(span.parentSessionId || asObject(span.metadata).parentSessionId);
        const subSessionId = normalizeString(span.subSessionId || asObject(span.metadata).subSessionId);

        ctx.body = {
          data: {
            ...formatSpanListRow(span),
            input: span.input,
            output: span.output,
            metadata: span.metadata || {},
            children: buildSpanTree(rows),
            trace: flattenTimeline(rows),
            nativeConversations: {
              parent: await findConversation(ctx, parentSessionId),
              subAgent: await findConversation(ctx, subSessionId),
            },
            nativeMessages: await findNativeMessages(ctx, parentSessionId, subSessionId),
            toolMessages: await findToolMessages(ctx, [parentSessionId, subSessionId]),
          },
        };
        await next();
      },

      async sync(ctx, next) {
        if (!isAdmin(ctx)) {
          ctx.throw(403, 'Admin role is required to sync native agent monitor spans.');
          return;
        }

        const values = asObject(ctx.action.params?.values);
        const limit = Math.min(Math.max(Number(values.limit || ctx.action.params?.limit || 200), 1), 1000);
        const spanRepo = ctx.db.getRepository('agentExecutionSpans');
        const metadataResult = await backfillFromMetadata(ctx, spanRepo, limit);
        const toolResult = await backfillFromToolMessages(ctx, spanRepo, limit);

        ctx.body = {
          data: {
            created: metadataResult.created + toolResult.created,
            skipped: metadataResult.skipped + toolResult.skipped,
            metadata: metadataResult,
            toolMessages: toolResult,
          },
        };
        await next();
      },
    },
  });
}
