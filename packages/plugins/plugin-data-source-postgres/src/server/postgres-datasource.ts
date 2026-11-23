/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { Database, DatabaseOptions } from '@nocobase/database';
import {
  CollectionOptions,
  DatabaseIntrospector,
  LoadedCollections,
  LoadTablesOptions,
  SequelizeDataSource,
} from '@nocobase/data-source-manager';
import { QueryTypes } from 'sequelize';
import { NAMESPACE } from '../constants';
import { PostgresCollectionManager } from './postgres-collection-manager';
import { PostgresValidationError } from './utils/validation-error';

interface PostgresOptions {
  host?: string;
  port?: string | number;
  database?: string;
  username?: string;
  password?: string;
  schema?: string;
  ssl?: boolean;
  sslCa?: string;
  autoDiscover?: boolean;
  addAllCollections?: boolean;
  selectedCollections?: string[];
  databaseInstance?: Database;
  collectionManager?: { database?: Database };
  logger?: DatabaseOptions['logger'];
  pool?: DatabaseOptions['pool'];
}

function databaseOptions(options: PostgresOptions): DatabaseOptions {
  const parsedPort = Number(options.port || 5432);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new PostgresValidationError('Invalid PostgreSQL port');
  }
  return {
    dialect: 'postgres',
    host: options.host,
    port: parsedPort,
    database: options.database,
    username: options.username,
    password: options.password,
    schema: options.schema || 'public',
    logger: options.logger,
    logging: false,
    dialectOptions: {
      connectionTimeoutMillis: 10000,
      ssl: options.ssl ? { rejectUnauthorized: true, ...(options.sslCa ? { ca: options.sslCa } : {}) } : false,
    },
    pool: { max: 10, min: 0, idle: 30000, acquire: 10000, ...(options.pool || {}) },
  };
}

function selectedTables(names: unknown): string[] {
  return Array.isArray(names)
    ? [...new Set(names.filter((name): name is string => typeof name === 'string' && name.length > 0))]
    : [];
}

export class PostgresDataSource extends SequelizeDataSource {
  declare collectionManager: PostgresCollectionManager;
  private isLoaded = false;
  private isClosed = false;
  private reusedDatabase: boolean;

  constructor(options: PostgresOptions) {
    super(options);
    this.reusedDatabase =
      options.databaseInstance instanceof Database || options.collectionManager?.database instanceof Database;
  }

  createCollectionManager(options: PostgresOptions = {}): PostgresCollectionManager {
    const existing = options.databaseInstance || options.collectionManager?.database;
    const database = existing instanceof Database ? existing : new Database(databaseOptions(options));
    return new PostgresCollectionManager({
      ...options.collectionManager,
      database,
      collectionsFilter: (collection) =>
        collection.options.introspected || collection.options.dataCategory !== 'system',
    });
  }

  createDatabaseIntrospector(db: Database): DatabaseIntrospector {
    const introspector = super.createDatabaseIntrospector(db);
    const baseGetColumns = introspector.getTableColumnsInfo.bind(introspector);
    // The manager calls getTables directly for a temporary source when saving settings.
    introspector.getTables = async () => {
      try {
        return await this.collectionManager.discoverTables();
      } finally {
        if (!this.isLoaded) await this.close();
      }
    };
    introspector.getTableColumnsInfo = async (tableInfo: { tableName: string; schema?: string }) => {
      const schema = tableInfo.schema || db.options.schema || 'public';
      try {
        return await baseGetColumns(tableInfo);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('No description found for ')) {
          throw error;
        }
        const columns = await this.collectionManager.describeMaterializedView(schema, tableInfo.tableName);
        if (columns) return columns;
        if (await this.collectionManager.hasZeroUserColumns(schema, tableInfo.tableName)) return {};
        throw error;
      }
    };
    introspector.getTableConstraints = async (tableInfo: { tableName: string; schema?: string }) => {
      const schema = tableInfo.schema || db.options.schema || 'public';
      return this.collectionManager.getSingleColumnUniqueIndexes(schema, tableInfo.tableName);
    };
    return introspector;
  }

  static async testConnection(options: PostgresOptions = {}): Promise<boolean> {
    const database = new Database(databaseOptions(options));
    try {
      await database.sequelize.authenticate();
      return true;
    } finally {
      await database.close();
    }
  }

  async load(options: { localData?: LoadedCollections } = {}): Promise<void> {
    const localData = options.localData || {};
    this.isLoaded = true;
    try {
      await this.collectionManager.db.sequelize.authenticate();
      const settings = this.options as PostgresOptions;
      const loadAll = settings.addAllCollections ?? settings.autoDiscover !== false;
      const available = await this.introspector.getTables();
      const sqlCollections = Object.values(localData)
        .filter((collection) => typeof collection.sql === 'string' && collection.sql.trim())
        .map((collection) => ({
          ...collection,
          tableName: typeof collection.tableName === 'string' ? collection.tableName : collection.name,
          fields: collection.fields || [],
          introspected: true,
        }));
      const sqlNames = new Set(sqlCollections.map((collection) => collection.name));
      const requested = loadAll
        ? available
        : Array.isArray(settings.selectedCollections)
          ? selectedTables(settings.selectedCollections)
          : Object.values(localData).map((collection) =>
              typeof collection.tableName === 'string' ? collection.tableName : collection.name,
            );
      const existing = new Set(available);
      const names = requested.filter((name) => {
        if (sqlNames.has(name)) return false;
        if (existing.has(name)) return true;
        this.logger?.warn?.(`PostgreSQL table "${name}" is unavailable`);
        return false;
      });
      const collections = await this.prepareTables(names, localData);
      collections.push(...sqlCollections);
      this.collectionManager.replaceCollections(collections);

      const expected = new Set(collections.map((collection) => collection.name));
      for (const collection of this.collectionManager.getCollections()) {
        if (!expected.has(collection.name)) {
          this.collectionManager.removeCollection(collection.name);
        }
      }
    } catch (error) {
      this.isLoaded = false;
      if (!this.reusedDatabase) await this.close();
      throw error;
    }
  }

  async readTables(): Promise<Array<{ name: string }>> {
    const tables = await this.introspector.getTables();
    return tables.map((name) => ({ name }));
  }

  async loadTables(ctx: Context, tables: string[] = [], options: LoadTablesOptions = {}): Promise<void> {
    const names = selectedTables(tables);
    const { actionName, resourceName, params } = ctx.action || {};
    const isSettingsAction = resourceName === 'dataSources' && ['create', 'update'].includes(actionName);
    const isLoadTablesAction = resourceName === 'dataSources' && actionName === 'loadTables';
    const preserveSelection = Boolean(params.values?.__postgresPreserveSelection);
    if (params.values && '__postgresPreserveSelection' in params.values) {
      delete params.values.__postgresPreserveSelection;
    }
    if (isSettingsAction && Array.isArray(params.values?.collections) && !preserveSelection) {
      params.values.options = {
        ...params.values.options,
        addAllCollections: false,
        selectedCollections: names,
      };
    }
    try {
      let localData = options.localData;
      if (!localData && isLoadTablesAction && ctx.db) {
        const record = (await ctx.db.getRepository('dataSources').findOne({
          filterByTk: this.name,
        })) as { loadLocalData?: () => Promise<LoadedCollections> } | null;
        if (record && typeof record.loadLocalData === 'function') {
          localData = await record.loadLocalData();
        }
      }
      const collections = await this.prepareTables(names, localData || {});
      this.collectionManager.replaceCollections(collections);
      if (isLoadTablesAction) {
        const updatedSelection = await this.addSelectedTables(ctx, names, names);
        if (!updatedSelection && names.length) {
          const plugin = ctx.app?.pm?.get(NAMESPACE) || ctx.app?.pm?.get('data-source-postgres');
          if (plugin) {
            await plugin.sendSyncMessage({
              type: 'tablesLoaded',
              dataSourceKey: this.name,
              tableNames: names,
            });
          }
        }
      }
    } finally {
      if (!this.isLoaded) await this.close();
    }
  }

  async prepareTables(tables: string[], localData: LoadedCollections = {}): Promise<CollectionOptions[]> {
    const tableNames = selectedTables(tables);
    if (!tableNames.length) return [];
    const schema = this.collectionManager.db.options.schema || 'public';

    const identityRows = await this.collectionManager.db.sequelize.query<{ tableName: string; name: string }>(
      `SELECT table_name AS "tableName", column_name AS name FROM information_schema.columns
       WHERE table_schema = :schema AND table_name IN (:tableNames) AND is_identity = 'YES'`,
      { replacements: { schema, tableNames }, type: QueryTypes.SELECT },
    );
    const identityByTable = new Map<string, Set<string>>();
    for (const row of identityRows) {
      let cols = identityByTable.get(row.tableName);
      if (!cols) {
        cols = new Set<string>();
        identityByTable.set(row.tableName, cols);
      }
      cols.add(row.name);
    }

    const kindsByTable = await this.collectionManager.getTableKinds(tableNames);
    const collections = new Array<CollectionOptions>(tableNames.length);
    let nextIndex = 0;

    const runWorker = async () => {
      while (nextIndex < tableNames.length) {
        const index = nextIndex;
        nextIndex += 1;
        const tableName = tableNames[index];
        const kind = kindsByTable.get(tableName);
        const isView = kind === 'v' || kind === 'm';
        const saved = localData[tableName] || Object.values(localData).find((item) => item.tableName === tableName);
        const inferred = await this.introspector.getCollection({
          tableInfo: { tableName, schema },
          localOptions: { ...(isView ? { view: true } : {}), ...(saved || {}) },
        });
        inferred.name = saved?.name || inferred.name;
        inferred.tableName = tableName;
        inferred.schema = schema;
        const [merged] = this.mergeWithLoadedCollections(
          [inferred],
          saved ? { ...localData, [inferred.name]: saved } : localData,
        );
        const identityNames = identityByTable.get(tableName);
        if (identityNames?.size) {
          for (const field of merged.fields || []) {
            if (identityNames.has(field.field || field.name)) field.autoIncrement = true;
          }
        }
        const primaryKeys = (merged.fields || []).filter((field) => field.primaryKey).map((field) => field.name);
        if (!saved?.filterTargetKey && primaryKeys.length) {
          merged.filterTargetKey = primaryKeys.length === 1 ? primaryKeys[0] : primaryKeys;
        }
        merged.introspected = true;
        merged.from = merged.from || 'dbsync';
        if (isView) {
          merged.view = true;
          merged.viewName = tableName;
          merged.template = 'view';
          merged.writableView = false;
        }
        collections[index] = merged;
      }
    };

    const concurrency = Math.min(5, tableNames.length);
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    return collections;
  }

  async addSelectedTables(ctx: Context, names: string[], refreshTables?: string[]): Promise<boolean> {
    return this.updateSelectedTables(ctx, names, [], refreshTables);
  }

  async removeSelectedTables(ctx: Context, names: string[]): Promise<boolean> {
    return this.updateSelectedTables(ctx, [], names);
  }

  private async updateSelectedTables(
    ctx: Context,
    additions: string[],
    removals: string[],
    refreshTables?: string[],
  ): Promise<boolean> {
    if (!additions.length && !removals.length) return false;
    const repository = ctx.db.getRepository('dataSources');
    let updated: string[] | undefined;
    await ctx.db.sequelize.transaction(async (transaction) => {
      const source = await repository.findOne({ filterByTk: this.name, transaction, lock: transaction.LOCK.UPDATE });
      if (!source) throw new PostgresValidationError('Data source {{name}} does not exist', { name: this.name });
      const current = source.get('options') as PostgresOptions;
      if (current.addAllCollections ?? current.autoDiscover !== false) return;
      const existing =
        current.selectedCollections ||
        this.collectionManager.getCollections().map((collection) => {
          const table = collection.model.getTableName();
          return typeof table === 'string' ? table : table.tableName;
        });
      const removed = new Set(removals);
      const selected = selectedTables([...existing, ...additions]).filter((name) => !removed.has(name));
      if (
        Array.isArray(current.selectedCollections) &&
        selected.length === current.selectedCollections.length &&
        selected.every((name, index) => name === current.selectedCollections[index])
      )
        return;
      source.set('options', { ...current, addAllCollections: false, selectedCollections: selected });
      await source.save({ transaction, hooks: false });
      updated = selected;
    });
    if (!updated) return false;
    if (ctx.app.dataSourceManager.get(this.name) === this) {
      this.options = { ...this.options, addAllCollections: false, selectedCollections: updated };
    }
    const plugin = ctx.app.pm.get(NAMESPACE) || ctx.app.pm.get('data-source-postgres');
    if (plugin) {
      await plugin.sendSyncMessage({
        type: 'selectionChanged',
        dataSourceKey: this.name,
        ...(refreshTables?.length ? { refreshTables } : {}),
      });
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    await this.collectionManager.db.close();
  }
}
