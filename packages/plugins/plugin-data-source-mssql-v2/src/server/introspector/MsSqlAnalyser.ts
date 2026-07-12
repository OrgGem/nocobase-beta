/**
 * MSSQL Database Analyser — schema introspection for SQL Server.
 *
 * Adapted from dbgate-plugin-mssql/src/backend/MsSqlAnalyser.js (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 *
 * Uses SQL Server system views (sys.tables, sys.columns, sys.indexes, etc.)
 * to build a complete picture of the database structure.
 */

import _ from 'lodash';
import { DatabaseAnalyser } from './DatabaseAnalyser';
import type { EngineDriver, DatabaseHandle, DatabaseInfo, ColumnInfo } from '../types';
import * as sql from './sql';

// ---- Helpers ----

function isTypeString(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return (
    lower === 'char' ||
    lower === 'varchar' ||
    lower === 'nvarchar' ||
    lower === 'nchar' ||
    lower === 'text' ||
    lower === 'ntext'
  );
}

function isTypeNumeric(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return (
    lower === 'decimal' ||
    lower === 'numeric' ||
    lower === 'money' ||
    lower === 'smallmoney'
  );
}

function isTypeNChar(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return lower === 'nchar' || lower === 'nvarchar' || lower === 'ntext';
}

function getFullDataTypeName(row: {
  dataType: string;
  charMaxLength?: number;
  numericScale?: number;
  numericPrecision?: number;
}): string {
  let fullDataType = row.dataType;
  let charMaxLength = row.charMaxLength ?? (row as any).maxLength;

  // sys.columns.max_length is in bytes. For Unicode types (nchar/nvarchar/ntext),
  // each character is 2 bytes, so divide by 2 to get the character length.
  if (charMaxLength && isTypeNChar(row.dataType) && charMaxLength > 0) {
    charMaxLength = Math.floor(charMaxLength / 2);
  }

  if (charMaxLength && isTypeString(row.dataType)) {
    fullDataType = `${row.dataType}(${charMaxLength < 0 ? 'MAX' : charMaxLength})`;
  }
  if (row.numericPrecision && row.numericScale && isTypeNumeric(row.dataType)) {
    fullDataType = `${row.dataType}(${row.numericPrecision},${row.numericScale})`;
  }

  return fullDataType;
}

function simplifyComputedExpression(expr: string | undefined): string | undefined {
  if (!expr) return expr;
  while (expr.startsWith('(') && expr.endsWith(')')) {
    expr = expr.slice(1, -1);
  }
  return expr;
}

function getColumnInfo(raw: any): ColumnInfo {
  let defaultValue = raw.defaultValue;
  if (defaultValue) {
    defaultValue = defaultValue.trim();
    while (defaultValue.startsWith('(') && defaultValue.endsWith(')')) {
      defaultValue = defaultValue.slice(1, -1).trim();
    }
  }

  const fullDataType = getFullDataTypeName(raw);

  return {
    objectId: raw.objectId,
    columnName: raw.columnName,
    dataType: fullDataType,
    notNull: !raw.isNullable,
    autoIncrement: !!raw.isIdentity,
    defaultValue,
    defaultConstraint: raw.defaultConstraint,
    computedExpression: simplifyComputedExpression(raw.computedExpression),
    hasAutoValue: !!(raw.dataType === 'timestamp' || raw.dataType === 'rowversion' || raw.computedExpression),
    columnComment: raw.columnComment,
    isSparse: raw.isSparse,
    isPersisted: raw.isPersisted,
  };
}

export class MsSqlAnalyser extends DatabaseAnalyser {
  constructor(dbhan: DatabaseHandle, driver: EngineDriver, version?: any) {
    super(dbhan, driver, version);
  }

  /**
   * Replace template placeholders in SQL queries with actual conditions.
   */
  createQuery(resFileName: string, _typeFields?: string[]): string {
    const sqlMap: Record<string, string> = {
      tables: sql.tablesQuery,
      columns: sql.columnsQuery,
      baseColumns: sql.baseColumnsQuery,
      primaryKeys: sql.primaryKeysQuery,
      foreignKeys: sql.foreignKeysQuery,
      indexes: sql.indexesQuery,
      indexcols: sql.indexcolsQuery,
      views: sql.viewsQuery,
      viewColumns: sql.viewColumnsQuery,
      tableSizes: sql.tableSizesQuery,
      programmables: sql.programmablesQuery,
      proceduresParameters: sql.proceduresParametersQuery,
      functionParameters: sql.functionParametersQuery,
      triggers: sql.triggersQuery,
      loadSqlCode: sql.loadSqlCodeQuery,
      modifications: sql.modificationsQuery,
      listDatabases: sql.listDatabasesQuery,
      listProcesses: sql.listProcessesQuery,
      listVariables: sql.listVariablesQuery,
    };

    let query = sqlMap[resFileName];
    if (!query) throw new Error(`Missing analyse query: ${resFileName}`);

    // Replace template placeholders
    if (this.singleObjectId !== null) {
      query = query.replace(/OBJECT_ID_CONDITION/g, String(this.singleObjectId));
    } else {
      query = query.replace(/OBJECT_ID_CONDITION/g, 'o.object_id');
    }

    if (this.singleObjectFilter?.schemaName) {
      query = query.replace(/SCHEMA_NAME_CONDITION/g, `'${this.singleObjectFilter.schemaName}'`);
    } else {
      // When not filtering by a single schema, return all schemas
      query = query.replace(/and s.name =SCHEMA_NAME_CONDITION/g, '');
      query = query.replace(/and u.name =SCHEMA_NAME_CONDITION/g, '');
    }

    return query;
  }

  async _computeSingleObjectId(): Promise<void> {
    const { schemaName, pureName } = this.singleObjectFilter!;
    const fullName = schemaName ? `[${schemaName}].[${pureName}]` : `[${pureName}]`;
    const resId = await this.driver.query(this.dbhan, `SELECT OBJECT_ID('${fullName}') AS id`);
    this.singleObjectId = resId.rows[0]?.id;
  }

  async _runAnalysis(): Promise<DatabaseInfo> {
    // Use READ UNCOMMITTED to avoid blocking by schema-modification locks
    // on system catalog views during introspection.
    await this.driver.query(
      this.dbhan,
      'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED',
    );

    // Load all metadata through batched parallel queries to avoid overwhelming
    // SQL Server with 15 concurrent system-catalog queries.
    // Batches are ordered by dependency and query weight.

    // Batch 1: Core table/column structure
    const [tablesRows, columnsRows, baseColumnsRows, pkColumnsRows] = await Promise.all([
      this.analyserQuery('tables'),
      this.analyserQuery('columns'),
      this.analyserQuery('baseColumns'),
      this.analyserQuery('primaryKeys'),
    ]);

    // Batch 2: Constraints, indexes, and sizing metadata
    const [fkColumnsRows, indexesRows, indexcolsRows, tableSizes] = await Promise.all([
      this.analyserQuery('foreignKeys'),
      this.analyserQuery('indexes'),
      this.analyserQuery('indexcols'),
      this.analyserQuery('tableSizes').catch(() => ({ rows: [], columns: [] })),
    ]);

    // Batch 3: Views, programmables, and their parameters
    const [viewsRows, viewColumnRows, programmablesRows] = await Promise.all([
      this.analyserQuery('views'),
      this.analyserQuery('viewColumns').catch(() => ({ rows: [], columns: [] })),
      this.analyserQuery('programmables'),
    ]);

    // Batch 4: Remaining metadata (params, triggers, SQL code)
    const [procedureParameterRows, functionParameterRows, triggerRows, sqlCodeRows] =
      await Promise.all([
        this.analyserQuery('proceduresParameters').catch(() => ({ rows: [], columns: [] })),
        this.analyserQuery('functionParameters').catch(() => ({ rows: [], columns: [] })),
        this.analyserQuery('triggers').catch(() => ({ rows: [], columns: [] })),
        this.analyserQuery('loadSqlCode'),
      ]);

    const tableSizesDict = _.mapValues(_.keyBy(tableSizes.rows, 'objectId'), 'tableRowCount');
    const columns = columnsRows.rows.map(getColumnInfo);

    const getCreateSql = (row: { pureName: string; schemaName: string }) =>
      sqlCodeRows.rows
        .filter((x: any) => x.pureName === row.pureName && x.schemaName === row.schemaName)
        .map((x: any) => x.codeText)
        .join('');

    // Build tables
    const tables = tablesRows.rows.map((row: any) => ({
      ...row,
      columns: columns.filter((col) => col.objectId === row.objectId),
      primaryKey: DatabaseAnalyser.extractPrimaryKeys(row, pkColumnsRows.rows),
      foreignKeys: DatabaseAnalyser.extractForeignKeys(row, fkColumnsRows.rows),
      indexes: indexesRows.rows
        .filter((idx: any) => idx.object_id === row.objectId && !idx.is_unique_constraint)
        .map((idx: any) => ({
          ..._.pick(idx, ['constraintName', 'indexType', 'isUnique', 'filterDefinition']),
          columns: indexcolsRows.rows
            .filter((col: any) => col.object_id === idx.object_id && col.index_id === idx.index_id)
            .map((col: any) => _.pick(col, ['columnName', 'isDescending', 'isIncludedColumn'])),
        })),
      uniques: indexesRows.rows
        .filter((idx: any) => idx.object_id === row.objectId && idx.is_unique_constraint)
        .map((idx: any) => ({
          ..._.pick(idx, ['constraintName']),
          columns: indexcolsRows.rows
            .filter((col: any) => col.object_id === idx.object_id && col.index_id === idx.index_id)
            .map((col: any) => _.pick(col, ['columnName'])),
        })),
      tableRowCount: tableSizesDict[row.objectId],
    }));

    // Build views
    const views = viewsRows.rows.map((row: any) => ({
      ...row,
      createSql: getCreateSql(row),
      columns: viewColumnRows.rows
        .filter((col: any) => col.objectId === row.objectId)
        .map(getColumnInfo),
    }));

    // Build procedures
    const procedureParameterInfos = procedureParameterRows.rows.map((row: any) => ({
      ...row,
      dataType: getFullDataTypeName(row),
    }));

    const procedureToParameters = procedureParameterInfos.reduce(
      (acc: Record<number, any[]>, param: any) => {
        if (!acc[param.parentObjectId]) acc[param.parentObjectId] = [];
        acc[param.parentObjectId].push(param);
        return acc;
      },
      {} as Record<number, any[]>,
    );

    const procedures = programmablesRows.rows
      .filter((x: any) => x.sqlObjectType?.trim() === 'P')
      .map((row: any) => ({
        ...row,
        createSql: getCreateSql(row),
        parameters: procedureToParameters[row.objectId] || [],
      }));

    // Build functions
    const functionParameterInfos = functionParameterRows.rows.map((row: any) => ({
      ...row,
      dataType: getFullDataTypeName(row),
    }));

    const functionToParameters = functionParameterInfos.reduce(
      (acc: Record<number, any[]>, param: any) => {
        if (!acc[param.parentObjectId]) acc[param.parentObjectId] = [];
        acc[param.parentObjectId].push(param);
        return acc;
      },
      {} as Record<number, any[]>,
    );

    const functions = programmablesRows.rows
      .filter((x: any) => ['FN', 'IF', 'TF'].includes(x.sqlObjectType?.trim()))
      .map((row: any) => ({
        ...row,
        createSql: getCreateSql(row),
        parameters: functionToParameters[row.objectId] || [],
      }));

    // Build triggers
    const triggers = triggerRows.rows.map((row: any) => ({
      objectId: `triggers:${row.object_id}`,
      triggerTiming: row.triggerTiming,
      eventType: row.eventType,
      schemaName: row.schemaName,
      tableName: row.tableName,
      pureName: row.triggerName,
      createSql: row.definition,
    }));

    return {
      tables,
      views,
      procedures,
      functions,
      triggers,
    };
  }
}
