/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database } from '@nocobase/database';
import type { Plugin } from '@nocobase/server';
import { Op, cast, col, fn, literal, where as sqlWhere } from 'sequelize';
import type { GroupOption, ProjectionAlias, WhereOptions } from 'sequelize';
import { isAdminUser } from '../utils/ctx-utils';

type Values = Record<string, unknown>;
type AggregateRow = Record<string, unknown>;
type QueryGenerator = {
  quoteIdentifier: (value: string) => string;
  quoteTable: (value: unknown) => string;
};

const MAX_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const DIMENSIONS = ['provider', 'llmService', 'model', 'employeeUsername', 'userId', 'departmentId'] as const;
type Dimension = (typeof DIMENSIONS)[number];

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tokenTotal(value: unknown) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const integer = BigInt(value);
    return integer > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
  }
  return numberOrNull(value);
}

function hasValue(value: unknown) {
  return value !== undefined && value !== null && value !== '';
}

function validateDate(value: unknown): Date | undefined {
  if (!hasValue(value)) return undefined;
  if (typeof value !== 'string') throw new Error('INVALID_FILTER');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_FILTER');
  return date;
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  if (!hasValue(value)) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error('INVALID_FILTER');
  return number;
}

function identifier(value: unknown) {
  if (!hasValue(value)) return undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,18}$/.test(String(value))) {
    throw new Error('INVALID_FILTER');
  }
  return String(value);
}

function textFilter(value: unknown) {
  if (!hasValue(value)) return undefined;
  if (typeof value !== 'string' || value.length > 255) throw new Error('INVALID_FILTER');
  return value;
}

function boolFilter(value: unknown) {
  if (!hasValue(value) || value === false || value === 'false' || value === '0') return false;
  if (value === true || value === 'true' || value === '1') return true;
  throw new Error('INVALID_FILTER');
}

/** Build SQL only from model metadata and fixed identifiers. Request values remain bound conditions. */
function departmentExpressions(db: Database, infer: boolean) {
  const spans = db.getCollection('agentExecutionSpans').model;
  const query = db.sequelize.getQueryInterface().queryGenerator as unknown as QueryGenerator;
  const quote = (name: string) => query.quoteIdentifier(name);
  const field = (model: typeof spans, name: string) => quote(model.rawAttributes[name]?.field || name);
  const span = quote(spans.name);
  const stored = `${span}.${field(spans, 'departmentId')}`;
  const storedAttribution = `${span}.${field(spans, 'departmentAttribution')}`;
  const users = db.hasCollection('users') ? db.getCollection('users').model : undefined;
  const memberships = db.hasCollection('departmentsUsers') ? db.getCollection('departmentsUsers').model : undefined;
  const inferenceAvailable = Boolean(
    users?.rawAttributes.mainDepartmentId &&
      memberships?.rawAttributes.userId &&
      memberships?.rawAttributes.departmentId,
  );
  let inferred = 'NULL';
  if (infer && inferenceAvailable && users && memberships) {
    const userTable = query.quoteTable(users.getTableName());
    const membershipTable = query.quoteTable(memberships.getTableName());
    const userId = field(users, 'id');
    const mainDepartmentId = field(users, 'mainDepartmentId');
    const membershipUserId = field(memberships, 'userId');
    const membershipDepartmentId = field(memberships, 'departmentId');
    inferred =
      `(SELECT report_user.${mainDepartmentId} FROM ${userTable} AS report_user ` +
      `INNER JOIN ${membershipTable} AS report_member ON report_member.${membershipUserId} = report_user.${userId} ` +
      `AND report_member.${membershipDepartmentId} = report_user.${mainDepartmentId} ` +
      `WHERE report_user.${userId} = ${span}.${field(spans, 'userId')} LIMIT 1)`;
  }
  const id = `COALESCE(${stored}, ${inferred})`;
  const castType = ['mysql', 'mariadb'].includes(db.sequelize.getDialect()) ? 'CHAR' : 'TEXT';
  const attribution =
    `CASE WHEN ${stored} IS NOT NULL THEN COALESCE(${storedAttribution}, 'unknown') ` +
    `WHEN ${inferred} IS NOT NULL THEN 'inferred' ELSE 'unknown' END`;
  return {
    id: literal(id),
    idText: literal(`CAST(${id} AS ${castType})`),
    attribution: literal(attribution),
    attributionSql: attribution,
    inferenceAvailable,
  };
}

function reportQuery(db: Database, params: Values) {
  const to = validateDate(params.to) || new Date();
  const from = validateDate(params.from) || new Date(to.getTime() - DEFAULT_INTERVAL_MS);
  if (from >= to || to.getTime() - from.getTime() > MAX_INTERVAL_MS) throw new Error('INVALID_FILTER');
  const page = positiveInteger(params.page, 1, 100_000);
  const pageSize = positiveInteger(params.pageSize, 20, 100);
  const infer = boolFilter(params.includeInferredDepartment);
  const department = departmentExpressions(db, infer);
  const model = db.getCollection('agentExecutionSpans').model;
  const column = (name: string) => col(model.rawAttributes[name]?.field || name);
  const generator = db.sequelize.getQueryInterface().queryGenerator as unknown as QueryGenerator;
  const castType = ['mysql', 'mariadb'].includes(db.sequelize.getDialect()) ? 'CHAR' : 'TEXT';
  const textColumn = (name: string) =>
    literal(
      `CAST(${generator.quoteIdentifier(model.name)}.${generator.quoteIdentifier(
        model.rawAttributes[name]?.field || name,
      )} AS ${castType})`,
    );
  const time = fn('COALESCE', column('usageOccurredAt'), column('startedAt'), column('createdAt'));
  const filter: Record<string | symbol, unknown> = {
    type: 'model_call',
    [Op.and]: [sqlWhere(time, { [Op.gte]: from, [Op.lt]: to })],
  };
  for (const key of ['provider', 'llmService', 'model', 'employeeUsername'] as const) {
    const value = textFilter(params[key]);
    if (value) filter[key] = value;
  }
  const userId = identifier(params.userId);
  const departmentId = identifier(params.departmentId);
  if (userId) filter.userId = userId;
  if (departmentId) (filter[Op.and] as unknown[]).push(sqlWhere(department.idText, departmentId));
  return {
    model,
    where: filter as WhereOptions,
    from,
    to,
    page,
    pageSize,
    infer,
    department,
    column,
    textColumn,
    time,
  };
}

function aggregateAttributes(db: Database, attributionSql: string): ProjectionAlias[] {
  const model = db.getCollection('agentExecutionSpans').model;
  const query = db.sequelize.getQueryInterface().queryGenerator as unknown as QueryGenerator;
  const field = (name: string) =>
    `${query.quoteIdentifier(model.name)}.${query.quoteIdentifier(model.rawAttributes[name]?.field || name)}`;
  const source = field('usageSource');
  const input = field('inputTokens');
  const output = field('outputTokens');
  const cost = field('cost');
  const currency = field('priceCurrency');
  const usageKnown = `${input} IS NOT NULL AND ${output} IS NOT NULL`;
  const castType = ['mysql', 'mariadb'].includes(db.sequelize.getDialect()) ? 'CHAR' : 'TEXT';
  const conditionalCount = (predicate: string) => fn('COUNT', literal(`CASE WHEN ${predicate} THEN 1 END`));
  return [
    [fn('COUNT', col(model.rawAttributes.id?.field || 'id')), 'calls'],
    ...['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens'].flatMap(
      (name): ProjectionAlias[] => [
        [cast(fn('SUM', col(model.rawAttributes[name]?.field || name)), castType), `known_${name}`],
        [fn('COUNT', col(model.rawAttributes[name]?.field || name)), `reported_${name}`],
      ],
    ),
    [conditionalCount(`${source} = 'actual' AND ${usageKnown}`), 'actualCalls'],
    [conditionalCount(`${source} = 'estimated' AND ${usageKnown}`), 'estimatedCalls'],
    [
      conditionalCount(`(${source} IS NULL OR ${source} NOT IN ('actual', 'estimated') OR NOT (${usageKnown}))`),
      'missingCalls',
    ],
    [conditionalCount(`${cost} IS NULL OR ${currency} IS NULL OR ${currency} = ''`), 'unpricedCalls'],
    [conditionalCount(`${attributionSql} = 'snapshot'`), 'snapshotCalls'],
    [conditionalCount(`${attributionSql} = 'inferred'`), 'inferredCalls'],
    [conditionalCount(`${attributionSql} NOT IN ('snapshot', 'inferred')`), 'unattributedCalls'],
    [conditionalCount(`${field('usageIdentity')} IS NULL`), 'unidentifiedCalls'],
    [
      fn(
        'SUM',
        literal(`CASE WHEN ${cost} IS NOT NULL AND ${currency} IS NOT NULL AND ${currency} <> '' THEN ${cost} END`),
      ),
      'knownCost',
    ],
  ];
}

function formatAggregate(row: AggregateRow) {
  const calls = numberOrNull(row.calls) || 0;
  const result: Values = {
    calls,
    actualCalls: numberOrNull(row.actualCalls) || 0,
    estimatedCalls: numberOrNull(row.estimatedCalls) || 0,
    missingCalls: numberOrNull(row.missingCalls) || 0,
    unpricedCalls: numberOrNull(row.unpricedCalls) || 0,
    snapshotCalls: numberOrNull(row.snapshotCalls) || 0,
    inferredCalls: numberOrNull(row.inferredCalls) || 0,
    unattributedCalls: numberOrNull(row.unattributedCalls) || 0,
    unidentifiedCalls: numberOrNull(row.unidentifiedCalls) || 0,
  };
  for (const name of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens']) {
    const known = tokenTotal(row[`known_${name}`]);
    const reported = numberOrNull(row[`reported_${name}`]) || 0;
    result[name] = calls > 0 && reported === calls && result.missingCalls === 0 ? known : null;
    result[`known${name[0].toUpperCase()}${name.slice(1)}`] = known;
    result[`${name}ReportedCalls`] = reported;
  }
  return result;
}

function isAdmin(ctx: unknown) {
  if (isAdminUser(ctx)) return true;
  const roles = (ctx as { state?: { currentRoles?: unknown } }).state?.currentRoles;
  return Array.isArray(roles) && roles.some((role) => role === 'root' || role === 'admin');
}

const callFields = [
  'usageOccurredAt',
  'startedAt',
  'createdAt',
  'model',
  'provider',
  'llmService',
  'employeeUsername',
  'usageSource',
  'pricingStatus',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedTokens',
  'reasoningTokens',
  'cost',
  'priceCurrency',
  'priceVersion',
  'usageSessionId',
  'usageMessageId',
  'usageIdentity',
];

export function registerAgentUsageResource(plugin: Plugin) {
  plugin.app.resource({
    name: 'agentUsage',
    actions: {
      async summary(ctx, next) {
        if (!isAdmin(ctx))
          ctx.throw(403, ctx.t('Admin role is required to view agent usage', { ns: 'plugin-agent-orchestrator' }));
        let query: ReturnType<typeof reportQuery>;
        try {
          query = reportQuery(ctx.db, ctx.action?.params || {});
        } catch (error) {
          if (error instanceof Error && error.message === 'INVALID_FILTER')
            ctx.throw(400, ctx.t('Invalid usage report filters', { ns: 'plugin-agent-orchestrator' }));
          throw error;
        }
        const attributes = aggregateAttributes(ctx.db, query.department.attributionSql);
        const totals = (await query.model.findOne({
          attributes,
          where: query.where,
          raw: true,
        })) as unknown as AggregateRow;
        const costs = (await query.model.findAll({
          attributes: ['priceCurrency', [fn('SUM', query.column('cost')), 'knownCost']],
          where: {
            [Op.and]: [
              query.where,
              { cost: { [Op.ne]: null } },
              { priceCurrency: { [Op.ne]: null } },
              { priceCurrency: { [Op.ne]: '' } },
            ],
          },
          group: [query.column('priceCurrency')],
          raw: true,
        })) as unknown as AggregateRow[];
        const formatted = formatAggregate(totals || {});
        ctx.body = {
          data: {
            ...formatted,
            costByCurrency: costs.map((row) => ({
              currency: row.priceCurrency,
              knownCost: numberOrNull(row.knownCost),
            })),
            coverage: {
              source: 'persisted-ledger',
              departmentAttribution: query.infer ? 'snapshot-or-current-membership-inference' : 'snapshot-or-unknown',
              inferenceAvailable: query.department.inferenceAvailable,
              snapshotCalls: formatted.snapshotCalls,
              inferredCalls: formatted.inferredCalls,
              unattributedCalls: formatted.unattributedCalls,
              unidentifiedCalls: formatted.unidentifiedCalls,
              from: query.from.toISOString(),
              to: query.to.toISOString(),
            },
          },
        };
        await next();
      },
      async breakdown(ctx, next) {
        if (!isAdmin(ctx))
          ctx.throw(403, ctx.t('Admin role is required to view agent usage', { ns: 'plugin-agent-orchestrator' }));
        const params = ctx.action?.params || {};
        let query: ReturnType<typeof reportQuery>;
        let dimension: Dimension;
        try {
          query = reportQuery(ctx.db, params);
          if (!DIMENSIONS.includes(params.groupBy as Dimension)) throw new Error('INVALID_FILTER');
          dimension = params.groupBy as Dimension;
        } catch (error) {
          if (error instanceof Error && error.message === 'INVALID_FILTER')
            ctx.throw(400, ctx.t('Invalid usage report filters', { ns: 'plugin-agent-orchestrator' }));
          throw error;
        }
        const group =
          dimension === 'departmentId'
            ? query.department.idText
            : dimension === 'userId'
              ? query.textColumn('userId')
              : query.column(dimension);
        const groups = [group, query.column('priceCurrency')];
        const attributes: unknown[] = [
          [group, 'key'],
          ['priceCurrency', 'currency'],
        ];
        if (dimension === 'departmentId') {
          groups.push(query.department.attribution);
          attributes.push([query.department.attribution, 'departmentAttribution']);
        }
        attributes.push(...aggregateAttributes(ctx.db, query.department.attributionSql));
        const rows = (await query.model.findAll({
          attributes: attributes as never,
          where: query.where,
          group: groups as unknown as GroupOption,
          order: groups.map((value) => [value, 'ASC']),
          limit: query.pageSize + 1,
          offset: (query.page - 1) * query.pageSize,
          raw: true,
        })) as unknown as AggregateRow[];
        ctx.body = {
          data: rows.slice(0, query.pageSize).map((row) => ({
            key: row.key ?? null,
            currency: row.currency || null,
            departmentAttribution: row.departmentAttribution,
            knownCost: numberOrNull(row.knownCost),
            ...formatAggregate(row),
          })),
          meta: {
            page: query.page,
            pageSize: query.pageSize,
            hasMore: rows.length > query.pageSize,
            count: null,
            totalPage: null,
          },
        };
        await next();
      },
      async calls(ctx, next) {
        if (!isAdmin(ctx))
          ctx.throw(403, ctx.t('Admin role is required to view agent usage', { ns: 'plugin-agent-orchestrator' }));
        let query: ReturnType<typeof reportQuery>;
        try {
          query = reportQuery(ctx.db, ctx.action?.params || {});
        } catch (error) {
          if (error instanceof Error && error.message === 'INVALID_FILTER')
            ctx.throw(400, ctx.t('Invalid usage report filters', { ns: 'plugin-agent-orchestrator' }));
          throw error;
        }
        const [rows, count] = await Promise.all([
          query.model.findAll({
            attributes: [
              ...callFields,
              [query.textColumn('id'), 'id'],
              [query.textColumn('userId'), 'userId'],
              [query.department.idText, 'departmentId'],
              [query.department.attribution, 'departmentAttribution'],
            ],
            where: query.where,
            order: [
              [query.time, 'DESC'],
              ['id', 'DESC'],
            ],
            limit: query.pageSize,
            offset: (query.page - 1) * query.pageSize,
            raw: true,
          }),
          query.model.count({ where: query.where }),
        ]);
        ctx.body = {
          data: rows,
          meta: { count, page: query.page, pageSize: query.pageSize, totalPage: Math.ceil(count / query.pageSize) },
        };
        await next();
      },
    },
  });
}
