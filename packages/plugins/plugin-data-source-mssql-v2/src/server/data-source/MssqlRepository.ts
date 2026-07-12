/**
 * MSSQL V2 Repository — implements IRepository for direct MSSQL access.
 *
 * Translates NocoBase filter DSL → T-SQL WHERE clauses and executes
 * queries via the tedious driver. Follows the pattern of
 * ElasticsearchRepository.
 */

import type {
  IRepository,
  ICollection,
  IModel,
  FindOptions,
} from '@nocobase/data-source-manager';
import type { QueryResult } from '../types';

// ---- Helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function escapeIdentifier(name: string): string {
  // Prevent SQL injection in identifiers
  return `[${name.replace(/\]/g, ']]')}]`;
}

function escapeValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) {
    return `'${value.toISOString().replace('T', ' ').substring(0, 23)}'`;
  }
  // String: escape single quotes
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Escape a string value for use in LIKE patterns.
 * In T-SQL, the wildcards are: % _ [ ]
 * [ and ] define character ranges, so they must be escaped too.
 */
function escapeLike(value: string): string {
  return value
    .replace(/'/g, "''")
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

// ---- SQL WHERE Builder ----

type FilterValue = string | number | boolean | null | Array<string | number | boolean>;
type FilterRecord = Record<string, FilterValue | Record<string, FilterValue> | FilterRecord[]>;

function buildWhere(filter?: FilterRecord): { clause: string; params?: any[] } {
  if (!filter || Object.keys(filter).length === 0) {
    return { clause: '1=1' };
  }

  const parts: string[] = [];

  for (const [key, value] of Object.entries(filter)) {
    // Skip special NocoBase properties
    if (['context', 'appends', 'except', 'tree'].includes(key)) continue;

    if (key === '$and' && Array.isArray(value)) {
      const subClauses = (value as FilterRecord[]).map((sub) => {
        const { clause } = buildWhere(sub);
        return clause;
      });
      if (subClauses.length > 0) {
        parts.push(`(${subClauses.join(' AND ')})`);
      }
      continue;
    }

    if (key === '$or' && Array.isArray(value)) {
      const subClauses = (value as FilterRecord[]).map((sub) => {
        const { clause } = buildWhere(sub);
        return clause;
      });
      if (subClauses.length > 0) {
        parts.push(`(${subClauses.join(' OR ')})`);
      }
      continue;
    }

    // Standard field filter
    if (isRecord(value) && !Array.isArray(value)) {
      for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
        switch (op) {
          case '$eq':
            parts.push(`${escapeIdentifier(key)} = ${escapeValue(opVal)}`);
            break;
          case '$ne':
            if (opVal === null) {
              parts.push(`${escapeIdentifier(key)} IS NOT NULL`);
            } else {
              parts.push(`${escapeIdentifier(key)} != ${escapeValue(opVal)}`);
            }
            break;
          case '$gt':
            parts.push(`${escapeIdentifier(key)} > ${escapeValue(opVal)}`);
            break;
          case '$gte':
            parts.push(`${escapeIdentifier(key)} >= ${escapeValue(opVal)}`);
            break;
          case '$lt':
            parts.push(`${escapeIdentifier(key)} < ${escapeValue(opVal)}`);
            break;
          case '$lte':
            parts.push(`${escapeIdentifier(key)} <= ${escapeValue(opVal)}`);
            break;
          case '$like':
          case '$includes':
            parts.push(`${escapeIdentifier(key)} LIKE N'%${escapeLike(String(opVal))}%' ESCAPE '\\'`);
            break;
          case '$notIncludes':
            parts.push(`${escapeIdentifier(key)} NOT LIKE N'%${escapeLike(String(opVal))}%' ESCAPE '\\'`);
            break;
          case '$startsWith':
            parts.push(`${escapeIdentifier(key)} LIKE N'${escapeLike(String(opVal))}%' ESCAPE '\\'`);
            break;
          case '$endWith':
            parts.push(`${escapeIdentifier(key)} LIKE N'%${escapeLike(String(opVal))}' ESCAPE '\\'`);
            break;
          case '$in':
            if (Array.isArray(opVal) && opVal.length > 0) {
              const vals = opVal.map((v) => escapeValue(v)).join(', ');
              parts.push(`${escapeIdentifier(key)} IN (${vals})`);
            } else {
              parts.push('1=0'); // empty IN = no match
            }
            break;
          case '$notIn':
            if (Array.isArray(opVal) && opVal.length > 0) {
              const vals = opVal.map((v) => escapeValue(v)).join(', ');
              parts.push(`${escapeIdentifier(key)} NOT IN (${vals})`);
            }
            break;
          case '$is':
            if (opVal === null) {
              parts.push(`${escapeIdentifier(key)} IS NULL`);
            }
            break;
          case '$not':
            if (opVal === null) {
              parts.push(`${escapeIdentifier(key)} IS NOT NULL`);
            }
            break;
          default:
            // Unknown operator: treat as equality
            parts.push(`${escapeIdentifier(key)} = ${escapeValue(opVal)}`);
        }
      }
    } else {
      // Simple equality
      parts.push(`${escapeIdentifier(key)} = ${escapeValue(value)}`);
    }
  }

  if (parts.length === 0) return { clause: '1=1' };
  return { clause: parts.join(' AND ') };
}

function buildSort(sort?: string | string[]): string {
  if (!sort || (Array.isArray(sort) && sort.length === 0)) {
    return '';
  }

  const sortArray = Array.isArray(sort) ? sort : [sort];
  const orderClauses = sortArray.map((item) => {
    if (item.startsWith('-')) {
      return `${escapeIdentifier(item.slice(1))} DESC`;
    }
    return `${escapeIdentifier(item)} ASC`;
  });

  return `ORDER BY ${orderClauses.join(', ')}`;
}

function buildSelect(
  tableName: string,
  where: FilterRecord | undefined,
  sort: string | string[] | undefined,
  fields: string[] | undefined,
  offset?: number,
  limit?: number,
): string {
  const { clause: whereClause } = buildWhere(where);
  const sortClause = buildSort(sort);

  const columns = fields && fields.length > 0
    ? fields.map((f) => escapeIdentifier(f)).join(', ')
    : '*';

  let sql = `SELECT ${columns} FROM ${escapeIdentifier(tableName)} WHERE ${whereClause}`;

  if (sortClause) {
    sql += ` ${sortClause}`;
  }

  if (offset !== undefined && limit !== undefined) {
    sql += ` OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  } else if (limit !== undefined) {
    sql += ` OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  return sql;
}

function rowToModel(row: Record<string, any>): IModel {
  return {
    ...row,
    toJSON() {
      return row;
    },
  };
}

function emptyModel(): IModel {
  return {
    toJSON: () => ({}),
  };
}

// ---- MSSQL Repository ----

export class MssqlRepository implements IRepository {
  public collection: ICollection;
  private get tableName(): string {
    return this.collection.options?.tableName || this.collection.name;
  }

  constructor(collection: ICollection) {
    this.collection = collection;
  }

  /**
   * Get the data source that owns this repository.
   */
  private get dataSource(): any {
    return this.collection.collectionManager?.dataSource;
  }

  /**
   * Log an error via the data source's logger if available.
   */
  private logError(message: string, error?: any): void {
    const logger = this.dataSource?.logger;
    if (logger?.error) {
      logger.error(`[MSSQL-V2] ${message}`, error?.message || error || '');
    }
  }

  /**
   * Execute a SQL query via the driver.
   */
  private async query(sql: string): Promise<QueryResult> {
    const ds = this.dataSource;
    if (!ds?.executeQuery) {
      throw new Error('[MSSQL-V2] Data source does not support executeQuery');
    }
    return ds.executeQuery(sql);
  }

  // ---- IRepository implementation ----

  async find(options: FindOptions = {}): Promise<IModel[]> {
    const { filter, sort, limit, offset, page, pageSize, fields } = options as any;
    const size = limit || pageSize || 20;
    const from = offset ?? (page ? (Number(page) - 1) * size : 0);

    const sql = buildSelect(this.tableName, filter, sort, fields, from, size);

    const result = await this.query(sql);
    return result.rows.map(rowToModel);
  }

  async findOne(options: any = {}): Promise<IModel> {
    const { filterByTk, filter } = options;

    if (filterByTk !== undefined) {
      const pkField = this.collection.options?.filterTargetKey || '_id';
      const whereFilter = { [pkField]: { $eq: filterByTk } };

      const sql = buildSelect(this.tableName, whereFilter, undefined, undefined, 0, 1);
      const result = await this.query(sql);
      return result.rows.length > 0 ? rowToModel(result.rows[0]) : emptyModel();
    }

    const results = await this.find({ ...options, limit: 1 });
    return results[0] || emptyModel();
  }

  async count(options: any = {}): Promise<number> {
    const { filter } = options;
    const { clause: whereClause } = buildWhere(filter);

    const sql = `SELECT COUNT(*) AS total FROM ${escapeIdentifier(this.tableName)} WHERE ${whereClause}`;

    const result = await this.query(sql);
    return Number(result.rows[0]?.total) || 0;
  }

  async findAndCount(options: any = {}): Promise<[IModel[], number]> {
    const { filter, sort, limit, offset, page, pageSize, fields } = options;
    const size = limit || pageSize || 20;
    const from = offset ?? (page ? (Number(page) - 1) * size : 0);
    const { clause: whereClause } = buildWhere(filter);
    const sortClause = buildSort(sort);

    const columns = fields && fields.length > 0
      ? fields.map((f: string) => escapeIdentifier(f)).join(', ')
      : '*';

    const countSql = `SELECT COUNT(*) AS total FROM ${escapeIdentifier(this.tableName)} WHERE ${whereClause}`;

    let dataSql = `SELECT ${columns} FROM ${escapeIdentifier(this.tableName)} WHERE ${whereClause}`;
    if (sortClause) dataSql += ` ${sortClause}`;
    dataSql += ` OFFSET ${from} ROWS FETCH NEXT ${size} ROWS ONLY`;

    const [countResult, dataResult] = await Promise.all([
      this.query(countSql),
      this.query(dataSql),
    ]);
    const total = Number(countResult.rows[0]?.total) || 0;
    return [dataResult.rows.map(rowToModel), total];
  }

  async create(options: { values?: Record<string, unknown> }): Promise<IModel> {
    const values = options.values || {};
    if (Object.keys(values).length === 0) {
      // Insert default row
      const sql = `INSERT INTO ${escapeIdentifier(this.tableName)} DEFAULT VALUES;
                   SELECT SCOPE_IDENTITY() AS _inserted_id;`;
      try {
        const result = await this.query(sql);
        const newId = result.rows[0]?._inserted_id;
        return rowToModel({ _id: newId, ...values });
      } catch (error: any) {
        this.logError(`Create (default) error on ${this.tableName}:`, error);
        throw error;
      }
    }

    const columns = Object.keys(values).map(escapeIdentifier).join(', ');
    const vals = Object.values(values).map(escapeValue).join(', ');

    const sql = `
      INSERT INTO ${escapeIdentifier(this.tableName)} (${columns})
      OUTPUT INSERTED.*
      VALUES (${vals})
    `;

    try {
      const result = await this.query(sql);
      return rowToModel(result.rows[0] || { ...values });
    } catch (error: any) {
      this.logError(`Create error on ${this.tableName}:`, error);
      throw error;
    }
  }

  async update(options: {
    filterByTk?: string | number;
    values?: Record<string, unknown>;
    filter?: FilterRecord;
  }): Promise<IModel> {
    const { filterByTk, values = {}, filter } = options;

    if (Object.keys(values).length === 0) {
      throw new Error('No values provided for update');
    }

    let whereClause: string;
    if (filterByTk !== undefined) {
      const pkField = this.collection.options?.filterTargetKey || '_id';
      const { clause } = buildWhere({ [pkField]: { $eq: filterByTk } });
      whereClause = clause;
    } else if (filter) {
      const { clause } = buildWhere(filter);
      whereClause = clause;
    } else {
      throw new Error('filterByTk or filter is required for update');
    }

    const setClauses = Object.entries(values)
      .map(([key, value]) => `${escapeIdentifier(key)} = ${escapeValue(value)}`)
      .join(', ');

    const sql = `
      UPDATE ${escapeIdentifier(this.tableName)}
      SET ${setClauses}
      OUTPUT INSERTED.*
      WHERE ${whereClause}
    `;

    try {
      const result = await this.query(sql);
      return rowToModel(result.rows[0] || { ...values });
    } catch (error: any) {
      this.logError(`Update error on ${this.tableName}:`, error);
      throw error;
    }
  }

  async destroy(options: {
    filterByTk?: string | number;
    filter?: FilterRecord;
  }): Promise<IModel> {
    const { filterByTk, filter } = options;

    let whereClause: string;
    if (filterByTk !== undefined) {
      const pkField = this.collection.options?.filterTargetKey || '_id';
      const { clause } = buildWhere({ [pkField]: { $eq: filterByTk } });
      whereClause = clause;
    } else if (filter) {
      const { clause } = buildWhere(filter);
      whereClause = clause;
    } else {
      throw new Error('filterByTk or filter is required for destroy');
    }

    const sql = `
      DELETE FROM ${escapeIdentifier(this.tableName)}
      OUTPUT DELETED.*
      WHERE ${whereClause}
    `;

    try {
      const result = await this.query(sql);
      return rowToModel(result.rows[0] || {});
    } catch (error: any) {
      this.logError(`Destroy error on ${this.tableName}:`, error);
      throw error;
    }
  }
}
