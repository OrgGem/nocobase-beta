/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Sequelize, QueryTypes, Op } from 'sequelize';
import { Model } from '@nocobase/database';
import _ from 'lodash';

interface IndexInfo {
  name: string;
  columns: string[];
  isPrimary: boolean;
  isUnique: boolean;
}

interface FindOptions {
  chunkSize?: number;
  callback?: (rows: Model[], options: FindOptions) => Promise<void>;
  find?: (options: FindOptions) => Promise<any[]>;
  beforeFind?: (options: FindOptions) => Promise<void>;
  afterFind?: (rows: Model[], options: FindOptions) => Promise<void>;
  where?: any;
  order?: any;
  limit?: number;
  [key: string]: any;
}

/**
 * Cursor-based pagination strategy interface
 */
interface CursorStrategy {
  buildWhere(baseWhere: any, record?: Model): any;
  buildSort(): any;
}

/**
 * Single column cursor strategy - for tables with single-column primary key or unique index
 */
class SingleColumnCursorStrategy implements CursorStrategy {
  public columnName: string;

  constructor(columnName: string) {
    this.columnName = columnName;
  }

  buildSort() {
    return [[this.columnName, 'ASC']];
  }

  buildWhere(baseWhere: any, record?: Model): any {
    if (!record) {
      return baseWhere;
    }
    return { ...baseWhere, [this.columnName]: { [Op.gt]: record[this.columnName] } };
  }
}

/**
 * Composite key cursor strategy - for tables with composite primary key or multi-column unique index
 */
class CompositeKeyCursorStrategy implements CursorStrategy {
  private columns: string[];
  private directions: string[];

  constructor(columns: string[], directions?: string[]) {
    this.columns = columns;
    this.directions = directions || Array(columns.length).fill('ASC');
  }

  buildSort() {
    const orderBy = [];
    for (let i = 0; i < this.columns.length; i++) {
      orderBy.push([this.columns[i], this.directions[i]]);
    }
    return orderBy;
  }

  buildWhere(baseWhere: any, record?: any): any {
    if (!record) {
      return baseWhere;
    }
    const whereConditions = [];

    for (let i = 0; i < this.columns.length; i++) {
      const column = this.columns[i];

      if (i > 0) {
        const equalConditions = {};
        for (let j = 0; j < i; j++) {
          equalConditions[this.columns[j]] = record[this.columns[j]];
        }

        whereConditions.push({
          ...equalConditions,
          [column]: {
            [Op.gt]: record[column],
          },
        });
      } else {
        whereConditions.push({
          [column]: {
            [Op.gt]: record[column],
          },
        });
      }
    }
    const cursorCondition = {
      [Op.or]: whereConditions,
    };

    return baseWhere ? { [Op.and]: [baseWhere, cursorCondition] } : cursorCondition;
  }
}

/**
 * MSSQL-specific SmartCursorBuilder
 * Provides cursor-based pagination for efficient large dataset processing
 */
export class MssqlSmartCursorBuilder {
  private sequelize: Sequelize;
  private tableName: string;
  private collection: { filterTargetKey: string | string[] };

  constructor(sequelize: Sequelize, tableName: string, collection: { filterTargetKey: string | string[] }) {
    this.sequelize = sequelize;
    this.tableName = tableName;
    this.collection = collection;
  }

  /**
   * Auto-detect the best cursor strategy based on table structure
   * Uses MSSQL system views to find optimal index for cursor pagination
   */
  private async getBestCursorStrategy(): Promise<CursorStrategy> {
    const indexInfoSql = `
      SELECT 
        i.name AS INDEX_NAME,
        c.name AS COLUMN_NAME,
        ic.key_ordinal AS SEQ_IN_INDEX,
        CASE 
          WHEN i.is_primary_key = 1 THEN 1
          WHEN i.is_unique = 1 THEN 2
          ELSE 3 
        END as INDEX_TYPE,
        CASE WHEN ic.is_descending_key = 1 THEN 'DESC' ELSE 'ASC' END as DIRECTION
      FROM 
        sys.indexes i
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE 
        i.object_id = OBJECT_ID(?)
        AND i.type > 0
        AND ic.is_included_column = 0
      ORDER BY 
        i.name, 
        ic.key_ordinal
    `;

    try {
      const indexRows = (await this.sequelize.query(indexInfoSql, {
        type: QueryTypes.SELECT,
        replacements: [this.tableName],
        raw: true,
      })) as any[];

      const indexes: Map<string, IndexInfo> = new Map();
      const indexDirections: Map<string, Map<string, string>> = new Map();

      // If no indexes found, fallback to filterTargetKey
      if (!indexRows || indexRows.length === 0) {
        return this.getFallbackStrategy();
      }

      // Parse index information
      for (const row of indexRows) {
        const indexName = row.INDEX_NAME;
        const columnName = row.COLUMN_NAME;
        const indexType = row.INDEX_TYPE;
        const direction = row.DIRECTION;

        // Store direction info
        if (!indexDirections.has(indexName)) {
          indexDirections.set(indexName, new Map());
        }
        indexDirections.get(indexName).set(columnName, direction);

        // Build index info
        if (!indexes.has(indexName)) {
          indexes.set(indexName, {
            name: indexName,
            columns: [],
            isPrimary: indexType === 1,
            isUnique: indexType < 3,
          });
        }
        const seqInIndex = row.SEQ_IN_INDEX;
        const index = indexes.get(indexName);
        index.columns[seqInIndex - 1] = columnName;
      }

      // 1. First, look for primary key
      for (const index of indexes.values()) {
        if (index.isPrimary) {
          if (index.columns.length === 1) {
            return new SingleColumnCursorStrategy(index.columns[0]);
          } else {
            const directions = index.columns.map((col) => indexDirections.get(index.name)?.get(col) || 'ASC');
            return new CompositeKeyCursorStrategy(index.columns, directions);
          }
        }
      }

      // 2. Look for unique index (prefer single column)
      let singleColumnUniqueIndex = null;
      let multiColumnUniqueIndex = null;

      for (const index of indexes.values()) {
        if (index.isUnique && !index.isPrimary) {
          if (index.columns.length === 1 && !singleColumnUniqueIndex) {
            singleColumnUniqueIndex = index;
          } else if (index.columns.length > 1 && !multiColumnUniqueIndex) {
            multiColumnUniqueIndex = index;
          }
        }
      }

      if (singleColumnUniqueIndex) {
        return new SingleColumnCursorStrategy(singleColumnUniqueIndex.columns[0]);
      }

      if (multiColumnUniqueIndex) {
        const directions = multiColumnUniqueIndex.columns.map(
          (col) => indexDirections.get(multiColumnUniqueIndex.name)?.get(col) || 'ASC',
        );
        return new CompositeKeyCursorStrategy(multiColumnUniqueIndex.columns, directions);
      }

      // 3. Use any available index
      let anyIndex = null;
      for (const index of indexes.values()) {
        if (index.columns.length > 0 && !index.isPrimary && !index.isUnique) {
          anyIndex = index;
          break;
        }
      }

      if (anyIndex) {
        if (anyIndex.columns.length === 1) {
          return new SingleColumnCursorStrategy(anyIndex.columns[0]);
        } else {
          return new CompositeKeyCursorStrategy(anyIndex.columns);
        }
      }

      // Fallback to filterTargetKey
      return this.getFallbackStrategy();
    } catch (error) {
      console.error('[MssqlSmartCursorBuilder] Error getting index info:', error);
      return this.getFallbackStrategy();
    }
  }

  /**
   * Fallback strategy when no index information is available
   */
  private getFallbackStrategy(): CursorStrategy {
    if (Array.isArray(this.collection.filterTargetKey)) {
      return new CompositeKeyCursorStrategy(this.collection.filterTargetKey);
    }
    return new SingleColumnCursorStrategy(this.collection.filterTargetKey || 'id');
  }

  /**
   * Cursor-based pagination query function.
   * Ideal for large datasets (e.g., millions of rows)
   *
   * Note:
   *  1. Does not support jumping to arbitrary pages (e.g., "Page 5")
   *  2. Requires a stable, indexed sort field (e.g. ID, createdAt)
   *  3. If custom orderBy is used, it must match the cursor field(s) and direction
   *
   * @param options - Query options including chunkSize, callback, and find function
   */
  async chunk(options: FindOptions) {
    const cursorStrategy = await this.getBestCursorStrategy();
    let cursorRecord = null;
    let hasMoreData = true;
    let isFirst = true;

    options.order = cursorStrategy.buildSort();
    options['parseSort'] = false;

    while (hasMoreData) {
      if (!isFirst) {
        options.where = cursorStrategy.buildWhere(options.where, cursorRecord);
      }
      if (isFirst) {
        isFirst = false;
      }

      options.limit = options.chunkSize || 1000;

      if (options.beforeFind) {
        await options.beforeFind(options);
      }

      const records = await options.find(_.omit(options, 'callback', 'beforeFind', 'afterFind', 'chunkSize', 'find'));

      if (options.afterFind) {
        await options.afterFind(records, options);
      }

      if (records.length === 0) {
        hasMoreData = false;
        continue;
      }

      await options.callback(records, options);
      cursorRecord = records[records.length - 1];
    }
  }
}
