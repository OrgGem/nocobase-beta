/**
 * MSSQL V2 Data Source — Dialect Definition
 *
 * Adapted from dbgate-plugin-mssql/src/frontend/driver.js (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 */

import type { SqlDialect, MssqlVersion } from './types';

const spatialTypes = ['GEOGRAPHY'];

const dialect: SqlDialect = {
  limitSelect: true,
  rangeSelect: true,
  topRecords: true,
  offsetFetchRangeSyntax: true,
  rowNumberOverPaging: true,
  defaultSchemaName: 'dbo',
  multipleSchema: true,
  stringEscapeChar: "'",
  fallbackDataType: 'nvarchar(max)',
  explicitDropConstraint: false,
  enableConstraintsPerTable: true,
  dropColumnDependencies: ['default', 'dependencies', 'indexes', 'primaryKey', 'foreignKeys', 'uniques'],
  changeColumnDependencies: ['indexes', 'dependencies', 'uniques'],
  anonymousPrimaryKey: false,
  dropIndexContainsTableSpec: true,
  quoteIdentifier(s: string) {
    return `[${s}]`;
  },

  createColumn: true,
  dropColumn: true,
  changeColumn: true,
  createIndex: true,
  dropIndex: true,
  createForeignKey: true,
  dropForeignKey: true,
  createPrimaryKey: true,
  dropPrimaryKey: true,
  createUnique: true,
  dropUnique: true,
  createCheck: true,
  dropCheck: true,
  renameSqlObject: true,
  filteredIndexes: true,

  dropReferencesWhenDropTable: true,
  namedDefaultConstraint: true,

  columnProperties: {
    columnComment: true,
    isSparse: true,
    isPersisted: true,
  },

  safeCommentChanges: true,

  predefinedDataTypes: [
    'bigint',
    'bit',
    'decimal(10,2)',
    'int',
    'money',
    'numeric',
    'smallint',
    'smallmoney',
    'tinyint',
    'float',
    'real',
    'date',
    'datetime2',
    'datetime',
    'datetimeoffset',
    'smalldatetime',
    'time',
    'char(20)',
    'varchar(250)',
    'text',
    'nchar(20)',
    'nvarchar(250)',
    'ntext',
    'binary(100)',
    'varbinary(100)',
    'image',
    'xml',
  ],

  useDatalengthForEmptyString(dataType: string) {
    return !!dataType && ['text', 'ntext', 'image'].includes(dataType.toLowerCase());
  },

  disableGroupingForDataType(dataType: string) {
    return !!dataType && ['text', 'ntext', 'image'].includes(dataType.toLowerCase());
  },

  createColumnViewExpression(columnName: string, dataType: string, source: any, alias?: string) {
    if (dataType && spatialTypes.includes(dataType.toUpperCase())) {
      return {
        exprType: 'methodCall',
        method: 'STAsText',
        alias: alias || columnName,
        thisObject: {
          exprType: 'column',
          columnName,
          source,
        },
      };
    }
    if (dataType && dataType.toUpperCase() === 'XML') {
      return {
        exprType: 'call',
        func: 'CONVERT',
        alias: alias || columnName,
        args: [
          { exprType: 'raw', sql: 'NVARCHAR(MAX)' },
          { exprType: 'column', columnName, source },
        ],
      };
    }
    return undefined;
  },
};

/**
 * Get dialect adjusted for a specific SQL Server version.
 * SQL Server < 2012 does not support OFFSET...FETCH syntax.
 */
export function dialectByVersion(version: MssqlVersion): SqlDialect {
  if (version && (version.productVersionNumber ?? 0) < 11) {
    return {
      ...dialect,
      rangeSelect: false,
      offsetFetchRangeSyntax: false,
    };
  }
  return dialect;
}

/**
 * Version query used to detect SQL Server version and edition.
 */
export const VERSION_QUERY = `
SELECT
  @@VERSION AS version,
  SERVERPROPERTY('productversion') as productVersion,
  CASE
  WHEN CONVERT(VARCHAR(128), SERVERPROPERTY('productversion')) like '8%' THEN 'SQL Server 2000'
  WHEN CONVERT(VARCHAR(128), SERVERPROPERTY('productversion')) like '9%' THEN 'SQL Server 2005'
  WHEN CONVERT(VARCHAR(128), SERVERPROPERTY('productversion')) like '10.0%' THEN 'SQL Server 2008'
  WHEN CONVERT(VARCHAR(128), SERVERPROPERTY('productversion')) like '10.5%' THEN 'SQL Server 2008 R2'
  WHEN CONVERT(VARCHAR(128), SERVERPROPERTY('productversion')) like '11%' THEN 'SQL Server 2012'
  WHEN CONVERT(VARCHAR(128), SERVERPROPERTY('productversion')) like '12%' THEN 'SQL Server 2014'
  WHEN CONVERT(VARCHAR(128), SERVERPROPERTY('productversion')) like '13%' THEN 'SQL Server 2016'
  WHEN CONVERT(VARCHAR(128), SERVERPROPERTY('productversion')) like '14%' THEN 'SQL Server 2017'
  WHEN CONVERT(VARCHAR(128), SERVERPROPERTY('productversion')) like '15%' THEN 'SQL Server 2019'
  ELSE 'Unknown'
  END AS versionText
`;

export default dialect;
