// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import type { Database } from '@nocobase/database';

const READ_ONLY_VIEW_GUARD_INSTALLED = Symbol('mssqlReadOnlyViewGuardInstalled');

const WRITE_ACTION_NAMES = new Set([
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

const RELATION_LINK_ACTIONS = new Set(['add', 'remove', 'set', 'toggle']);

export interface ViewCollectionLike {
  name?: string;
  isView?: () => boolean;
  options?: {
    view?: boolean;
    viewName?: string;
    tableName?: string;
    schema?: string;
    writableView?: boolean;
  };
  model?: {
    tableName?: string;
  };
  collectionSchema?: () => string | undefined;
  getField?: (name: string) => { options?: { type?: string; target?: string; through?: string } } | undefined;
}

export class MssqlReadOnlyViewError extends Error {
  status = 403;
  statusCode = 403;

  constructor(message = 'This collection is read-only') {
    super(message);
    this.name = 'MssqlReadOnlyViewError';
  }
}

export function isReadOnlyViewCollection(collection?: ViewCollectionLike | null): boolean {
  if (!collection) {
    return false;
  }
  const isView = (typeof collection.isView === 'function' && collection.isView()) || Boolean(collection.options?.view);
  return isView && !collection.options?.writableView;
}

type TableTarget = string | { tableName?: string; schema?: string } | undefined;

type ModelTargetLike = {
  name?: string;
  tableName?: string;
  options?: { schema?: string };
  collection?: ViewCollectionLike;
};

function resolveCollectionByModelOrTable(
  db: Database,
  modelCandidate: unknown,
  tableNameArg: TableTarget,
): ViewCollectionLike | undefined {
  const model =
    modelCandidate && (typeof modelCandidate === 'object' || typeof modelCandidate === 'function')
      ? (modelCandidate as ModelTargetLike)
      : undefined;
  if (model?.collection) {
    return model.collection;
  }
  if (typeof model?.name === 'string') {
    const byModelName =
      (typeof db.getCollectionByModelName === 'function' ? db.getCollectionByModelName(model.name) : undefined) ??
      (typeof db.getCollection === 'function' ? db.getCollection(model.name) : undefined);
    if (byModelName) {
      return byModelName as ViewCollectionLike;
    }
  }
  const rawTableName =
    typeof tableNameArg === 'string'
      ? tableNameArg
      : tableNameArg && typeof tableNameArg === 'object'
        ? tableNameArg.tableName
        : model?.tableName;
  if (!rawTableName) {
    return undefined;
  }
  const rawSchema = tableNameArg && typeof tableNameArg === 'object' ? tableNameArg.schema : model?.options?.schema;
  const collections = db.collections instanceof Map ? db.collections.values() : [];
  let matchedWritable: ViewCollectionLike | undefined;
  for (const collection of collections) {
    const typed = collection as ViewCollectionLike;
    const collectionTable = typed.model?.tableName ?? typed.options?.viewName ?? typed.options?.tableName ?? typed.name;
    if (collectionTable !== rawTableName) {
      continue;
    }
    const collectionSchema =
      (typeof typed.collectionSchema === 'function' ? typed.collectionSchema() : undefined) ??
      typed.options?.schema ??
      db.options?.schema;
    if (rawSchema && collectionSchema && collectionSchema !== rawSchema) {
      continue;
    }
    if (isReadOnlyViewCollection(typed)) {
      return typed;
    }
    matchedWritable = typed;
  }
  return matchedWritable;
}

function assertWritableWriteTarget(db: Database, modelCandidate: unknown, tableNameArg: TableTarget): void {
  const collection = resolveCollectionByModelOrTable(db, modelCandidate, tableNameArg);
  if (isReadOnlyViewCollection(collection)) {
    throw new MssqlReadOnlyViewError();
  }
}

type GuardedQueryInterface = Record<string, unknown> & {
  [READ_ONLY_VIEW_GUARD_INSTALLED]?: boolean;
};

function wrapQueryInterfaceWriteMethod(
  qi: GuardedQueryInterface,
  db: Database,
  methodName: string,
  extractTarget: (args: unknown[]) => { modelCandidate: unknown; tableNameArg: TableTarget },
): void {
  const original = qi[methodName];
  if (typeof original !== 'function') {
    return;
  }
  const originalFn = original as (...args: unknown[]) => unknown;
  qi[methodName] = function (this: unknown, ...args: unknown[]) {
    const { modelCandidate, tableNameArg } = extractTarget(args);
    assertWritableWriteTarget(db, modelCandidate, tableNameArg);
    return originalFn.apply(this, args);
  };
}

export function installMssqlReadOnlyViewGuard(db: Database): void {
  if (typeof db?.sequelize?.getQueryInterface !== 'function') {
    return;
  }
  const qi = db.sequelize.getQueryInterface() as unknown as GuardedQueryInterface | undefined;
  if (!qi || qi[READ_ONLY_VIEW_GUARD_INSTALLED]) {
    return;
  }
  qi[READ_ONLY_VIEW_GUARD_INSTALLED] = true;

  wrapQueryInterfaceWriteMethod(qi, db, 'insert', (args) => ({
    modelCandidate: (args[0] as { constructor?: unknown } | undefined)?.constructor,
    tableNameArg: args[1] as TableTarget,
  }));
  wrapQueryInterfaceWriteMethod(qi, db, 'bulkInsert', (args) => ({
    modelCandidate: (args[2] as { model?: unknown } | undefined)?.model,
    tableNameArg: args[0] as TableTarget,
  }));
  wrapQueryInterfaceWriteMethod(qi, db, 'update', (args) => ({
    modelCandidate: (args[0] as { constructor?: unknown } | undefined)?.constructor,
    tableNameArg: args[1] as TableTarget,
  }));
  wrapQueryInterfaceWriteMethod(qi, db, 'bulkUpdate', (args) => ({
    modelCandidate: (args[3] as { model?: unknown } | undefined)?.model,
    tableNameArg: args[0] as TableTarget,
  }));
  wrapQueryInterfaceWriteMethod(qi, db, 'delete', (args) => ({
    modelCandidate: (args[0] as { constructor?: unknown } | undefined)?.constructor,
    tableNameArg: args[1] as TableTarget,
  }));
  wrapQueryInterfaceWriteMethod(qi, db, 'bulkDelete', (args) => ({
    modelCandidate: args[3] ?? (args[2] as { model?: unknown } | undefined)?.model,
    tableNameArg: args[0] as TableTarget,
  }));
  wrapQueryInterfaceWriteMethod(qi, db, 'upsert', (args) => ({
    modelCandidate: (args[4] as { model?: unknown } | undefined)?.model,
    tableNameArg: args[0] as TableTarget,
  }));
  wrapQueryInterfaceWriteMethod(qi, db, 'increment', (args) => ({
    modelCandidate: args[0],
    tableNameArg: args[1] as TableTarget,
  }));
  wrapQueryInterfaceWriteMethod(qi, db, 'decrement', (args) => ({
    modelCandidate: args[0],
    tableNameArg: args[1] as TableTarget,
  }));
}

function translateReadOnlyError(ctx: Context): string {
  const ctxWithT = ctx as Context & {
    t?: (key: string, options?: Record<string, unknown>) => string;
    i18n?: { t?: (key: string, options?: Record<string, unknown>) => string };
  };
  if (typeof ctxWithT.t === 'function') {
    return ctxWithT.t('This collection is read-only', { ns: 'plugin-data-source-mssql' });
  }
  if (typeof ctxWithT.i18n?.t === 'function') {
    return ctxWithT.i18n.t('This collection is read-only', { ns: 'plugin-data-source-mssql' });
  }
  return 'This collection is read-only';
}

export interface CollectionLookupLike {
  getCollection(name: string): ViewCollectionLike | undefined;
}

export function createReadOnlyViewMiddleware(getCollectionManager: () => CollectionLookupLike | undefined) {
  return async (ctx: Context, next: Next) => {
    const actionName = ctx.action?.actionName;
    const resourceName = ctx.action?.resourceName;
    const collectionManager = getCollectionManager();

    if (collectionManager && typeof actionName === 'string' && WRITE_ACTION_NAMES.has(actionName) && resourceName) {
      const [sourceName, associationName] = typeof resourceName === 'string' ? resourceName.split('.') : [];
      const sourceCollection = sourceName ? collectionManager.getCollection(sourceName) : undefined;

      if (!associationName) {
        if (isReadOnlyViewCollection(sourceCollection)) {
          ctx.throw(403, translateReadOnlyError(ctx));
        }
      } else {
        const assocField = sourceCollection?.getField?.(associationName);
        const assocType = assocField?.options?.type;
        const targetName = assocField?.options?.target;
        const targetCollection =
          collectionManager.getCollection(resourceName) ??
          (typeof targetName === 'string' ? collectionManager.getCollection(targetName) : undefined);
        const throughName = assocField?.options?.through;
        const throughCollection =
          typeof throughName === 'string' ? collectionManager.getCollection(throughName) : undefined;

        if (RELATION_LINK_ACTIONS.has(actionName)) {
          if (assocType === 'belongsTo' || assocType === 'belongsToArray') {
            if (isReadOnlyViewCollection(sourceCollection)) {
              ctx.throw(403, translateReadOnlyError(ctx));
            }
          } else if (assocType === 'belongsToMany') {
            if (isReadOnlyViewCollection(throughCollection)) {
              ctx.throw(403, translateReadOnlyError(ctx));
            }
          } else if (isReadOnlyViewCollection(targetCollection)) {
            ctx.throw(403, translateReadOnlyError(ctx));
          }
        } else {
          if (
            isReadOnlyViewCollection(targetCollection) ||
            (assocType === 'belongsToMany' &&
              (actionName === 'create' || actionName === 'destroy' || actionName === 'destroyMany') &&
              isReadOnlyViewCollection(throughCollection)) ||
            ((assocType === 'belongsTo' || assocType === 'belongsToArray') &&
              actionName === 'create' &&
              isReadOnlyViewCollection(sourceCollection))
          ) {
            ctx.throw(403, translateReadOnlyError(ctx));
          }
        }
      }
    }

    try {
      await next();
    } catch (error) {
      if (error instanceof MssqlReadOnlyViewError) {
        ctx.throw(403, translateReadOnlyError(ctx));
      }
      throw error;
    }
  };
}
