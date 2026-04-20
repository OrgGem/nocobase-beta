import { Application } from '@nocobase/server';
import { Database } from '@nocobase/database';

export class CloneEngineService {
  app: Application;
  concurrencyLimit: number = 3;

  constructor(app: Application) {
    this.app = app;
  }

  getCache() {
    return this.app.cache;
  }

  /**
   * Update task status in both cache and DB
   */
  async updateTaskStatus(taskId: number, status: string) {
    await this.getCache().set(`CloneTask:${taskId}:status`, status);
    await this.app.db.getRepository('clone_tasks').update({ filterByTk: taskId, values: { status } });
  }

  /**
   * Run clone process in background by task ID
   */
  async startTask(taskId: number, options: { chunkSize?: number } = {}) {
    const chunkSize = options.chunkSize || 1000;
    const taskTablesRepo = this.app.db.getRepository('clone_task_tables');

    const task = await this.app.db.getRepository('clone_tasks').findById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    await this.updateTaskStatus(taskId, 'running');

    try {
      const pendingTables = await taskTablesRepo.find({
        filter: {
          task_id: taskId,
          status: { $in: ['pending', 'running', 'paused'] },
        },
      });

      const runWorker = async (iterator: IterableIterator<any>) => {
        for (const table of iterator) {
          const currentStatus = await this.getCache().get(`CloneTask:${taskId}:status`);
          if (currentStatus === 'paused') break;

          try {
            await this.syncTable(task, table, taskId, chunkSize);

            const endStatus = await this.getCache().get(`CloneTask:${taskId}:status`);
            if (endStatus !== 'paused') {
              await taskTablesRepo.update({ filterByTk: table.id, values: { status: 'completed' } });
            }
          } catch (error) {
            this.app.logger.error(`Sync table ${table.table_name} failed:`, error);
            await taskTablesRepo.update({
              filterByTk: table.id,
              values: { status: 'error', error_message: error.message },
            });
          }
        }
      };

      const iterator = pendingTables[Symbol.iterator]();
      const workers = new Array(this.concurrencyLimit).fill(iterator).map(runWorker);

      await Promise.allSettled(workers);

      const finalStatus = await this.getCache().get(`CloneTask:${taskId}:status`);
      if (finalStatus === 'paused') {
        // Mark all still-running tables as paused
        await taskTablesRepo.update({
          filter: { task_id: taskId, status: 'running' },
          values: { status: 'paused' },
        });
      } else {
        await this.updateTaskStatus(taskId, 'completed');
      }
    } catch (error) {
      this.app.logger.error(`Task ${taskId} failed with unhandled error:`, error);
      await this.updateTaskStatus(taskId, 'error');
      throw error;
    }
  }

  async pauseTask(taskId: number) {
    await this.updateTaskStatus(taskId, 'paused');
  }

  /**
   * Build a SELECT query with LIMIT/TOP depending on dialect
   */
  private buildSelectQuery(
    dialect: string,
    quotedTable: string,
    quotedColumn: string,
    chunkSize: number,
    hasFilter: boolean,
  ): string {
    const filterSql = hasFilter ? `WHERE ${quotedColumn} > ?` : '';

    if (dialect === 'mssql') {
      return `SELECT TOP ${chunkSize} * FROM ${quotedTable} ${filterSql} ORDER BY ${quotedColumn} ASC`;
    }
    // postgres, mysql, sqlite
    return `SELECT * FROM ${quotedTable} ${filterSql} ORDER BY ${quotedColumn} ASC LIMIT ${chunkSize}`;
  }

  /**
   * Sync a single table in chunks
   */
  private async syncTable(task: any, tableInfo: any, taskId: number, chunkSize: number) {
    const sourceDb: Database = (this.app.dataSourceManager.get(task.source_datasource_key).collectionManager as any).db;
    const targetDb: Database = (this.app.dataSourceManager.get(task.target_datasource_key).collectionManager as any).db;
    const cache = this.getCache();
    const cacheKey = `CloneTaskTable:${tableInfo.id}:last_sync_value`;

    await this.app.db.getRepository('clone_task_tables').update({
      filterByTk: tableInfo.id,
      values: { status: 'running' },
    });

    let last_sync_value = (await cache.get(cacheKey)) || tableInfo.last_sync_value;
    let cloned_records = tableInfo.cloned_records || 0;
    const { sort_column, table_name } = tableInfo;

    // Quote identifiers to prevent SQL injection
    const qi = sourceDb.sequelize.getQueryInterface();
    const quotedTable = qi.quoteIdentifier(table_name);
    const quotedColumn = qi.quoteIdentifier(sort_column);
    const dialect = sourceDb.sequelize.getDialect();

    const targetQi = targetDb.sequelize.getQueryInterface();
    const targetQuotedTable = targetQi.quoteIdentifier(table_name);

    while (true) {
      const status = await cache.get(`CloneTask:${taskId}:status`);
      if (status === 'paused') break;

      const lastSyncParams = last_sync_value ? [last_sync_value] : [];
      const query = this.buildSelectQuery(dialect, quotedTable, quotedColumn, chunkSize, !!last_sync_value);

      const [rows] = await sourceDb.sequelize.query(query, { bind: lastSyncParams });

      if (!rows || rows.length === 0) break;

      try {
        if (dialect === 'mssql') {
          await targetDb.sequelize.query(`SET IDENTITY_INSERT ${targetQuotedTable} ON`).catch(() => null);
        }
        await targetDb.sequelize.getQueryInterface().bulkInsert(table_name, rows as any[]);
        if (dialect === 'mssql') {
          await targetDb.sequelize.query(`SET IDENTITY_INSERT ${targetQuotedTable} OFF`).catch(() => null);
        }
      } catch (err) {
        this.app.logger.warn(`Bulk insert failed for table ${table_name}`, err);
        throw err;
      }

      last_sync_value = rows[rows.length - 1][sort_column];
      cloned_records += rows.length;

      // High-frequency update to cache
      await cache.set(cacheKey, last_sync_value);
      // Persist to DB
      await this.app.db.getRepository('clone_task_tables').update({
        filterByTk: tableInfo.id,
        values: {
          last_sync_value: String(last_sync_value),
          cloned_records: cloned_records,
        },
      });
    }
  }
}
