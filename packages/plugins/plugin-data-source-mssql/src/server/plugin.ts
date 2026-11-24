// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/server';
import { MssqlExternalDataSource, type MssqlDataSourceOptions } from './data-source/MssqlExternalDataSource';
import { Database, filterMatch } from '@nocobase/database';
import { MssqlDialect } from './dialects/mssql-dialect';
import { isValidFilter } from '@nocobase/utils';
import { cloneDeep, isEqual, omit, pick } from 'lodash';
import type { CollectionOptions, LoadedCollections } from '@nocobase/data-source-manager';
import type { Model } from '@nocobase/database';
import type { Transaction } from 'sequelize';
import { withLockedDataSource } from './selection';

type DataSourceRecord = Model & { loadLocalData(): Promise<LoadedCollections> };
type MssqlSyncMessage =
  | { type: 'selectionChanged'; dataSourceKey: string; refreshTables?: string[] }
  | { type: 'tablesLoaded'; dataSourceKey: string; tableNames?: string[] }
  | { type: 'dataSourceRemoved'; dataSourceKey: string };

export class PluginDataSourceMssqlServer extends Plugin {
  private selectionSyncs = new Map<string, Promise<void>>();
  private trackedSources = new Map<string, MssqlExternalDataSource>();

  async beforeLoad() {
    Database.registerDialect(MssqlDialect);
    this.app.dataSourceManager.factory.register('mssql', MssqlExternalDataSource);
  }

  private async closeRemovedDataSource(dataSourceKey: string, target?: MssqlExternalDataSource): Promise<void> {
    const tracked = target ?? this.trackedSources.get(dataSourceKey);
    const active = this.app.dataSourceManager.get(dataSourceKey);
    const candidate = tracked ?? (active instanceof MssqlExternalDataSource ? active : undefined);
    if (!candidate) {
      return;
    }
    if (this.trackedSources.get(dataSourceKey) === candidate) {
      this.trackedSources.delete(dataSourceKey);
    }
    if (active === candidate) {
      this.app.dataSourceManager.dataSources.delete(dataSourceKey);
    }
    try {
      await candidate.close();
    } catch {
      this.app.log.warn(`[MSSQL] Failed to close removed datasource ${dataSourceKey}`);
    }
  }

  async load() {
    this.app.dataSourceManager.afterAddDataSource((dataSource) => {
      if (dataSource instanceof MssqlExternalDataSource) {
        const previous = this.trackedSources.get(dataSource.name);
        if (
          previous &&
          previous !== dataSource &&
          previous.collectionManager?.db !== dataSource.collectionManager?.db
        ) {
          previous.close().catch(() => {
            this.app.log.warn(`[MSSQL] Failed to close replaced datasource ${dataSource.name}`);
          });
        }
        this.trackedSources.set(dataSource.name, dataSource);
        this.reconcileSelection(dataSource.name).catch(() => {
          this.app.log.warn('[MSSQL] Failed to reconcile selected collections after datasource reload');
        });
      }
    });

    this.app.db.on('dataSources.afterDestroy', async (model: Model, options?: { transaction?: Transaction }) => {
      const dataSourceKey = model.get('key');
      const type = model.get('type');
      if (typeof dataSourceKey !== 'string' || !dataSourceKey) {
        return;
      }
      const active = this.app.dataSourceManager.get(dataSourceKey);
      const target =
        this.trackedSources.get(dataSourceKey) ?? (active instanceof MssqlExternalDataSource ? active : undefined);
      if (!target && type !== 'mssql') {
        return;
      }

      const closeOnDestroy = () => this.closeRemovedDataSource(dataSourceKey, target);
      if (options?.transaction && typeof options.transaction.afterCommit === 'function') {
        options.transaction.afterCommit(closeOnDestroy);
      } else {
        await closeOnDestroy();
      }

      await this.sendSyncMessage({ type: 'dataSourceRemoved', dataSourceKey }, { transaction: options?.transaction });
    });

    this.app.resourceManager.registerPreActionHandler('dataSources:readTables', async (ctx, next) => {
      const { dataSourceKey, dbOptions } = ctx.action.params.values || {};
      if (dbOptions?.type !== 'mssql') {
        await next();
        return;
      }

      const manager = this.app.dataSourceManager;
      const resolvedDbOptions = this.app.environment?.renderJsonTemplate
        ? this.app.environment.renderJsonTemplate(dbOptions)
        : dbOptions;
      const probe = manager.factory.create('mssql', {
        name: dataSourceKey,
        ...resolvedDbOptions,
        connectTimeout: resolvedDbOptions.connectTimeout ?? 10000,
        requestTimeout: resolvedDbOptions.requestTimeout ?? 15000,
        slowQueryThresholdMs: 0,
        pool: { max: 1, min: 0, acquire: 15000, idle: 1000, ...(resolvedDbOptions.pool || {}) },
      }) as MssqlExternalDataSource;
      const owned = ![...manager.dataSources.values()].includes(probe);
      let requestFailed = false;
      let requestError: unknown;
      try {
        ctx.body = await probe.readTables();
      } catch (error) {
        requestFailed = true;
        requestError = error;
      } finally {
        if (owned) {
          try {
            await probe.close();
          } catch (error) {
            if (requestFailed) {
              this.app.log.warn('[MSSQL] Failed to close temporary table-list connection');
            } else {
              requestFailed = true;
              requestError = error;
            }
          }
        }
      }
      if (requestFailed) throw requestError;
    });

    this.app.resourceManager.registerPreActionHandler('dataSources:loadTables', async (ctx, next) => {
      const { dataSourceKey, tables } = ctx.action.params.values || {};
      const dataSource = this.app.dataSourceManager.get(dataSourceKey);
      if (!(dataSource instanceof MssqlExternalDataSource)) {
        await next();
        return;
      }
      if (!Array.isArray(tables) || tables.some((name) => typeof name !== 'string' || !name)) {
        ctx.throw(400, 'Invalid table list');
      }
      const tableNames = [...new Set(tables)] as string[];
      const row = (await this.app.db.getRepository('dataSources').findOne({
        filterByTk: dataSourceKey,
      })) as DataSourceRecord | null;
      if (!row) ctx.throw(404, 'Data source not found');
      const configuration = cloneDeep(omit(row.get('options') || {}, 'selectedCollections'));
      const resolvedConfiguration = this.app.environment.renderJsonTemplate(configuration);
      const activeConfiguration = pick(dataSource.options, Object.keys(resolvedConfiguration));
      if (!isEqual(activeConfiguration, resolvedConfiguration))
        ctx.throw(409, 'Data source changed; retry loading tables');
      // Validate the entire batch before changing either the runtime or the stored selection.
      // Do not embed a pre-transaction metadata snapshot: a concurrent delete may remove it.
      const prepared = await dataSource.prepareTables(tableNames);
      const selectedMode = await withLockedDataSource(this.app.db, dataSourceKey, async (locked, transaction) => {
        const options = locked.get('options') as MssqlDataSourceOptions;
        if (!isEqual(omit(options || {}, 'selectedCollections'), configuration)) {
          ctx.throw(409, 'Data source changed; retry loading tables');
        }
        if (options?.addAllCollections !== false || !Array.isArray(options.selectedCollections)) return false;
        const selectedCollections = [...new Set([...options.selectedCollections, ...tableNames])];
        if (!isEqual(selectedCollections, options.selectedCollections)) {
          locked.set('options', { ...options, selectedCollections });
          // Core's options hooks reconnect and reload before commit; sync explicitly after commit instead.
          await locked.save({ transaction, hooks: false });
        }
        return true;
      });

      if (selectedMode) {
        const ready = new Map(tableNames.map((name, index) => [name, prepared[index]]));
        try {
          await this.reconcileSelection(dataSourceKey, ready, dataSource, configuration, tableNames);
        } finally {
          await this.sendSyncMessage({ type: 'selectionChanged', dataSourceKey, refreshTables: tableNames });
        }
      } else if (this.app.dataSourceManager.get(dataSourceKey) === dataSource) {
        const latest = (await this.app.db.getRepository('dataSources').findOne({
          filterByTk: dataSourceKey,
        })) as DataSourceRecord | null;
        const localData = (await latest?.loadLocalData()) || {};
        if (
          this.app.dataSourceManager.get(dataSourceKey) !== dataSource ||
          !isEqual(omit(latest?.get('options') || {}, 'selectedCollections'), configuration)
        ) {
          ctx.throw(409, 'Data source changed; retry loading tables');
        }
        for (const collection of prepared) {
          this.defineMergedCollection(dataSource, collection, localData);
        }
        if (tableNames.length > 0) {
          await this.sendSyncMessage({ type: 'tablesLoaded', dataSourceKey, tableNames });
        }
      }
    });

    this.app.resourceManager.registerPreActionHandler('dataSources.collections:destroy', async (ctx, next) => {
      const { associatedIndex, filterByTk, filter } = ctx.action.params;
      const dataSourceKey = ctx.action.sourceId || associatedIndex;
      const dataSource = this.app.dataSourceManager.get(dataSourceKey);
      if (!(dataSource instanceof MssqlExternalDataSource)) {
        await next();
        return;
      }
      const current = await this.app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey });
      if (!current) {
        await next();
        return;
      }
      const requested = (Array.isArray(filterByTk) ? filterByTk : [filterByTk]).filter(
        (name): name is string => typeof name === 'string' && name.length > 0,
      );
      if (filterByTk !== undefined && filterByTk !== null && requested.length === 0) {
        ctx.body = true;
        return;
      }
      if (Array.isArray(filterByTk) && requested.length !== filterByTk.length) {
        ctx.throw(400, 'Invalid collection names');
      }
      if (!requested.length && !isValidFilter(filter)) {
        ctx.body = true;
        return;
      }
      const result = await withLockedDataSource(this.app.db, dataSourceKey, async (model, transaction) => {
        const collections = this.app.db.getRepository('dataSourcesCollections');
        const hasFilter = isValidFilter(filter);
        const options = model.get('options') as MssqlDataSourceOptions;
        const resolvedConfiguration = this.app.environment.renderJsonTemplate(
          omit(options || {}, 'selectedCollections'),
        );
        if (!isEqual(pick(dataSource.options, Object.keys(resolvedConfiguration)), resolvedConfiguration)) {
          ctx.throw(409, 'Data source changed; retry deleting collections');
        }
        let names = requested;
        if (hasFilter || !requested.length) {
          const records = await collections.find({
            filter: { $and: [{ dataSourceKey }, ...(hasFilter ? [filter] : [])] },
            transaction,
            context: ctx,
          });
          const matching = new Set(records.map((record) => String(record.get('name'))));
          for (const collection of dataSource.collectionManager.getCollections()) {
            if (!hasFilter || filterMatch(collection.options, filter)) {
              matching.add(collection.name);
            }
          }
          names = requested.length ? requested.filter((name) => matching.has(name)) : [...matching];
        }
        const tableNames = names.flatMap((name) => {
          const physical = dataSource.collectionManager.getCollection(name)?.options.tableName;
          if (typeof physical === 'string') return [physical];
          const schema = dataSource.collectionManager.db.options.schema || 'dbo';
          const matching = (options.selectedCollections || []).filter(
            (tableName) => dataSource.introspector.tableInfoToCollectionOptions({ tableName, schema }).name === name,
          );
          return matching.length ? matching : [name];
        });
        if (names.length) {
          // The core row hooks mutate the live collection manager before commit. Suppress them
          // here and perform equivalent runtime removal and peer sync only after commit.
          await this.app.db.getRepository('dataSourcesFields').destroy({
            filter: { dataSourceKey, collectionName: { $in: names } },
            transaction,
            individualHooks: false,
            hooks: false,
            context: ctx,
          });
          await collections.destroy({
            filter: { dataSourceKey, name: { $in: names } },
            transaction,
            individualHooks: false,
            hooks: false,
            context: ctx,
          });
        }
        const selectedMode = options?.addAllCollections === false && Array.isArray(options.selectedCollections);
        if (selectedMode) {
          const selectedCollections = options.selectedCollections.filter((name) => !tableNames.includes(name));
          if (selectedCollections.length !== options.selectedCollections.length) {
            model.set('options', { ...options, selectedCollections });
            await model.save({ transaction, hooks: false });
          }
        }
        return { names, selectedMode };
      });

      if (result.selectedMode) {
        try {
          await this.reconcileSelection(dataSourceKey);
        } finally {
          await this.sendSyncMessage({ type: 'selectionChanged', dataSourceKey });
        }
      } else {
        const manager = this.app.pm.get('data-source-manager');
        for (const name of result.names) {
          const exists =
            dataSource.collectionManager.hasCollection?.(name) ??
            Boolean(dataSource.collectionManager.getCollection?.(name));
          if (exists) {
            dataSource.collectionManager.removeCollection(name);
          }
          await manager?.sendSyncMessage({ type: 'removeDataSourceCollection', dataSourceKey, collectionName: name });
        }
      }
      ctx.body = true;
    });
  }

  async handleSyncMessage(message: MssqlSyncMessage) {
    if (message?.type === 'selectionChanged') {
      const refreshTables = Array.isArray(message.refreshTables)
        ? message.refreshTables.filter((name) => typeof name === 'string')
        : [];
      await this.reconcileSelection(message.dataSourceKey, new Map(), undefined, undefined, refreshTables);
      return;
    }
    if (message?.type === 'tablesLoaded' && typeof message.dataSourceKey === 'string') {
      const tableNames = Array.isArray(message.tableNames)
        ? message.tableNames.filter((name): name is string => typeof name === 'string' && name.length > 0)
        : [];
      await this.syncLoadedTables(message.dataSourceKey, tableNames);
      return;
    }
    if (message?.type === 'dataSourceRemoved' && typeof message.dataSourceKey === 'string') {
      await this.closeRemovedDataSource(message.dataSourceKey);
    }
  }

  private async enqueueSync(dataSourceKey: string, work: () => Promise<void>) {
    const previous = this.selectionSyncs.get(dataSourceKey) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    this.selectionSyncs.set(dataSourceKey, pending);
    try {
      await pending;
    } finally {
      if (this.selectionSyncs.get(dataSourceKey) === pending) {
        this.selectionSyncs.delete(dataSourceKey);
      }
    }
  }

  private defineMergedCollection(
    dataSource: MssqlExternalDataSource,
    collection: CollectionOptions,
    localData: LoadedCollections,
    previous?: ReturnType<MssqlExternalDataSource['collectionManager']['getCollections']>[number],
  ) {
    const [merged] = dataSource.mergeWithLoadedCollections([collection], localData);
    merged.introspected = true;
    merged.repository = 'mssql-repo';
    const existing = previous ?? dataSource.collectionManager.getCollection?.(merged.name);
    const previousOptions = existing && {
      ...existing.options,
      fields: existing.getFields().map((field) => field.options),
    };
    if (existing) {
      dataSource.collectionManager.removeCollection(existing.name);
    } else if (dataSource.collectionManager.hasCollection?.(merged.name)) {
      dataSource.collectionManager.removeCollection(merged.name);
    }
    try {
      dataSource.collectionManager.defineCollection(merged);
    } catch (error) {
      if (previousOptions) {
        dataSource.collectionManager.defineCollection(previousOptions);
      }
      throw error;
    }
  }

  private async syncLoadedTables(dataSourceKey: string, tableNames: string[]) {
    await this.enqueueSync(dataSourceKey, async () => {
      const targets = [...new Set(tableNames)];
      if (!targets.length) return;
      const dataSource = this.app.dataSourceManager.get(dataSourceKey);
      if (!(dataSource instanceof MssqlExternalDataSource)) return;
      const model = (await this.app.db.getRepository('dataSources').findOne({
        filterByTk: dataSourceKey,
      })) as DataSourceRecord | null;
      if (!model) return;
      const options = model.get('options') as MssqlDataSourceOptions | undefined;
      const configuration = omit(options || {}, 'selectedCollections');
      const resolvedConfiguration = this.app.environment.renderJsonTemplate(configuration);
      if (!isEqual(pick(dataSource.options, Object.keys(resolvedConfiguration)), resolvedConfiguration)) return;

      const selectedCollections = options?.selectedCollections;
      const allowed =
        options?.addAllCollections === false && Array.isArray(selectedCollections)
          ? targets.filter((name) => selectedCollections.includes(name))
          : targets;
      if (!allowed.length) return;

      try {
        const localData = (await model.loadLocalData()) || {};
        const prepared = await dataSource.prepareTables(allowed, localData);
        if (this.app.dataSourceManager.get(dataSourceKey) !== dataSource) return;
        for (const collection of prepared) {
          this.defineMergedCollection(dataSource, collection, localData);
        }
      } catch {
        this.app.log.warn(`[MSSQL] Failed to sync loaded tables for datasource ${dataSourceKey}`);
      }
    });
  }

  private async reconcileSelection(
    dataSourceKey: string,
    prepared = new Map<string, CollectionOptions>(),
    preparedSource?: MssqlExternalDataSource,
    preparedConfiguration?: Record<string, unknown>,
    refreshTables: string[] = [],
  ) {
    await this.enqueueSync(dataSourceKey, async () => {
      const dataSource = this.app.dataSourceManager.get(dataSourceKey);
      if (!(dataSource instanceof MssqlExternalDataSource)) return;
      const model = (await this.app.db.getRepository('dataSources').findOne({
        filterByTk: dataSourceKey,
      })) as DataSourceRecord | null;
      const options = model?.get('options') as MssqlDataSourceOptions | undefined;
      if (options?.addAllCollections !== false || !Array.isArray(options.selectedCollections)) return;
      const configuration = omit(options, 'selectedCollections');
      const resolvedConfiguration = this.app.environment.renderJsonTemplate(configuration);
      if (!isEqual(pick(dataSource.options, Object.keys(resolvedConfiguration)), resolvedConfiguration)) return;
      if (preparedSource !== dataSource || !isEqual(preparedConfiguration, configuration)) prepared.clear();

      const selected = new Set(options.selectedCollections);
      const existing = dataSource.collectionManager.getCollections();
      const physicalName = (collection: (typeof existing)[number]) =>
        typeof collection.options.tableName === 'string' ? collection.options.tableName : collection.name;
      const loaded = new Set(existing.map(physicalName));
      const missing = [...selected].filter((name) => !loaded.has(name));
      const targets = [...new Set([...missing, ...refreshTables.filter((name) => selected.has(name))])];
      if (this.app.dataSourceManager.get(dataSourceKey) !== dataSource) return;
      for (const collection of existing) {
        if (!selected.has(physicalName(collection))) dataSource.collectionManager.removeCollection(collection.name);
      }
      (dataSource.options as MssqlDataSourceOptions).addAllCollections = false;
      (dataSource.options as MssqlDataSourceOptions).selectedCollections = [...selected];
      if (!targets.length) return;
      const localData = await model.loadLocalData();
      const schema = dataSource.collectionManager.db.options.schema || 'dbo';
      const unpreparedTargets = targets.filter((name) => !prepared.has(name));
      if (unpreparedTargets.length > 0) {
        dataSource.introspector.invalidateTables?.(unpreparedTargets);
      }
      const ftsMode =
        (resolvedConfiguration as MssqlDataSourceOptions | undefined)?.fullTextSearchMode ??
        (dataSource.options as MssqlDataSourceOptions | undefined)?.fullTextSearchMode;
      if (ftsMode !== 'off') {
        await dataSource.introspector.preloadFTSIndexedColumns(schema, [...selected]);
      }
      if (unpreparedTargets.length > 1) {
        await dataSource.introspector.preloadAllColumns?.(schema, unpreparedTargets);
        await dataSource.introspector.preloadAllPrimaryKeys?.(schema, unpreparedTargets);
        await dataSource.introspector.preloadAllIndexes?.(schema, unpreparedTargets);
      }
      for (const name of targets) {
        const wasPrepared = prepared.has(name);
        try {
          const collection =
            prepared.get(name) ||
            (
              await dataSource.prepareTables([name], localData, {
                skipFtsPreload: true,
                skipCacheInvalidation: true,
              })
            )[0];
          if (this.app.dataSourceManager.get(dataSourceKey) !== dataSource) return;
          const previous = existing.find((item) => physicalName(item) === name);
          this.defineMergedCollection(dataSource, collection, localData, previous);
        } catch (error) {
          // A stale selected table must not prevent removing a different table or syncing its selection.
          this.app.log.warn(`[MSSQL] Failed to restore selected collection ${name}`);
          if (wasPrepared) throw error;
        }
      }
    });
  }
}

export default PluginDataSourceMssqlServer;
