/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { NoPermissionError } from '@nocobase/acl';

interface JoinConfig {
  dataSource: string;
  collection: string;
  joinType: 'left' | 'inner';
  leftField: string;
  rightField: string;
}

interface ColumnConfig {
  source: number; // 0 = primary, 1 = join[0], ...
  field: string;
  alias?: string;
  jsonExpand?: string[];
}

interface CrossJoinConfig {
  primarySource: {
    dataSource: string;
    collection: string;
    filter?: Record<string, unknown>;
  };
  joins: JoinConfig[];
  columns: ColumnConfig[];
  defaultSort?: string[];
}

function toPlainObject(row: Record<string, unknown>): Record<string, unknown> {
  if (row && typeof row.toJSON === 'function') {
    return row.toJSON();
  }
  return row;
}

function buildJoinMap(rows: Record<string, unknown>[], keyField: string): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row[keyField] ?? '');
    const matches = map.get(key) || [];
    matches.push(row);
    map.set(key, matches);
  }
  return map;
}

function prefixRow(row: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    result[`${prefix}.${k}`] = v;
  }
  return result;
}

function applyJoin(
  leftRows: Record<string, unknown>[],
  rightRows: Record<string, unknown>[],
  joinConfig: JoinConfig,
  joinIndex: number,
): Record<string, unknown>[] {
  const rightMap = buildJoinMap(rightRows, joinConfig.rightField);
  const rightPrefix = `join${joinIndex}`;
  const result: Record<string, unknown>[] = [];

  for (const leftRow of leftRows) {
    const key = String(leftRow[`primary.${joinConfig.leftField}`] ?? leftRow[joinConfig.leftField] ?? '');
    const matches = rightMap.get(key);

    if (matches && matches.length > 0) {
      for (const match of matches) {
        result.push({ ...leftRow, ...prefixRow(match, rightPrefix) });
      }
    } else if (joinConfig.joinType === 'left') {
      result.push({ ...leftRow });
    }
    // inner join: skip rows with no match
  }

  return result;
}

function applyColumnMapping(rows: Record<string, unknown>[], columns: ColumnConfig[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const mapped: Record<string, unknown> = {};

    for (const col of columns) {
      const prefix = col.source === 0 ? 'primary' : `join${col.source - 1}`;
      const fullKey = `${prefix}.${col.field}`;
      const value = row[fullKey];

      // JSON expansion
      if (col.jsonExpand?.length && value != null) {
        try {
          const parsed = typeof value === 'string' ? JSON.parse(value) : value;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const jsonKey of col.jsonExpand) {
              const alias = col.alias ? `${col.alias}.${jsonKey}` : `${col.field}.${jsonKey}`;
              mapped[alias] = parsed[jsonKey] ?? null;
            }
            continue;
          }
        } catch {
          // not valid JSON, fall through to display raw value
        }
      }

      const outputKey = col.alias || col.field;
      mapped[outputKey] = value ?? null;
    }

    return mapped;
  });
}

export async function crossJoinQuery(ctx: Context, next: () => Promise<void>) {
  const { config, page = 1, pageSize = 20, sort } = ctx.action.params.values || ctx.action.params;

  if (!config?.primarySource) {
    ctx.throw(400, 'Missing primarySource in config');
  }

  const dsManager = ctx.app.dataSourceManager;
  const { primarySource, joins = [], columns = [] } = config as CrossJoinConfig;

  // 1. Get primary datasource and repository
  const primaryDS = dsManager.get(primarySource.dataSource);
  if (!primaryDS) {
    ctx.throw(400, `Datasource "${primarySource.dataSource}" not found`);
  }

  const primaryRepo = primaryDS.collectionManager.getRepository(primarySource.collection);
  if (!primaryRepo) {
    ctx.throw(400, `Collection "${primarySource.collection}" not found in datasource "${primarySource.dataSource}"`);
  }

  // Resolve every source before querying, including joins whose input might be empty.
  const sources = [primarySource, ...joins];
  const permissions = await Promise.all(
    sources.map(async (source, index) => {
      const dataSource = dsManager.get(source.dataSource);
      if (!dataSource?.acl) ctx.throw(403);
      const permissionContext = Object.create(ctx);
      Object.defineProperties(permissionContext, {
        dataSource: { value: dataSource },
        database: { value: dataSource.collectionManager.db },
      });
      const resolved = await dataSource.acl
        .resolveActionParams(permissionContext, {
          resourceName: source.collection,
          actionName: 'list',
          params: index === 0 ? { filter: primarySource.filter || {}, sort: sort || config.defaultSort } : {},
        })
        .catch((error: unknown) => {
          if (error instanceof NoPermissionError) ctx.throw(403);
          throw error;
        });
      const fields: string[] | undefined = resolved.parsedParams?.fields;
      const except: string[] = resolved.parsedParams?.except || [];
      const assertField = (field: string) => {
        const name = field.replace(/^[+-]/, '').split('.')[0];
        if ((fields && !fields.includes(name)) || except.includes(name)) ctx.throw(403);
      };
      columns.filter((column) => column.source === index).forEach((column) => assertField(column.field));
      if (index === 0) {
        joins.forEach((join) => assertField(join.leftField));
        const requestedSort = sort || config.defaultSort || [];
        (Array.isArray(requestedSort) ? requestedSort : [requestedSort]).forEach(assertField);
        const checkFilter = (filter: unknown) => {
          if (!filter || typeof filter !== 'object') return;
          for (const [key, value] of Object.entries(filter)) {
            if (key.startsWith('$') || Array.isArray(filter)) checkFilter(value);
            else assertField(key);
          }
        };
        checkFilter(primarySource.filter);
      } else {
        assertField(joins[index - 1].rightField);
      }
      return resolved.mergedParams;
    }),
  );

  // 2. Determine if we need full-fetch (INNER join) or can paginate primary
  const hasInnerJoin = joins.some((j) => j.joinType === 'inner');

  let primaryRows: Record<string, unknown>[];
  let totalPrimaryCount: number;

  if (hasInnerJoin) {
    // Full fetch with cap for INNER joins
    const MAX_ROWS = 10000;
    const rawRows = await primaryRepo.find({
      ...permissions[0],
      context: ctx,
      limit: MAX_ROWS,
    });
    primaryRows = rawRows.map(toPlainObject);
    totalPrimaryCount = primaryRows.length;
  } else {
    // Paginate at primary level for LEFT-only joins
    const [rawRows, count] = await Promise.all([
      primaryRepo.find({
        ...permissions[0],
        context: ctx,
        limit: Number(pageSize),
        offset: (Number(page) - 1) * Number(pageSize),
      }),
      primaryRepo.count({
        filter: permissions[0].filter,
        context: ctx,
      }),
    ]);
    primaryRows = rawRows.map(toPlainObject);
    totalPrimaryCount = Number(count);
  }

  // 3. Prefix primary rows
  let joinedRows: Record<string, unknown>[] = primaryRows.map((row) => prefixRow(row, 'primary'));

  // 4. Process each join
  for (let i = 0; i < joins.length; i++) {
    const joinDef = joins[i];

    const joinDS = dsManager.get(joinDef.dataSource);
    if (!joinDS) {
      ctx.throw(400, `Datasource "${joinDef.dataSource}" not found`);
    }

    const joinRepo = joinDS.collectionManager.getRepository(joinDef.collection);
    if (!joinRepo) {
      ctx.throw(400, `Collection "${joinDef.collection}" not found in datasource "${joinDef.dataSource}"`);
    }

    // Collect distinct join keys from current result
    // leftField always refers to the primary source column (prefixed with "primary.")
    const leftKeyPath = `primary.${joinDef.leftField}`;
    const distinctKeys = [...new Set(joinedRows.map((r) => r[leftKeyPath]).filter((v) => v != null))];

    if (distinctKeys.length === 0) {
      // No keys to join on
      joinedRows = joinDef.joinType === 'left' ? joinedRows : [];
      continue;
    }

    // Batch fetch from join table
    const joinRawRows = await joinRepo.find({
      ...permissions[i + 1],
      context: ctx,
      filter: {
        $and: [permissions[i + 1].filter || {}, { [joinDef.rightField]: { $in: distinctKeys.map(String) } }],
      },
      limit: 10000,
    });
    const joinRows = joinRawRows.map(toPlainObject);

    // Apply join
    joinedRows = applyJoin(joinedRows, joinRows, joinDef, i);
  }

  // 5. Paginate if we did full-fetch (INNER join case)
  let totalCount: number;
  let paginatedRows: Record<string, unknown>[];

  if (hasInnerJoin) {
    totalCount = joinedRows.length;
    const start = (Number(page) - 1) * Number(pageSize);
    paginatedRows = joinedRows.slice(start, start + Number(pageSize));
  } else {
    totalCount = totalPrimaryCount;
    paginatedRows = joinedRows;
  }

  // 6. Apply column mapping
  const finalRows = columns.length > 0 ? applyColumnMapping(paginatedRows, columns) : paginatedRows;

  ctx.body = {
    rows: finalRows,
    page: Number(page),
    pageSize: Number(pageSize),
    count: totalCount,
  };

  await next();
}
