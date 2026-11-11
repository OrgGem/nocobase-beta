/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Plugin } from '@nocobase/server';
import { Op, Sequelize } from 'sequelize';
import { asObject, currentUserId, isAdminUser, toPlain } from '../utils/ctx-utils';
import { NATIVE_SOURCE } from '../services/NativeSubAgentObserver';
import { NativeAgentMonitorSyncService } from '../services/NativeAgentMonitorSyncService';
import { safeNativeSpan, selectNativeSubtree, summarizeNativeUsage } from './native-monitor-format';

const MAX_DETAIL_SPANS = 5000;
const MAX_FILTER_DEPTH = 32;
type QueryGenerator = {
  quoteIdentifier: (value: string) => string;
  quoteTable: (value: unknown) => string;
  escape: (value: string | number) => string;
};

function isAdmin(ctx: unknown) {
  if (isAdminUser(ctx)) return true;
  const roles = (ctx as { state?: { currentRoles?: unknown } })?.state?.currentRoles;
  return Array.isArray(roles) && roles.some((role) => role === 'root' || role === 'admin');
}

function formatSpanListRow(raw: unknown) {
  const row = safeNativeSpan(raw);
  return {
    ...row,
    subAgentUsername: row.employeeUsername,
    task: row.title,
    createdAt: row.startedAt || row.createdAt,
  };
}

function buildSpanTree(rows: Record<string, unknown>[]) {
  const byId = new Map<string, Record<string, unknown> & { children: unknown[] }>();
  const roots: Array<Record<string, unknown> & { children: unknown[] }> = [];
  for (const row of rows) byId.set(String(row.id), { ...row, children: [] });
  for (const row of byId.values()) {
    const parent = row.parentSpanId ? byId.get(String(row.parentSpanId)) : undefined;
    if (parent) parent.children.push(row);
    else roots.push(row);
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

function flattenTimeline(rows: Record<string, unknown>[]) {
  return rows
    .slice()
    .sort(
      (a, b) =>
        new Date(String(a.startedAt || a.createdAt || 0)).getTime() -
        new Date(String(b.startedAt || b.createdAt || 0)).getTime(),
    )
    .map((row) => ({ ...row, at: row.startedAt || row.createdAt }));
}

export function registerAgentMonitorResource(plugin: Plugin) {
  const sync = new NativeAgentMonitorSyncService(plugin);
  plugin.app.resource({
    name: 'agentMonitor',
    actions: {
      async list(ctx, next) {
        const { page = 1, pageSize = 20, sort = ['-startedAt'], filter = {} } = ctx.action?.params || {};
        const requestedFilter = asObject(filter);
        const spanFilter: Record<string, unknown> = {
          source: NATIVE_SOURCE,
          type: { [Op.in]: ['main_agent', 'sub_agent'] },
          parentSpanId: null,
        };
        for (const key of ['leaderUsername', 'parentSessionId']) {
          if (requestedFilter[key]) spanFilter[key] = requestedFilter[key];
        }
        if (requestedFilter.sessionId) spanFilter.parentSessionId = requestedFilter.sessionId;
        const admin = isAdmin(ctx);
        if (!admin) {
          const userId = currentUserId(ctx);
          if (!userId) ctx.throw(401, 'Not authenticated');
          spanFilter.userId = userId;
        } else if (requestedFilter.userId) {
          spanFilter.userId = requestedFilter.userId;
        }
        const currentPage = Math.max(1, Math.trunc(Number(page) || 1));
        const size = Math.min(100, Math.max(1, Math.trunc(Number(pageSize) || 20)));
        const repo = ctx.db.getRepository('agentExecutionSpans');
        const childFilter: Record<string, unknown> = {};
        for (const key of ['status', 'subSessionId', 'toolCallId', 'toolName']) {
          if (requestedFilter[key]) childFilter[key] = requestedFilter[key];
        }
        if (requestedFilter.subAgentUsername || requestedFilter.employeeUsername) {
          childFilter.employeeUsername = requestedFilter.subAgentUsername || requestedFilter.employeeUsername;
          childFilter.type = 'sub_agent';
        }
        if (Object.keys(childFilter).length) {
          // Legacy sessions can share a rootRunId. Follow parentSpanId from each accessible
          // root so a matching sibling session cannot cause a false positive.
          const model = repo.model;
          const query = ctx.db.sequelize.getQueryInterface().queryGenerator as unknown as QueryGenerator;
          const column = (alias: string, name: string) =>
            `${alias}.${query.quoteIdentifier(model.rawAttributes[name]?.field || name)}`;
          const predicate = (alias: string, [name, value]: [string, unknown]) => {
            if (typeof value !== 'string' && typeof value !== 'number') ctx.throw(400, 'Invalid monitor filter value.');
            return `${column(alias, name)} = ${query.escape(value as string | number)}`;
          };
          const table = query.quoteTable(model.getTableName());
          const roots = [
            predicate('monitor_root', ['source', NATIVE_SOURCE]),
            `${column('monitor_root', 'type')} IN (${query.escape('main_agent')}, ${query.escape('sub_agent')})`,
            `${column('monitor_root', 'parentSpanId')} IS NULL`,
            ...['userId', 'leaderUsername', 'parentSessionId']
              .filter((key) => spanFilter[key] !== undefined)
              .map((key) => predicate('monitor_root', [key, spanFilter[key]])),
          ];
          const matches = Object.entries(childFilter).map((entry) => predicate('monitor_match', entry));
          const owner = admin ? '' : ` AND ${predicate('monitor_child', ['userId', spanFilter.userId])}`;
          const castType = ['mysql', 'mariadb'].includes(ctx.db.sequelize.getDialect()) ? 'CHAR' : 'TEXT';
          const sql = `(WITH RECURSIVE monitor_tree(root_id, span_id, depth) AS (
            SELECT ${column('monitor_root', 'id')}, ${column('monitor_root', 'id')}, 0
            FROM ${table} AS monitor_root WHERE ${roots.join(' AND ')}
            UNION ALL
            SELECT monitor_tree.root_id, ${column('monitor_child', 'id')}, monitor_tree.depth + 1
            FROM ${table} AS monitor_child JOIN monitor_tree
              ON ${column('monitor_child', 'parentSpanId')} = CAST(monitor_tree.span_id AS ${castType})
            WHERE monitor_tree.depth < ${MAX_FILTER_DEPTH}${owner}
          ) SELECT DISTINCT monitor_tree.root_id FROM monitor_tree
            JOIN ${table} AS monitor_match ON ${column('monitor_match', 'id')} = monitor_tree.span_id
            WHERE ${matches.join(' AND ')})`;
          spanFilter.id = { [Op.in]: Sequelize.literal(sql) };
        }
        const [rows, count] = await repo.findAndCount({
          where: spanFilter,
          sort,
          offset: (currentPage - 1) * size,
          limit: size,
        });
        ctx.body = {
          data: rows.map(formatSpanListRow),
          meta: {
            count,
            page: currentPage,
            pageSize: size,
            totalPage: Math.ceil(count / size),
            ...(Object.keys(childFilter).length ? { filterDepthLimit: MAX_FILTER_DEPTH } : {}),
          },
        };
        await next();
      },
      async get(ctx, next) {
        const { filterByTk } = ctx.action?.params || {};
        if (!filterByTk) ctx.throw(400, 'span id is required');
        const repo = ctx.db.getRepository('agentExecutionSpans');
        const span = toPlain(await repo.findOne({ filter: { id: filterByTk, source: NATIVE_SOURCE } }));
        if (!span) ctx.throw(404, 'span not found');
        const userId = currentUserId(ctx);
        if (!isAdmin(ctx) && (!userId || String(span.userId || '') !== String(userId))) {
          ctx.throw(403, 'You cannot view this agent run.');
        }
        const filter = isAdmin(ctx) ? { rootRunId: span.rootRunId } : { rootRunId: span.rootRunId, userId };
        const rawRows = await repo.find({ filter, sort: ['createdAt'], limit: MAX_DETAIL_SPANS + 1 });
        const truncated = rawRows.length > MAX_DETAIL_SPANS;
        const rows = selectNativeSubtree(rawRows.slice(0, MAX_DETAIL_SPANS), span).map(safeNativeSpan);
        const usage = summarizeNativeUsage(rows);
        ctx.body = {
          data: {
            ...formatSpanListRow(span),
            children: buildSpanTree(rows),
            trace: flattenTimeline(rows),
            usage: truncated ? { ...usage, inputTokens: null, outputTokens: null, cost: null } : usage,
            coverage: {
              granularity: 'session',
              contentCapture: 'omitted-without-invocation-policy-snapshot',
              truncated,
            },
            // Keep response keys compatible without exposing native content or bypassing native ACL.
            nativeConversations: { parent: null, subAgent: null },
            nativeMessages: [],
            toolMessages: [],
          },
        };
        await next();
      },
      async sync(ctx, next) {
        if (!isAdmin(ctx)) ctx.throw(403, 'Admin role is required to sync native agent monitor spans.');
        const values = asObject(ctx.action?.params?.values || ctx.request?.body);
        try {
          ctx.body = await sync.sync({
            limit: Number(values.limit || ctx.action?.params?.limit || 200),
            cursor: values.cursor,
          });
        } catch (error) {
          if (error instanceof Error && /^(Invalid|Unsupported) native monitor cursor/.test(error.message)) {
            ctx.throw(400, error.message);
          }
          throw error;
        }
        await next();
      },
    },
  });
}
