/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import type { DataSource, LoadedCollections } from '@nocobase/data-source-manager';
import type { Collection, Model } from '@nocobase/database';
import { Plugin } from '@nocobase/server';
import { cloneDeep, isEqual, omit, pick } from 'lodash';
import type { Transaction } from 'sequelize';
import { DATA_SOURCE_TYPE } from '../constants';
import { PostgresSQLCollection } from './collections/sql-collection';
import { PostgresTreeCollection } from './collections/tree-collection';
import {
  buildArrayForeignKeyField,
  fieldReferencesColumn,
  getRelationLockTables,
  removesPhysicalColumn,
  syncFieldAction,
} from './hooks/field-hooks';
import { PostgresDataSource } from './postgres-datasource';
import { checkSQL } from './utils/sql-validator';
import { PostgresValidationError, translate, translateError } from './utils/validation-error';

const FIELD_ACTIONS = new Set(['create', 'update', 'apply', 'destroy']);
const WRITE_ACTIONS = new Set([
  'create',
  'firstOrCreate',
  'updateOrCreate',
  'update',
  'destroy',
  'destroyMany',
  'updateMany',
  'add',
  'remove',
  'set',
  'toggle',
  'move',
  'importXlsx',
]);

type FieldValues = {
  name?: string;
  type?: string;
  field?: string;
  interface?: string;
  allowNull?: boolean;
  defaultValue?: unknown;
  unique?: boolean;
  settings?: FieldValues;
  [key: string]: unknown;
};

const PRESET_FIELDS: Record<string, FieldValues> = {
  id: { name: 'id', type: 'bigInt', interface: 'id', primaryKey: true, autoIncrement: true, allowNull: false },
  createdAt: { name: 'createdAt', type: 'date', interface: 'createdAt', field: 'createdAt' },
  updatedAt: { name: 'updatedAt', type: 'date', interface: 'updatedAt', field: 'updatedAt' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractSql(values: Record<string, unknown> | undefined): unknown {
  if (!values) return undefined;
  if (values.sql !== undefined) return values.sql;
  return isRecord(values.options) ? values.options.sql : undefined;
}

function names(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some((item) => typeof item !== 'string' || !item)) {
    throw new PostgresValidationError('A collection name is required');
  }
  return [...new Set(values as string[])];
}

function prepareFields(values: Record<string, unknown>): void {
  if (!Array.isArray(values.fields)) return;
  const hasStringPresets = values.fields.some((field) => typeof field === 'string');
  if (hasStringPresets || (values.template === 'general' && values.fields.length === 0)) {
    const selectedPresets = new Set(values.fields.filter((field): field is string => typeof field === 'string'));
    values.autoGenId = selectedPresets.has('id');
    values.createdAt = selectedPresets.has('createdAt');
    values.updatedAt = selectedPresets.has('updatedAt');
    values.timestamps = Boolean(values.createdAt || values.updatedAt);
  } else if (values.createdAt === false && values.updatedAt === false && values.timestamps === undefined) {
    values.timestamps = false;
  }
  const mapped: FieldValues[] = values.fields.map((field: FieldValues | string) => {
    if (typeof field !== 'string') return field;
    const preset = PRESET_FIELDS[field];
    if (!preset) throw new PostgresValidationError('Unknown preset field {{name}}', { name: field });
    return cloneDeep(preset);
  });
  const isSql = extractSql(values) !== undefined || values.template === 'sql';
  if (!isSql) {
    if (values.createdAt === true && !mapped.some((field) => field.name === 'createdAt')) {
      mapped.push(cloneDeep(PRESET_FIELDS.createdAt));
    }
    if (values.updatedAt === true && !mapped.some((field) => field.name === 'updatedAt')) {
      mapped.push(cloneDeep(PRESET_FIELDS.updatedAt));
    }
  }
  values.fields = mapped;
}

async function localizeValidationErrors(ctx: Context, next: Next) {
  try {
    await next();
  } catch (error) {
    if (error instanceof PostgresValidationError) error.message = translateError(ctx, error);
    const params = ctx.action?.params || {};
    const postgresConnection =
      ctx.action?.resourceName === 'dataSources' &&
      (params.values?.type === DATA_SOURCE_TYPE ||
        ctx.app?.dataSourceManager?.get(params.filterByTk) instanceof PostgresDataSource);
    if (
      postgresConnection &&
      error instanceof Error &&
      error.message === 'Test connection failed: Invalid PostgreSQL port'
    ) {
      error.message = translate(ctx, 'Test connection failed: {{reason}}', {
        reason: translate(ctx, 'Invalid PostgreSQL port'),
      });
      const httpError = error as Error & { status?: number; statusCode?: number };
      httpError.status = 400;
      httpError.statusCode = 400;
    }
    throw error;
  }
}

type PostgresSyncMessage = {
  type?: string;
  dataSourceKey?: string;
  collectionName?: string;
  collectionNames?: string[];
  tableNames?: string[];
  refreshTables?: string[];
  fieldName?: string;
};

export class PluginDataSourcePostgresServer extends Plugin {
  private selectionSyncs = new Map<string, Promise<void>>();
  private activeSources = new Map<string, PostgresDataSource>();

  private async closeDataSource(dataSourceKey: string, expectedSource?: PostgresDataSource) {
    const current = this.app.dataSourceManager.get(dataSourceKey);
    const tracked = this.activeSources.get(dataSourceKey);
    const source = expectedSource || (current instanceof PostgresDataSource ? current : tracked);
    if (!source) return;
    if (tracked === source) {
      this.activeSources.delete(dataSourceKey);
    }
    if (current === source) {
      this.app.dataSourceManager.dataSources.delete(dataSourceKey);
    }
    const replacement = this.app.dataSourceManager.get(dataSourceKey);
    if (
      replacement instanceof PostgresDataSource &&
      replacement !== source &&
      replacement.collectionManager.db === source.collectionManager.db
    ) {
      return;
    }
    try {
      await source.close();
    } catch (error) {
      this.app.log?.warn?.(`Failed to close PostgreSQL data source "${dataSourceKey}"`, { cause: error });
    }
  }

  private async enqueueSelectionSync(key: string, task: () => Promise<void>) {
    const previous = this.selectionSyncs.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.selectionSyncs.set(key, current);
    try {
      await current;
    } finally {
      if (this.selectionSyncs.get(key) === current) this.selectionSyncs.delete(key);
    }
  }

  async handleSyncMessage(message: PostgresSyncMessage) {
    if (!message?.dataSourceKey) return;
    const key = message.dataSourceKey;
    if (message.type === 'dataSourceRemoved') {
      const existingRecord = await this.app.db?.getRepository?.('dataSources')?.findOne?.({ filterByTk: key });
      if (existingRecord) return;
      await this.closeDataSource(key);
      return;
    }
    if (message.type === 'selectionChanged') {
      const refreshTables = Array.isArray(message.refreshTables)
        ? message.refreshTables.filter((name): name is string => typeof name === 'string' && name.length > 0)
        : [];
      await this.enqueueSelectionSync(key, () => this.reconcileSelection(key, refreshTables));
      return;
    }

    if (message.type === 'tablesLoaded' && Array.isArray(message.tableNames)) {
      const tableNames = message.tableNames;
      await this.enqueueSelectionSync(key, () => this.syncLoadedTables(key, tableNames));
      return;
    }

    const source = this.app.dataSourceManager.get(key);
    if (!(source instanceof PostgresDataSource)) return;

    if (message.type === 'collectionCreated' && message.collectionName) {
      await this.syncCreatedCollection(source, key, message.collectionName);
      return;
    }

    if (message.type === 'collectionRemoved' && Array.isArray(message.collectionNames)) {
      for (const name of message.collectionNames) {
        if (typeof name === 'string' && source.collectionManager.hasCollection(name)) {
          source.collectionManager.removeCollection(name);
        }
      }
      return;
    }

    if (message.type === 'fieldRemoved' && message.collectionName && message.fieldName) {
      const collection = source.collectionManager.getCollection(message.collectionName);
      if (collection?.getField(message.fieldName)) {
        collection.removeField(message.fieldName);
      }
    }
  }

  private async syncLoadedTables(dataSourceKey: string, tableNames: string[]) {
    const source = this.app.dataSourceManager.get(dataSourceKey);
    if (!(source instanceof PostgresDataSource)) return;
    const requested = [
      ...new Set(tableNames.filter((name): name is string => typeof name === 'string' && name.length > 0)),
    ];
    if (!requested.length) return;
    const record = (await this.app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey })) as
      | (Model & { loadLocalData?: () => Promise<LoadedCollections> })
      | null;
    if (!record) return;
    const storedOptions = typeof record.get === 'function' ? record.get('options') || {} : {};
    const selectedFilter =
      storedOptions.addAllCollections === false && Array.isArray(storedOptions.selectedCollections)
        ? new Set(storedOptions.selectedCollections.filter((name: unknown): name is string => typeof name === 'string'))
        : undefined;
    const allowed = selectedFilter ? requested.filter((name) => selectedFilter.has(name)) : requested;
    if (!allowed.length) return;
    const localData = typeof record.loadLocalData === 'function' ? await record.loadLocalData() : {};
    const available = new Set(await source.introspector.getTables());
    const targets = allowed.filter((name) => available.has(name));
    if (!targets.length) return;
    const collections = await source.prepareTables(targets, localData);
    if (this.app.dataSourceManager.get(dataSourceKey) !== source) return;
    source.collectionManager.replaceCollections(collections);
  }

  private async syncCreatedCollection(source: PostgresDataSource, dataSourceKey: string, collectionName: string) {
    const collectionRecord = await this.app.db.getRepository('dataSourcesCollections').findOne({
      filter: { dataSourceKey, name: collectionName },
    });
    if (!collectionRecord) return;
    const fieldRecords = await this.app.db.getRepository('dataSourcesFields').find({
      filter: { dataSourceKey, collectionName },
    });
    const collectionOptions = {
      ...collectionRecord.toJSON(),
      fields: fieldRecords.map((field) => field.toJSON()),
    };
    if (typeof collectionOptions.sql === 'string' && collectionOptions.sql.trim()) {
      const existing = source.collectionManager.getCollection(collectionName);
      if (existing) {
        existing.updateOptions(collectionOptions);
      } else {
        source.collectionManager.defineCollection({
          ...collectionOptions,
          tableName: typeof collectionOptions.tableName === 'string' ? collectionOptions.tableName : collectionName,
          introspected: true,
        });
      }
      return;
    }
    const tableName = typeof collectionOptions.tableName === 'string' ? collectionOptions.tableName : collectionName;
    const [prepared] = await source.prepareTables([tableName], { [collectionName]: collectionOptions });
    if (this.app.dataSourceManager.get(dataSourceKey) !== source || !prepared) return;
    const existing = source.collectionManager.getCollection(collectionName);
    if (existing) {
      existing.updateOptions(prepared);
    } else {
      source.collectionManager.defineCollection(prepared);
    }
  }

  private async reconcileSelection(dataSourceKey: string, refreshTables: string[] = []) {
    const source = this.app.dataSourceManager.get(dataSourceKey);
    if (!(source instanceof PostgresDataSource)) return;
    const record = await this.app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey });
    if (!record) return;
    const storedOptions = record.get('options') || {};
    if (storedOptions.addAllCollections !== false || !Array.isArray(storedOptions.selectedCollections)) return;
    const resolvedOptions = this.app.environment.renderJsonTemplate(storedOptions);
    const activeOptions = pick(source.options, Object.keys(resolvedOptions));
    const selectAll = source.options.addAllCollections ?? source.options.autoDiscover !== false;
    if (
      selectAll ||
      !isEqual(
        omit(activeOptions, ['selectedCollections', 'addAllCollections']),
        omit(resolvedOptions, ['selectedCollections', 'addAllCollections']),
      )
    )
      return;

    const selected = new Set<string>(
      storedOptions.selectedCollections.filter((name: unknown): name is string => typeof name === 'string'),
    );
    const available = new Set(await source.introspector.getTables());
    const localData = await record.loadLocalData();
    const existing = source.collectionManager.getCollections();
    const physicalName = (collection: Collection) => {
      const table = collection.model.getTableName();
      return typeof table === 'string' ? table : table.tableName;
    };
    const missing = [...selected].filter(
      (name) => available.has(name) && !existing.some((item) => physicalName(item) === name),
    );
    const refreshed = refreshTables.filter((name) => selected.has(name) && available.has(name));
    const targets = [...new Set([...missing, ...refreshed])];
    const collections = await source.prepareTables(targets, localData);
    if (this.app.dataSourceManager.get(dataSourceKey) !== source) return;
    source.collectionManager.replaceCollections(collections);
    for (const collection of existing) {
      if (!collection.options.sql && !selected.has(physicalName(collection))) {
        source.collectionManager.removeCollection(collection.name);
      }
    }
    source.options = { ...source.options, addAllCollections: false, selectedCollections: [...selected] };
  }

  async beforeLoad() {
    this.app.dataSourceManager.registerDataSourceType(DATA_SOURCE_TYPE, PostgresDataSource);
    this.app.dataSourceManager.beforeAddDataSource((dataSource: DataSource) => {
      if (!(dataSource instanceof PostgresDataSource)) return;
      const { db } = dataSource.collectionManager;
      db.collectionFactory.registerCollectionType(PostgresSQLCollection, {
        condition: (options) => Boolean(options.sql),
        async onSync() {},
        async onDump() {},
      });
      db.collectionFactory.registerCollectionType(PostgresTreeCollection, {
        condition: (options) => Boolean(options.postgresTree || options.template === 'tree'),
      });
      dataSource.resourceManager.use(localizeValidationErrors, {
        tag: 'postgres-validation-errors',
        after: ['auth'],
        before: ['acl'],
      });
      dataSource.resourceManager.use(
        async (ctx, next) => {
          if (WRITE_ACTIONS.has(ctx.action?.actionName)) {
            const resourceName = ctx.action?.resourceName;
            const [sourceName, associationName] = typeof resourceName === 'string' ? resourceName.split('.') : [];
            const sourceCollection = sourceName ? dataSource.collectionManager.getCollection(sourceName) : undefined;
            const targetCollection =
              sourceCollection && associationName && resourceName
                ? dataSource.collectionManager.getCollection(resourceName)
                : undefined;
            const throughName = associationName && sourceCollection?.getField(associationName)?.options?.through;
            const throughCollection =
              typeof throughName === 'string' ? dataSource.collectionManager.getCollection(throughName) : undefined;
            const isReadOnly = (collection?: Collection | null) =>
              Boolean(collection?.options?.view || collection?.options?.sql);
            if (isReadOnly(sourceCollection) || isReadOnly(targetCollection) || isReadOnly(throughCollection)) {
              ctx.throw(403, translate(ctx, 'This collection is read-only'));
            }
          }
          await next();
        },
        { tag: 'postgres-read-only-collections', after: ['acl'] },
      );
    });
    this.app.dataSourceManager.afterAddDataSource((dataSource: DataSource) => {
      if (dataSource instanceof PostgresDataSource) {
        this.activeSources.set(dataSource.name, dataSource);
      }
    });
  }

  async load() {
    this.app.db?.on?.(
      'dataSources.afterDestroy',
      async (
        model: Model,
        options?: { transaction?: Transaction & { afterCommit?: (fn: () => Promise<void> | void) => void } },
      ) => {
        if (model.get('type') !== DATA_SOURCE_TYPE) return;
        const key = String(model.get('key') || '');
        if (!key) return;
        const current = this.app.dataSourceManager.get(key);
        const target = current instanceof PostgresDataSource ? current : this.activeSources.get(key);
        if (target && this.activeSources.get(key) === target) {
          this.activeSources.delete(key);
        }
        const close = () => (target ? this.closeDataSource(key, target) : Promise.resolve());
        if (options?.transaction && typeof options.transaction.afterCommit === 'function') {
          options.transaction.afterCommit(close);
        } else {
          await close();
        }
        await this.sendSyncMessage(
          { type: 'dataSourceRemoved', dataSourceKey: key },
          options?.transaction ? { transaction: options.transaction } : undefined,
        );
      },
    );
    this.app.resourceManager.registerPreActionHandler('dataSources:readTables', async (ctx, next) => {
      const { dataSourceKey, dbOptions } = ctx.action.params.values || {};
      if (dbOptions?.type !== DATA_SOURCE_TYPE) {
        await next();
        return;
      }

      const manager = this.app.dataSourceManager;
      const renderedOptions = this.app.environment?.renderJsonTemplate
        ? this.app.environment.renderJsonTemplate(dbOptions)
        : dbOptions;
      const probe = manager.factory.create(DATA_SOURCE_TYPE, {
        name: dataSourceKey,
        ...renderedOptions,
        pool: { max: 1, min: 0, acquire: 10000, idle: 1000 },
      }) as PostgresDataSource;
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
              this.app.log?.warn?.('[PostgreSQL] Failed to close temporary table-list connection');
            } else {
              requestFailed = true;
              requestError = error;
            }
          }
        }
      }
      if (requestFailed) throw requestError;
    });

    this.app.resourceManager.use(localizeValidationErrors, {
      tag: 'postgres-validation-errors',
      after: ['auth'],
      before: ['acl'],
    });
    this.app.resourceManager.use(
      async (ctx: Context, next: Next) => {
        const { resourceName, actionName, params } = ctx.action || {};
        if (resourceName === 'dataSources.collections') {
          const dataSource = this.app.dataSourceManager.get(params.associatedIndex);
          if (dataSource instanceof PostgresDataSource) {
            if (actionName === 'create' || actionName === 'destroy') {
              await this.mutateCollection(ctx, dataSource, next);
              return;
            }
            if (actionName === 'update') {
              const sql = extractSql(params.values as Record<string, unknown> | undefined);
              if (sql !== undefined) {
                const existing = dataSource.collectionManager.getCollection(params.filterByTk);
                if (!existing?.options?.sql) {
                  ctx.throw(400, translate(ctx, 'Only SQL collections can update SQL queries'));
                }
                checkSQL(typeof sql === 'string' ? sql : '');
              }
              await next();
              const targetName = typeof params.filterByTk === 'string' ? params.filterByTk : '';
              if (targetName) {
                await this.sendSyncMessage({
                  type: 'collectionCreated',
                  dataSourceKey: dataSource.name,
                  collectionName: targetName,
                });
              }
              return;
            }
          }
        }

        if (resourceName === 'dataSourcesCollections.fields' && FIELD_ACTIONS.has(actionName)) {
          const index = String(params.associatedIndex || '');
          const separator = index.indexOf('.');
          const indexDataSourceKey = separator !== -1 ? index.slice(0, separator) : '';
          const indexCollectionName = separator !== -1 ? index.slice(separator + 1) : '';
          const rawBody = (ctx.request as { body?: unknown } | undefined)?.body;
          const input = (params.values || (isRecord(rawBody) ? rawBody : {})) as FieldValues;
          const dataSourceKey =
            actionName === 'apply' && typeof input.dataSourceKey === 'string' && input.dataSourceKey
              ? input.dataSourceKey
              : indexDataSourceKey;
          const collectionName =
            actionName === 'apply' && typeof input.collectionName === 'string' && input.collectionName
              ? input.collectionName
              : indexCollectionName;
          const dataSource = dataSourceKey && collectionName && this.app.dataSourceManager.get(dataSourceKey);
          if (dataSource instanceof PostgresDataSource) {
            await this.mutateField(ctx, dataSource, collectionName, input, next);
            return;
          }
        }
        await next();
      },
      { tag: 'postgres-schema-actions', after: ['acl'] },
    );
  }

  private async mutateCollection(ctx: Context, source: PostgresDataSource, next: Next) {
    const manager = source.collectionManager;
    const { actionName, params } = ctx.action;
    const values = (params.values || {}) as Record<string, unknown>;
    if (actionName === 'create') {
      const [name] = names(values.name);
      prepareFields(values);
      if (manager.hasCollection(name)) ctx.throw(409, translate(ctx, 'Collection {{name}} already exists', { name }));
      const sql = extractSql(values);
      if (sql !== undefined || values.template === 'sql') {
        checkSQL(typeof sql === 'string' ? sql : '');
        await next();
        await this.sendSyncMessage({ type: 'collectionCreated', dataSourceKey: source.name, collectionName: name });
        return;
      }
      if (values.view || values.template === 'view') {
        ctx.throw(400, translate(ctx, 'Use Load tables to import an existing view'));
      }

      let createdCollection: Collection | undefined;
      await manager.db.sequelize.transaction(async (transaction) => {
        await manager.db.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:table, 0))', {
          replacements: { table: `${manager.db.options.schema || 'public'}.${String(values.tableName || name)}` },
          transaction,
        });
        if (manager.hasCollection(name)) ctx.throw(409, translate(ctx, 'Collection {{name}} already exists', { name }));
        if (!(await manager.createTable(values, transaction)))
          ctx.throw(409, translate(ctx, 'Table {{name}} already exists', { name }));
        createdCollection = manager.getCollection(name);
      });

      try {
        await next();
      } catch (error) {
        try {
          await manager.dropTable(name, false);
        } catch (cleanupError) {
          this.app.log?.warn?.(`Failed to roll back PostgreSQL table "${name}" after metadata error`, {
            cause: cleanupError,
          });
        }
        if (createdCollection && manager.getCollection(name) === createdCollection) manager.removeCollection(name);
        throw error;
      }
      await source.addSelectedTables(ctx, [String(values.tableName || name)]);
      await this.sendSyncMessage({ type: 'collectionCreated', dataSourceKey: source.name, collectionName: name });
      return;
    }

    const collectionNames = names(params.filterByTk);
    const snapshots = collectionNames.map((name) => {
      const collection = manager.getCollection(name);
      if (!collection) ctx.throw(404, translate(ctx, 'Collection {{name}} does not exist', { name }));
      return {
        name,
        physicalName: String(collection.options.tableName || name),
        isSql: Boolean(collection.options.sql),
        options: cloneDeep({
          ...collection.options,
          tableName: String(collection.options.tableName || name),
          fields: collection.getFields().map((field) => field.options),
        }),
      };
    });
    const cascade = params.cascade === true || params.cascade === 'true';
    try {
      await manager.db.sequelize.transaction(async (transaction) => {
        for (const snapshot of [...snapshots].sort((left, right) =>
          left.physicalName.localeCompare(right.physicalName),
        )) {
          await manager.db.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:table, 0))', {
            replacements: { table: `${manager.db.options.schema || 'public'}.${snapshot.physicalName}` },
            transaction,
          });
          if (!snapshot.isSql) await manager.dropTable(snapshot.name, cascade, transaction);
        }
        await next();
      });
    } catch (error) {
      for (const snapshot of snapshots) {
        if (!manager.hasCollection(snapshot.name)) manager.defineCollection(snapshot.options);
      }
      throw error;
    }
    const fieldsRepo = this.app.db?.getRepository?.('dataSourcesFields') as
      | { destroy?: (options: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    if (fieldsRepo && typeof fieldsRepo.destroy === 'function') {
      try {
        await fieldsRepo.destroy({
          filter: { dataSourceKey: source.name, collectionName: { $in: collectionNames } },
          individualHooks: false,
          hooks: false,
        });
      } catch (cleanupError) {
        this.app.log?.warn?.(`Failed to clean up orphaned field metadata for PostgreSQL data source "${source.name}"`, {
          cause: cleanupError,
        });
      }
    }
    for (const snapshot of snapshots) {
      if (manager.hasCollection(snapshot.name)) manager.removeCollection(snapshot.name);
    }
    await source.removeSelectedTables(
      ctx,
      snapshots.map((snapshot) => snapshot.physicalName),
    );
    await this.sendSyncMessage({
      type: 'collectionRemoved',
      dataSourceKey: source.name,
      collectionNames: snapshots.map((snapshot) => snapshot.name),
    });
  }

  private async mutateField(
    ctx: Context,
    source: PostgresDataSource,
    collectionName: string,
    input: FieldValues,
    next: Next,
  ) {
    const manager = source.collectionManager;
    const collection = manager.getCollection(collectionName);
    if (!collection) ctx.throw(404, translate(ctx, 'Collection {{name}} does not exist', { name: collectionName }));
    const action = ctx.action.actionName;
    const { params } = ctx.action;
    const fieldName = params.filterByTk;
    if (Array.isArray(fieldName)) ctx.throw(400, translate(ctx, 'Delete one field at a time'));
    if (collection.options.sql) {
      await next();
      if (action === 'destroy' && typeof fieldName === 'string') {
        if (collection.getField(fieldName)) collection.removeField(fieldName);
        await this.sendSyncMessage({
          type: 'fieldRemoved',
          dataSourceKey: source.name,
          collectionName,
          fieldName,
        });
      }
      return;
    }
    if (collection.options.view) {
      const targetName = fieldName || input.name;
      if (action === 'create' || action === 'destroy' || !targetName || !collection.getField(targetName)) {
        ctx.throw(403, translate(ctx, 'This collection is read-only'));
      }
      await next();
      return;
    }
    if (action === 'destroy' && typeof fieldName === 'string' && removesPhysicalColumn(collection, fieldName)) {
      const columnName = collection.getField(fieldName)?.columnName() || fieldName;
      const references = await ctx.db.getRepository('dataSourcesFields').find({
        filter: { dataSourceKey: source.name },
      });
      if (
        references.some((field) =>
          fieldReferencesColumn(field.toJSON(), field.get('collectionName'), collectionName, [fieldName, columnName]),
        )
      ) {
        ctx.throw(400, translate(ctx, 'Field {{name}} is referenced by another field', { name: fieldName }));
      }
    }
    const snapshot = cloneDeep({ ...collection.options, fields: collection.getFields().map((field) => field.options) });
    const lockTables = getRelationLockTables(
      manager,
      collectionName,
      input,
      typeof fieldName === 'string' ? fieldName : undefined,
    );
    let metadataActionStarted = false;
    try {
      await manager.db.sequelize.transaction(async (transaction) => {
        for (const table of lockTables) {
          await manager.db.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:table, 0))', {
            replacements: { table },
            transaction,
          });
        }
        await syncFieldAction(manager, action, collectionName, fieldName, input, transaction);
        metadataActionStarted = true;
        await next();
      });
    } catch (error) {
      const current = manager.getCollection(collectionName);
      if (metadataActionStarted && current) {
        current.resetFields();
        current.updateOptions(snapshot);
      }
      throw error;
    }
    if (action === 'destroy' && typeof fieldName === 'string') {
      if (manager.getCollection(collectionName)?.getField(fieldName)) {
        manager.getCollection(collectionName).removeField(fieldName);
      }
      await this.sendSyncMessage({
        type: 'fieldRemoved',
        dataSourceKey: source.name,
        collectionName,
        fieldName,
      });
      return;
    }
    const savedName = typeof fieldName === 'string' && fieldName ? fieldName : input.name;
    const savedRelation = savedName
      ? manager.getCollection(collectionName)?.getField(savedName)?.options || input
      : input;
    const companion = buildArrayForeignKeyField(manager, collectionName, savedRelation);
    if (companion && typeof companion.name === 'string') {
      manager.getCollection(collectionName)?.setField(companion.name, companion);
      const fieldsRepo = (this.app.db || ctx.db)?.getRepository?.('dataSourcesFields') as
        | {
            findOne?: (options: Record<string, unknown>) => Promise<unknown>;
            create?: (options: Record<string, unknown>) => Promise<unknown>;
          }
        | undefined;
      if (fieldsRepo && typeof fieldsRepo.findOne === 'function' && typeof fieldsRepo.create === 'function') {
        try {
          const existingRecord = await fieldsRepo.findOne({
            filter: { dataSourceKey: source.name, collectionName, name: companion.name },
          });
          if (!existingRecord) {
            await fieldsRepo.create({
              values: { ...companion, collectionName, dataSourceKey: source.name },
            });
          }
        } catch (companionError) {
          this.app.log?.warn?.(
            `Failed to persist companion array field "${collectionName}.${companion.name}" for PostgreSQL data source "${source.name}"`,
            { cause: companionError },
          );
        }
      }
    }
  }
}

export default PluginDataSourcePostgresServer;
