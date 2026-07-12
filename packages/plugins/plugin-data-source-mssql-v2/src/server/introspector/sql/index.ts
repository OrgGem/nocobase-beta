// SQL query modules index — all introspector SQL queries
// Adapted from dbgate-plugin-mssql/src/backend/sql/ (GPL-3.0)

export { tablesQuery } from './tables';
export { columnsQuery, baseColumnsQuery } from './columns';
export { primaryKeysQuery } from './primaryKeys';
export { foreignKeysQuery } from './foreignKeys';
export { indexesQuery } from './indexes';
export { indexcolsQuery } from './indexcols';
export {
  viewsQuery,
  viewColumnsQuery,
  tableSizesQuery,
  programmablesQuery,
  proceduresParametersQuery,
  functionParametersQuery,
  triggersQuery,
} from './views';
export {
  loadSqlCodeQuery,
  modificationsQuery,
  listDatabasesQuery,
  listProcessesQuery,
  listVariablesQuery,
} from './others';
