/**
 * MSSQL native ODBC driver (Windows only)
 *
 * Adapted from dbgate-plugin-mssql/src/backend/nativeDriver.js (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 *
 * Uses the msnodesqlv8 optional dependency for native Windows ODBC connections.
 * Falls back to tedious when msnodesqlv8 is not available.
 */

import _ from 'lodash';
import { Stream, PassThrough } from 'stream';
import { MssqlConnectionOptions, DatabaseHandle, QueryResult, QueryResultColumn, StreamOptions } from '../types';
import { makeUniqueColumnNames } from '../utils/makeUniqueColumnNames';
import { extractDbNameFromComposite } from '../utils/schemaInfoTools';

let msnodesqlv8Value: any;

function getMsnodesqlv8(): any {
  if (!msnodesqlv8Value) {
    try {
      // Use dynamic require with variable to avoid static analysis by build tool
      const moduleName = 'msnodesqlv8';
      msnodesqlv8Value = require(moduleName);
    } catch {
      throw new Error(
        'msnodesqlv8 is not installed. Install it with: npm install msnodesqlv8 (Windows only)',
      );
    }
  }
  return msnodesqlv8Value;
}

// ---- Column extraction ----

function extractNativeColumns(meta: any[]): QueryResultColumn[] {
  const res = meta.map((col) => {
    let dataType = col.sqlType?.toLowerCase() || 'unknown';
    const resCol: QueryResultColumn = {
      columnName: col.name,
      dataType,
      notNull: !col.nullable,
      tableName: col.tableName || undefined,
      tableSchema: col.schemaName || undefined,
      sourceColumnName: col.columnName || col.baseColumnName || undefined,
    };

    if (resCol.dataType.endsWith(' identity')) {
      resCol.dataType = resCol.dataType.replace(' identity', '');
      resCol.autoIncrement = true;
    }
    if (col.size && resCol.dataType.includes('char')) {
      resCol.dataType += `(${col.size})`;
    }
    return resCol;
  });

  makeUniqueColumnNames(res);
  return res;
}

// ---- Connection ----

async function connectWithDriver(
  { server, host, port, user, username, password, database, authType }: MssqlConnectionOptions,
  driver: string,
): Promise<any> {
  const effectiveServer = server || host || 'localhost';
  const effectiveUser = user || username || '';

  let connectionString = `server=${effectiveServer}`;
  if (port && !effectiveServer.includes('\\')) connectionString += `,${port}`;
  connectionString += `;Driver={${driver}}`;

  if (authType === 'sspi') {
    connectionString += ';Trusted_Connection=Yes';
  } else {
    connectionString += `;UID=${effectiveUser};PWD=${password || ''}`;
  }

  if (database) {
    connectionString += `;Database=${extractDbNameFromComposite(database)}`;
  }
  connectionString += ';CHARSET=UTF8';

  return new Promise((resolve, reject) => {
    getMsnodesqlv8().open(connectionString, (err: Error | null, conn: any) => {
      if (err) reject(err);
      else resolve(conn);
    });
  });
}

export async function nativeConnect(
  connection: MssqlConnectionOptions,
  logger?: any,
): Promise<DatabaseHandle> {
  const drivers = ['ODBC Driver 17 for SQL Server', 'SQL Server Native Client 11.0'];

  for (const driver of drivers) {
    try {
      const conn = await connectWithDriver(connection, driver);
      logger?.info?.(`[MSSQL-V2] Connected via native driver: ${driver}`);
      return {
        client: conn,
        database: connection.database || undefined,
        connectionType: 'msnodesqlv8',
      };
    } catch (err: any) {
      if (err.message?.includes('[ODBC Driver Manager]')) {
        logger?.warn?.(`[MSSQL-V2] Failed with ${driver}, trying next:`, err.message);
        continue;
      }
      throw err;
    }
  }

  throw new Error('No suitable ODBC driver found. Install "ODBC Driver 17 for SQL Server".');
}

// ---- Query ----

export async function nativeQueryCore(
  dbhan: DatabaseHandle,
  sql: string,
  _options?: any,
): Promise<QueryResult> {
  if (sql == null) {
    return { rows: [], columns: [] };
  }

  return new Promise((resolve, reject) => {
    let columns: QueryResultColumn[] = [];
    let currentRow: Record<string, any> | null = null;
    const q = dbhan.client.query(sql);
    const rows: Record<string, any>[] = [];

    q.on('meta', (meta: any[]) => {
      columns = extractNativeColumns(meta);
    });

    q.on('column', (index: number, data: any) => {
      if (currentRow && columns[index]) {
        currentRow[columns[index].columnName] = data;
      }
    });

    q.on('row', (_index: number) => {
      if (currentRow) rows.push(currentRow);
      currentRow = {};
    });

    q.on('error', (err: Error) => reject(err));

    q.on('done', () => {
      if (currentRow) rows.push(currentRow);
      resolve({ columns, rows });
    });
  });
}

// ---- Read query (streaming) ----

export function nativeReadQuery(
  dbhan: DatabaseHandle,
  sql: string,
  structure?: any,
): PassThrough {
  const pass = new PassThrough({ objectMode: true, highWaterMark: 100 });

  let columns: QueryResultColumn[] = [];
  let currentRow: Record<string, any> | null = null;
  const q = dbhan.client.query(sql);

  q.on('meta', (meta: any[]) => {
    columns = extractNativeColumns(meta);
    pass.write({
      __isStreamHeader: true,
      ...(structure || { columns }),
    });
  });

  q.on('column', (index: number, data: any) => {
    if (currentRow && columns[index]) {
      currentRow[columns[index].columnName] = data;
    }
  });

  q.on('row', (_index: number) => {
    if (currentRow) pass.write(currentRow);
    currentRow = {};
  });

  q.on('error', (err: Error) => {
    console.error('[MSSQL-V2] Native read query error:', err.message);
    pass.end();
  });

  q.on('done', () => {
    if (currentRow) pass.write(currentRow);
    pass.end();
  });

  return pass;
}

// ---- Streaming query ----

export function nativeStream(
  dbhan: DatabaseHandle,
  sql: string,
  options: StreamOptions,
): void {
  let columns: QueryResultColumn[] = [];
  let currentRow: Record<string, any> | null = null;
  const q = dbhan.client.query(sql);

  q.on('meta', (meta: any[]) => {
    if (currentRow) options.row(currentRow);
    currentRow = null;
    columns = extractNativeColumns(meta);
    options.recordset(columns);
  });

  q.on('column', (index: number, data: any) => {
    if (currentRow && columns[index]) {
      currentRow[columns[index].columnName] = data;
    }
  });

  q.on('row', (_index: number) => {
    if (currentRow) options.row(currentRow);
    currentRow = {};
  });

  q.on('error', (err: Error) => {
    options.info?.({
      message: err.message,
      time: new Date(),
      severity: 'error',
    });
    options.done?.();
  });

  q.on('info', (info: any) => {
    options.info?.({
      message: info.message,
      severity: 'info',
      time: new Date(),
    });
  });

  q.on('done', () => {
    if (currentRow) options.row(currentRow);
    options.done?.();
  });
}
