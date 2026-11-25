// SPDX-License-Identifier: Apache-2.0

import { SequelizeCollectionManager } from '@nocobase/data-source-manager';
import type { CollectionOptions, FieldOptions, MergeOptions } from '@nocobase/data-source-manager';
import { MssqlRepository } from './MssqlRepository';

const patchedCollections = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeFieldOptions(existing: FieldOptions | undefined, incoming: FieldOptions): FieldOptions {
  if (!existing) {
    return { ...incoming };
  }
  const merged: FieldOptions = {
    ...existing,
    ...incoming,
  };
  if (isRecord(existing.uiSchema) || isRecord(incoming.uiSchema)) {
    merged.uiSchema = {
      ...(isRecord(existing.uiSchema) ? existing.uiSchema : {}),
      ...(isRecord(incoming.uiSchema) ? incoming.uiSchema : {}),
    };
  }
  return merged;
}

export class MssqlCollectionManager extends SequelizeCollectionManager {
  constructor(options: Record<string, unknown>) {
    super(options);

    // Register MSSQL-specific repository with cursor-based pagination support
    this.db.registerRepositories({
      'mssql-repo': MssqlRepository,
    });
  }

  defineCollection(options: CollectionOptions) {
    const collection = super.defineCollection(options);
    if (collection && typeof collection === 'object' && !patchedCollections.has(collection)) {
      const originalUpdateOptions = collection.updateOptions.bind(collection);
      collection.updateOptions = (incomingOptions: CollectionOptions, mergeOpts?: MergeOptions) => {
        const previousOptions = collection.options || {};
        const previousFields = new Map<string, FieldOptions>();
        for (const fieldInstance of collection.getFields()) {
          if (fieldInstance?.options?.name) {
            previousFields.set(fieldInstance.options.name, fieldInstance.options);
          }
        }

        const mergedFieldsMap = new Map<string, FieldOptions>(previousFields);
        if (Array.isArray(incomingOptions?.fields)) {
          for (const rawField of incomingOptions.fields) {
            if (!isRecord(rawField) || typeof rawField.name !== 'string' || !rawField.name) {
              continue;
            }
            const incomingField = rawField as FieldOptions;
            const byName = previousFields.get(incomingField.name);
            const byColumn =
              !byName && typeof incomingField.field === 'string'
                ? collection.getFieldByField?.(incomingField.field)?.options
                : undefined;
            const combined = mergeFieldOptions(byName ?? byColumn, incomingField);
            if (typeof combined.type === 'string' && combined.type.length > 0) {
              mergedFieldsMap.set(incomingField.name, combined);
            }
          }
        }

        const nextOptions: CollectionOptions = {
          ...incomingOptions,
          introspected: incomingOptions.introspected ?? previousOptions.introspected ?? true,
          repository: incomingOptions.repository ?? previousOptions.repository ?? 'mssql-repo',
          ...(previousOptions.tableName !== undefined && incomingOptions.tableName === undefined
            ? { tableName: previousOptions.tableName }
            : {}),
          ...(previousOptions.schema !== undefined && incomingOptions.schema === undefined
            ? { schema: previousOptions.schema }
            : {}),
          ...(previousOptions.view
            ? {
                view: true,
                viewName: incomingOptions.viewName ?? previousOptions.viewName,
                template: incomingOptions.template ?? previousOptions.template ?? 'view',
              }
            : {}),
          fields: [...mergedFieldsMap.values()],
        };

        return originalUpdateOptions(nextOptions, {
          arrayMerge: (_target: unknown[], source: unknown[]) => source,
          ...(mergeOpts || {}),
        });
      };
      patchedCollections.add(collection);
    }
    return collection;
  }

  removeCollection(name: string) {
    this.db.removeCollection(name);
  }
}
