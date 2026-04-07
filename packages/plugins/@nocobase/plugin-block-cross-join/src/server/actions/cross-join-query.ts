/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';

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
    filter?: Record<string, any>;
  };
  joins: JoinConfig[];
  columns: ColumnConfig[];
  defaultSort?: string[];
}

function toPlainObject(row: any): Record<string, any> {
  if (row && typeof row.toJSON === 'function') {
    return row.toJSON();
  }
  return row;
}

function buildJoinMap(rows: Record<string, any>[], keyField: string): Map<string, Record<string, any>[]> {
  const map = new Map<string, Record<string, any>[]>();
  for (const row of rows) {
    const key = String(row[keyField] ?? '');
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(row);
  }
  return map;
}

function prefixRow(row: Record<string, any>, prefix: string): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    result[`${prefix}.${k}`] = v;
  }
  return result;
}

function applyJoin(
  leftRows: Record<string, any>[],
  rightRows: Record<string, any>[],
  joinConfig: JoinConfig,
  joinIndex: number,
): Record<string, any>[] {
  const rightMap = buildJoinMap(rightRows, joinConfig.rightField);
  const rightPrefix = `join${joinIndex}`;
  const result: Record<string, any>[] = [];

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

function applyColumnMapping(rows: Record<string, any>[], columns: ColumnConfig[]): Record<string, any>[] {
  return rows.map((row) => {
    const mapped: Record<string, any> = {};

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

  // 2. Determine if we need full-fetch (INNER join) or can paginate primary
  const hasInnerJoin = joins.some((j) => j.joinType === 'inner');

  let primaryRows: Record<string, any>[];
  let totalPrimaryCount: number;

  if (hasInnerJoin) {
    // Full fetch with cap for INNER joins
    const MAX_ROWS = 10000;
    const rawRows = await primaryRepo.find({
      filter: primarySource.filter || {},
      sort: sort || config.defaultSort,
      limit: MAX_ROWS,
    });
    primaryRows = rawRows.map(toPlainObject);
    totalPrimaryCount = primaryRows.length;
  } else {
    // Paginate at primary level for LEFT-only joins
    const [rawRows, count] = await Promise.all([
      primaryRepo.find({
        filter: primarySource.filter || {},
        sort: sort || config.defaultSort,
        limit: Number(pageSize),
        offset: (Number(page) - 1) * Number(pageSize),
      }),
      primaryRepo.count({
        filter: primarySource.filter || {},
      }),
    ]);
    primaryRows = rawRows.map(toPlainObject);
    totalPrimaryCount = Number(count);
  }

  // 3. Prefix primary rows
  let joinedRows: Record<string, any>[] = primaryRows.map((row) => prefixRow(row, 'primary'));

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
      filter: {
        [joinDef.rightField]: { $in: distinctKeys.map(String) },
      },
      limit: 10000,
    });
    const joinRows = joinRawRows.map(toPlainObject);

    // Apply join
    joinedRows = applyJoin(joinedRows, joinRows, joinDef, i);
  }

  // 5. Paginate if we did full-fetch (INNER join case)
  let totalCount: number;
  let paginatedRows: Record<string, any>[];

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
    data: finalRows,
    meta: {
      page: Number(page),
      pageSize: Number(pageSize),
      count: totalCount,
    },
  };

  await next();
}
