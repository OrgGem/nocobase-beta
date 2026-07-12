/**
 * MSSQL tedious driver — Connection and Query Engine
 *
 * Adapted from dbgate-plugin-mssql/src/backend/tediousDriver.js (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 *
 * Changes from original:
 *   - Uses direct ES module imports instead of global.DBGATE_PACKAGES
 *   - TypeScript with full type annotations
 *   - Uses NocoBase logger pattern instead of pinomin
 */

import _ from 'lodash';
import { Stream, PassThrough } from 'stream';
import tedious from 'tedious';
import type { Connection, ConnectionAuthentication, ConnectionOptions } from 'tedious';
import {
  MssqlConnectionOptions,
  DatabaseHandle,
  QueryResult,
  QueryResultColumn,
  QueryOptions,
  StreamOptions,
} from '../types';
import { makeUniqueColumnNames } from '../utils/makeUniqueColumnNames';
import { extractDbNameFromComposite } from '../utils/schemaInfoTools';
import getConcreteType from './getConcreteType';

// ---- Column extraction ----

function extractTediousColumns(
  columns: tedious.ColumnValue[],
  addDriverNativeColumn = false,
): QueryResultColumn[] {
  const res = columns.map((col) => {
    const metadata = col as any;
    const resCol: QueryResultColumn = {
      columnName: metadata.colName,
      dataType: (metadata.type?.name || 'unknown').toLowerCase(),
      driverNativeColumn: addDriverNativeColumn ? col : undefined,
      notNull: !(metadata.flags & 0x01),
      autoIncrement: !!(metadata.flags & 0x10),
      tableName: metadata.tableName || undefined,
      tableSchema: metadata.schemaName || undefined,
      sourceColumnName: metadata.columnName || metadata.baseColumnName || undefined,
    };
    if (metadata.dataLength) {
      resCol.dataType += `(${metadata.dataLength})`;
    }
    return resCol;
  });

  makeUniqueColumnNames(res);
  return res;
}

// ---- Row processing ----

function modifyRow(row: Record<string, any>, columns: QueryResultColumn[]): Record<string, any> {
  columns.forEach((col) => {
    if (Buffer.isBuffer(row[col.columnName])) {
      row[col.columnName] = { $binary: { base64: Buffer.from(row[col.columnName]).toString('base64') } };
    }
  });
  return row;
}

// ---- Authentication ----

async function getAuthentication(opts: MssqlConnectionOptions): Promise<ConnectionAuthentication> {
  const { authType, accessToken, user, username, password, windowsDomain } = opts;
  const effectiveUser = user || username;

  switch (authType) {
    case 'azureManagedIdentity': {
      // Lazy-load @azure/identity only when needed (dynamic require avoids build-time scanning)
      const modName = '@azure/identity';
      const { ManagedIdentityCredential } = require(modName);
      const credential = new ManagedIdentityCredential();
      const tokenResponse = await credential.getToken('https://database.windows.net/.default');
      return {
        type: 'azure-active-directory-access-token',
        options: { token: tokenResponse.token },
      };
    }

    case 'msentra':
      return {
        type: 'azure-active-directory-access-token',
        options: { token: accessToken! },
      };

    default:
      return {
        type: windowsDomain ? 'ntlm' : 'default',
        options: {
          userName: effectiveUser || '',
          password: password || '',
          ...(windowsDomain ? { domain: windowsDomain } : {}),
        },
      };
  }
}

// ---- Connection ----

export async function tediousConnect(
  storedConnection: MssqlConnectionOptions,
  logger?: any,
): Promise<DatabaseHandle<tedious.Connection>> {
  const { server, host, port, database, ssl, trustServerCertificate, authType } = storedConnection;
  const effectiveServer = server || host || 'localhost';

  const authentication = await getAuthentication(storedConnection);

  return new Promise((resolve, reject) => {
    const [hostName, instance] = effectiveServer.split('\\');

    const isAzureAuth = authType === 'msentra' || authType === 'azureManagedIdentity';
    const isAzureHost = effectiveServer?.endsWith('.database.windows.net');

    const connectionOptions: ConnectionOptions = {
      instanceName: instance || undefined,
      encrypt: !!(ssl || isAzureAuth || isAzureHost),
      cryptoCredentialsDetails: ssl ? _.pick(ssl, ['ca', 'cert', 'key']) : undefined,
      trustServerCertificate: ssl
        ? !ssl.ca && !ssl.cert && !ssl.key
          ? true
          : ssl.rejectUnauthorized
        : !!trustServerCertificate,
      enableArithAbort: true,
      validateBulkLoadParameters: false,
      requestTimeout: storedConnection.requestTimeout ?? 1000 * 3600, // 1hr default
      connectTimeout: storedConnection.connectTimeout ?? 30000,
      port: port && !instance ? parseInt(String(port)) : undefined,
      appName: 'NocoBase-MSSQL-V2',
      // Enable MARS so a single connection can handle concurrent requests (Promise.all)
      multipleActiveResultSets: true,
    };

    if (database) {
      (connectionOptions as any).database = extractDbNameFromComposite(database);
    }

    const connection = new tedious.Connection({
      server: hostName,
      authentication,
      options: connectionOptions,
    });

    connection.on('connect', function (err: Error | null) {
      if (err) {
        logger?.error?.('[MSSQL-V2] Connection failed:', err.message);
        reject(err);
        return;
      }
      logger?.info?.('[MSSQL-V2] Connected successfully');
      resolve({
        client: connection,
        database: database || undefined,
        connectionType: 'tedious',
      });
    });

    connection.connect();
  });
}

// ---- Query ----

export async function tediousQueryCore(
  dbhan: DatabaseHandle<tedious.Connection>,
  sql: string,
  options?: QueryOptions,
): Promise<QueryResult> {
  if (sql == null) {
    return { rows: [], columns: [] };
  }

  const { addDriverNativeColumn, commandTimeout } = options || {};

  return new Promise((resolve, reject) => {
    const result: QueryResult = {
      rows: [],
      columns: [],
    };

    const request = new tedious.Request(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve(result);
    });

    if (commandTimeout) {
      request.setTimeout(parseInt(String(commandTimeout)));
    }

    request.on('columnMetadata', function (columns: tedious.ColumnValue[]) {
      result.columns = extractTediousColumns(columns, addDriverNativeColumn);
    });

    request.on('row', function (columns: tedious.ColumnValue[]) {
      result.rows.push(
        modifyRow(
          _.zipObject(
            result.columns.map((x) => x.columnName),
            columns.map((x: any) => x.value),
          ),
          result.columns,
        ),
      );
    });

    dbhan.client.execSqlBatch(request);
  });
}

// ---- Streaming query ----

export function tediousStream(
  dbhan: DatabaseHandle<tedious.Connection>,
  sql: string,
  options: StreamOptions,
): void {
  let currentColumns: QueryResultColumn[] = [];
  let skipAffectedMessage = false;

  const handleInfo = (info: any) => {
    const { message, lineNumber, procName } = info;
    options.info?.({
      message,
      line: lineNumber != null && lineNumber > 0 ? lineNumber - 1 : lineNumber,
      procedure: procName,
      time: new Date(),
      severity: 'info',
    });
  };

  const handleError = (error: any) => {
    const { message, lineNumber, procName } = error;
    options.info?.({
      message,
      line: lineNumber != null && lineNumber > 0 ? lineNumber - 1 : lineNumber,
      procedure: procName,
      time: new Date(),
      severity: 'error',
    });
  };

  const handleDatabaseChange = (database: string) => {
    options.changedCurrentDatabase?.(database);
  };

  dbhan.client.on('databaseChange', handleDatabaseChange);
  dbhan.client.on('infoMessage', handleInfo);
  dbhan.client.on('errorMessage', handleError);

  const request = new tedious.Request(sql, (err: Error | null, rowCount: number) => {
    options.done?.();
    dbhan.client.off('infoMessage', handleInfo);
    dbhan.client.off('errorMessage', handleError);
    dbhan.client.off('databaseChange', handleDatabaseChange);

    if (!skipAffectedMessage) {
      options.info?.({
        message: `${rowCount} rows affected`,
        time: new Date(),
        severity: 'info',
        rowsAffected: rowCount,
      });
    }
  });

  request.on('columnMetadata', function (columns: tedious.ColumnValue[]) {
    currentColumns = extractTediousColumns(columns);
    options.recordset(currentColumns, { engine: 'mssql-v2@nocobase' });
  });

  request.on('row', function (columns: tedious.ColumnValue[]) {
    const row = modifyRow(
      _.zipObject(
        currentColumns.map((x) => x.columnName),
        columns.map((x: any) => x.value),
      ),
      currentColumns,
    );
    options.row(row);
    skipAffectedMessage = true;
  });

  dbhan.client.execSqlBatch(request);
}

// ---- Read query (streaming result) ----

export function tediousReadQuery(
  dbhan: DatabaseHandle<tedious.Connection>,
  sql: string,
  structure?: any,
): PassThrough {
  const pass = new PassThrough({
    objectMode: true,
    highWaterMark: 100,
  });
  let currentColumns: QueryResultColumn[] = [];

  const request = new tedious.Request(sql, (err: Error | null) => {
    if (err) console.error('[MSSQL-V2] Read query error:', err.message);
    pass.end();
  });

  request.on('columnMetadata', function (columns: tedious.ColumnValue[]) {
    currentColumns = extractTediousColumns(columns);
    pass.write({
      __isStreamHeader: true,
      engine: 'mssql-v2@nocobase',
      ...(structure || { columns: currentColumns }),
    });
  });

  request.on('row', function (columns: tedious.ColumnValue[]) {
    const row = modifyRow(
      _.zipObject(
        currentColumns.map((x) => x.columnName),
        columns.map((x: any) => x.value),
      ),
      currentColumns,
    );
    pass.write(row);
  });

  dbhan.client.execSql(request);
  return pass;
}
