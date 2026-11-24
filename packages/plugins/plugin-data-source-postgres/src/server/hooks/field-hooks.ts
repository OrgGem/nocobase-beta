/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Collection } from '@nocobase/database';
import { Transaction, Utils } from 'sequelize';
import { isEqual } from 'lodash';
import {
  applyPostgresArrayDataType,
  isPostgresPhysicalArrayRawType,
  PostgresCollectionManager,
} from '../postgres-collection-manager';
import { PostgresValidationError } from '../utils/validation-error';

type FieldValues = {
  name?: string;
  type?: string;
  dataType?: string;
  field?: string;
  interface?: string;
  allowNull?: boolean;
  defaultValue?: unknown;
  unique?: boolean;
  autoIncrement?: boolean;
  primaryKey?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  elementType?: string;
  settings?: FieldValues;
  [key: string]: unknown;
};

const RELATION_TYPES = new Set(['belongsTo', 'belongsToMany', 'belongsToArray', 'hasOne', 'hasMany']);
const RELATION_INTERFACES: Record<string, string> = {
  m2o: 'belongsTo',
  obo: 'belongsTo',
  o2m: 'hasMany',
  oho: 'hasOne',
  m2m: 'belongsToMany',
  m2m_array: 'belongsToArray',
};

export function removesPhysicalColumn(collection: Collection, name: string): boolean {
  const field = collection.getField(name);
  if (!field || field.isRelationField()) return false;
  const columnName = field.columnName();
  return !collection
    .getFields()
    .some((other) => other.name !== name && !other.isRelationField() && other.columnName() === columnName);
}

const ARRAY_ELEMENT_TYPE_MAP: Record<string, string> = {
  nanoid: 'string',
  sequence: 'string',
  uid: 'string',
  snowflakeId: 'bigInt',
};

export function fieldReferencesColumn(
  values: FieldValues,
  sourceCollection: string,
  targetCollection: string,
  columns: string | string[],
): boolean {
  const candidates = new Set(Array.isArray(columns) ? columns : [columns]);
  const type = values.type;
  if (values.target === targetCollection) {
    if (
      (type === 'belongsTo' || type === 'belongsToMany' || type === 'belongsToArray') &&
      candidates.has(String(values.targetKey || 'id'))
    ) {
      return true;
    }
    if ((type === 'hasOne' || type === 'hasMany') && values.foreignKey && candidates.has(String(values.foreignKey))) {
      return true;
    }
  }
  if (sourceCollection === targetCollection) {
    if (
      (type === 'belongsTo' || type === 'belongsToArray') &&
      values.foreignKey &&
      candidates.has(String(values.foreignKey))
    ) {
      return true;
    }
    if (
      (type === 'hasOne' || type === 'hasMany' || type === 'belongsToMany') &&
      candidates.has(String(values.sourceKey || 'id'))
    ) {
      return true;
    }
  }
  return (
    values.through === targetCollection &&
    ((Boolean(values.foreignKey) && candidates.has(String(values.foreignKey))) ||
      (Boolean(values.otherKey) && candidates.has(String(values.otherKey))))
  );
}

export function buildArrayForeignKeyField(
  manager: PostgresCollectionManager,
  collectionName: string,
  relationOptions: FieldValues,
): FieldValues | undefined {
  if (relationOptions.type !== 'belongsToArray') return undefined;
  const foreignKey = typeof relationOptions.foreignKey === 'string' ? relationOptions.foreignKey : undefined;
  const target = typeof relationOptions.target === 'string' ? relationOptions.target : undefined;
  const targetKey = typeof relationOptions.targetKey === 'string' ? relationOptions.targetKey : 'id';
  if (!foreignKey || !target || foreignKey === relationOptions.name) return undefined;
  const sourceCollection = manager.getCollection(collectionName);
  if (!sourceCollection || sourceCollection.getField(foreignKey)) return undefined;
  const targetFieldType = String(manager.getCollection(target)?.getField(targetKey)?.options?.type || 'bigInt');
  const elementType = ARRAY_ELEMENT_TYPE_MAP[targetFieldType] || targetFieldType;
  return {
    name: foreignKey,
    field: foreignKey,
    type: 'set',
    dataType: 'array',
    elementType,
    interface: 'json',
    isForeignKey: true,
    uiSchema: {
      type: 'object',
      title: foreignKey,
      'x-component': 'Input.JSON',
      'x-read-pretty': true,
    },
  };
}

function normalizeValues(input: FieldValues): FieldValues {
  const values = { ...(input.settings || {}), ...input };
  delete values.settings;
  if (!values.type && values.interface && RELATION_INTERFACES[values.interface]) {
    values.type = RELATION_INTERFACES[values.interface];
  }
  return values;
}

function defaultThroughTable(collectionName: string, target: string): string {
  return Utils.camelize(
    [collectionName, target]
      .map((item) => item.toLowerCase())
      .sort()
      .join('_'),
  );
}

export function getRelationLockTables(
  manager: PostgresCollectionManager,
  collectionName: string,
  input: FieldValues,
  fieldName?: string,
): string[] {
  const schema = manager.db?.options?.schema || 'public';
  const tables = new Set<string>();
  const addTable = (name: string) => {
    const col = manager.getCollection(name);
    const tableName = col?.options?.tableName || name;
    tables.add(`${schema}.${tableName}`);
  };
  addTable(collectionName);
  const values = normalizeValues(input);
  const resolvedName = fieldName || (typeof values.name === 'string' ? values.name : undefined);
  const existing = resolvedName
    ? (manager.getCollection(collectionName)?.getField(resolvedName)?.options as FieldValues | undefined)
    : undefined;
  const addRelationTables = (candidate?: FieldValues) => {
    if (!candidate) return;
    const type = candidate.type;
    if (typeof candidate.target === 'string' && candidate.target && type && RELATION_TYPES.has(type)) {
      addTable(candidate.target);
      if (type === 'belongsToMany') {
        const through =
          typeof candidate.through === 'string' && candidate.through
            ? candidate.through
            : defaultThroughTable(collectionName, candidate.target);
        addTable(through);
      }
    }
  };
  addRelationTables(existing);
  addRelationTables(existing ? { ...existing, ...values } : values);
  return [...tables].sort();
}

async function ensureBelongsTo(
  manager: PostgresCollectionManager,
  collectionName: string,
  name: string,
  values: FieldValues,
  input: FieldValues,
  transaction: Transaction,
  replaceActions = false,
) {
  const target = typeof values.target === 'string' ? values.target : undefined;
  if (!target) throw new PostgresValidationError('Relation field {{name}} requires a target', { name });
  const targetCollection = manager.getCollection(target);
  if (targetCollection?.options?.view || targetCollection?.options?.sql) {
    throw new PostgresValidationError('This collection is read-only');
  }
  const targetKey =
    typeof values.targetKey === 'string' && values.targetKey
      ? values.targetKey
      : targetCollection?.model?.primaryKeyAttribute || 'id';
  const foreignKey =
    typeof values.foreignKey === 'string' && values.foreignKey
      ? values.foreignKey
      : Utils.camelize([Utils.singularize(name), targetKey].join('_'));
  await manager.ensureForeignKey(
    collectionName,
    {
      foreignKey,
      targetKey,
      target,
      onDelete: typeof values.onDelete === 'string' && values.onDelete ? values.onDelete : undefined,
      onUpdate: typeof values.onUpdate === 'string' && values.onUpdate ? values.onUpdate : undefined,
      replaceActions,
    },
    transaction,
  );
  if (!input.type) input.type = 'belongsTo';
  if (!input.target) input.target = target;
  if (!input.targetKey) input.targetKey = targetKey;
  if (!input.foreignKey) input.foreignKey = foreignKey;
}

async function ensureHasRelation(
  manager: PostgresCollectionManager,
  collectionName: string,
  name: string,
  type: 'hasMany' | 'hasOne',
  values: FieldValues,
  input: FieldValues,
  transaction: Transaction,
  replaceActions = false,
) {
  const target = typeof values.target === 'string' ? values.target : undefined;
  if (!target) throw new PostgresValidationError('Relation field {{name}} requires a target', { name });
  const sourceCollection = manager.getCollection(collectionName);
  const targetCollection = manager.getCollection(target);
  if (!targetCollection) {
    throw new PostgresValidationError('Collection {{name}} does not exist', { name: target });
  }
  const sourceKey =
    typeof values.sourceKey === 'string' && values.sourceKey
      ? values.sourceKey
      : sourceCollection?.model?.primaryKeyAttribute || 'id';
  const foreignKey =
    typeof values.foreignKey === 'string' && values.foreignKey
      ? values.foreignKey
      : Utils.camelize([Utils.singularize(collectionName), sourceKey].join('_'));
  if (targetCollection.options?.view || targetCollection.options?.sql) {
    if (!targetCollection.getField(foreignKey)) {
      throw new PostgresValidationError('This collection is read-only');
    }
  } else {
    await manager.ensureForeignKey(
      target,
      {
        foreignKey,
        targetKey: sourceKey,
        target: collectionName,
        onDelete: typeof values.onDelete === 'string' && values.onDelete ? values.onDelete : undefined,
        onUpdate: typeof values.onUpdate === 'string' && values.onUpdate ? values.onUpdate : undefined,
        replaceActions,
      },
      transaction,
    );
  }
  if (!input.type) input.type = type;
  if (!input.target) input.target = target;
  if (!input.sourceKey) input.sourceKey = sourceKey;
  if (!input.foreignKey) input.foreignKey = foreignKey;
}

async function ensureBelongsToMany(
  manager: PostgresCollectionManager,
  collectionName: string,
  name: string,
  values: FieldValues,
  input: FieldValues,
  transaction: Transaction,
  replaceActions = false,
) {
  const target = typeof values.target === 'string' ? values.target : undefined;
  if (!target) throw new PostgresValidationError('Relation field {{name}} requires a target', { name });
  const sourceCollection = manager.getCollection(collectionName);
  const targetCollection = manager.getCollection(target);
  if (!targetCollection) {
    throw new PostgresValidationError('Collection {{name}} does not exist', { name: target });
  }
  if (targetCollection.options?.view || targetCollection.options?.sql) {
    throw new PostgresValidationError('This collection is read-only');
  }
  const sourceKey =
    typeof values.sourceKey === 'string' && values.sourceKey
      ? values.sourceKey
      : sourceCollection?.model?.primaryKeyAttribute || 'id';
  const targetKey =
    typeof values.targetKey === 'string' && values.targetKey
      ? values.targetKey
      : targetCollection.model?.primaryKeyAttribute || 'id';
  const foreignKey =
    typeof values.foreignKey === 'string' && values.foreignKey
      ? values.foreignKey
      : Utils.camelize([Utils.singularize(collectionName), sourceKey].join('_'));
  const otherKey =
    typeof values.otherKey === 'string' && values.otherKey
      ? values.otherKey
      : Utils.camelize([Utils.singularize(target), targetKey].join('_'));
  const through =
    typeof values.through === 'string' && values.through ? values.through : defaultThroughTable(collectionName, target);
  await manager.ensureJoinTable(
    collectionName,
    {
      through,
      foreignKey,
      otherKey,
      sourceKey,
      targetKey,
      target,
      onDelete: typeof values.onDelete === 'string' && values.onDelete ? values.onDelete : undefined,
      onUpdate: typeof values.onUpdate === 'string' && values.onUpdate ? values.onUpdate : undefined,
      replaceActions,
    },
    transaction,
  );
  if (!input.type) input.type = 'belongsToMany';
  if (!input.target) input.target = target;
  if (!input.sourceKey) input.sourceKey = sourceKey;
  if (!input.targetKey) input.targetKey = targetKey;
  if (!input.foreignKey) input.foreignKey = foreignKey;
  if (!input.otherKey) input.otherKey = otherKey;
  if (!input.through) input.through = through;
}

async function ensureBelongsToArray(
  manager: PostgresCollectionManager,
  collectionName: string,
  name: string,
  values: FieldValues,
  input: FieldValues,
  transaction: Transaction,
) {
  const target = typeof values.target === 'string' ? values.target : undefined;
  if (!target) throw new PostgresValidationError('Relation field {{name}} requires a target', { name });
  const targetCollection = manager.getCollection(target);
  if (!targetCollection) {
    throw new PostgresValidationError('Collection {{name}} does not exist', { name: target });
  }
  if (targetCollection.options?.sql) {
    throw new PostgresValidationError('This collection is read-only');
  }
  const targetKey =
    typeof values.targetKey === 'string' && values.targetKey
      ? values.targetKey
      : targetCollection.model?.primaryKeyAttribute || 'id';
  const foreignKey =
    typeof values.foreignKey === 'string' && values.foreignKey
      ? values.foreignKey
      : Utils.camelize([Utils.singularize(name), targetKey].join('_'));
  if (name === foreignKey) {
    throw new PostgresValidationError(
      'Foreign key {{foreignKey}} cannot have the same name as relation field {{name}}',
      {
        foreignKey,
        name,
      },
    );
  }
  await manager.ensureForeignKeyArray(collectionName, { foreignKey, targetKey, target }, transaction);
  if (!input.type) input.type = 'belongsToArray';
  if (!input.target) input.target = target;
  if (!input.targetKey) input.targetKey = targetKey;
  if (!input.foreignKey) input.foreignKey = foreignKey;
}

export async function syncFieldAction(
  manager: PostgresCollectionManager,
  action: string,
  collectionName: string,
  fieldName: string | undefined,
  input: FieldValues,
  transaction: Transaction,
): Promise<void> {
  const collection = manager.getCollection(collectionName);
  if (!collection) {
    throw new PostgresValidationError('Collection {{name}} does not exist', { name: collectionName });
  }

  const values = normalizeValues(input);
  const name = fieldName || values.name;
  if (!name) {
    throw new PostgresValidationError('Field name is required');
  }
  const field = collection.getField(name);

  if (action === 'destroy') {
    if (!field) {
      throw new PostgresValidationError('Field {{name}} does not exist', { name });
    }
    if (!removesPhysicalColumn(collection, name)) {
      return;
    }
    const columnNames = [name, field.columnName()];
    for (const candidate of manager.getCollections()) {
      for (const reference of candidate.getFields()) {
        if (fieldReferencesColumn(reference.options, candidate.name, collectionName, columnNames)) {
          throw new PostgresValidationError('Field {{name}} is referenced by {{collection}}.{{field}}', {
            name,
            collection: candidate.name,
            field: reference.name,
          });
        }
      }
    }
    await manager.removeField(collectionName, name, false, transaction);
    return;
  }

  if (!field) {
    if (values.type === 'belongsTo') {
      await ensureBelongsTo(manager, collectionName, name, values, input, transaction);
      return;
    }
    if (values.type === 'hasMany' || values.type === 'hasOne') {
      await ensureHasRelation(manager, collectionName, name, values.type, values, input, transaction);
      return;
    }
    if (values.type === 'belongsToMany') {
      await ensureBelongsToMany(manager, collectionName, name, values, input, transaction);
      return;
    }
    if (values.type === 'belongsToArray') {
      await ensureBelongsToArray(manager, collectionName, name, values, input, transaction);
      return;
    }
    applyPostgresArrayDataType(values);
    if (values.dataType === 'array') {
      input.dataType = 'array';
      if (input.elementType === undefined && typeof values.elementType === 'string') {
        input.elementType = values.elementType;
      }
    }
    await manager.addField(collectionName, { ...values, name }, transaction);
    return;
  }
  if (action === 'create') {
    throw new PostgresValidationError('Field {{name}} already exists', { name });
  }
  if (
    ['autoIncrement', 'primaryKey'].some(
      (key) =>
        Object.prototype.hasOwnProperty.call(values, key) && Boolean(values[key]) !== Boolean(field.options[key]),
    )
  ) {
    throw new PostgresValidationError('Field {{name}} cannot change generated-id or primary-key settings', { name });
  }
  if (values.type && RELATION_TYPES.has(field.options.type) !== RELATION_TYPES.has(values.type)) {
    throw new PostgresValidationError('Field {{name}} cannot be changed between a relation and a physical column', {
      name,
    });
  }
  if (RELATION_TYPES.has(field.options.type)) {
    const merged = { ...field.options, ...values };
    if (
      field.options.type === 'belongsTo' &&
      ['target', 'foreignKey', 'targetKey', 'onDelete', 'onUpdate'].some(
        (key) => Object.prototype.hasOwnProperty.call(values, key) && !isEqual(values[key], field.options[key]),
      )
    ) {
      await ensureBelongsTo(manager, collectionName, name, merged, input, transaction, true);
    } else if (
      (field.options.type === 'hasMany' || field.options.type === 'hasOne') &&
      ['target', 'foreignKey', 'sourceKey', 'onDelete', 'onUpdate'].some(
        (key) => Object.prototype.hasOwnProperty.call(values, key) && !isEqual(values[key], field.options[key]),
      )
    ) {
      await ensureHasRelation(manager, collectionName, name, field.options.type, merged, input, transaction, true);
    } else if (
      field.options.type === 'belongsToMany' &&
      ['target', 'through', 'foreignKey', 'otherKey', 'sourceKey', 'targetKey', 'onDelete', 'onUpdate'].some(
        (key) => Object.prototype.hasOwnProperty.call(values, key) && !isEqual(values[key], field.options[key]),
      )
    ) {
      await ensureBelongsToMany(manager, collectionName, name, merged, input, transaction, true);
    } else if (
      field.options.type === 'belongsToArray' &&
      ['target', 'foreignKey', 'targetKey'].some(
        (key) => Object.prototype.hasOwnProperty.call(values, key) && !isEqual(values[key], field.options[key]),
      )
    ) {
      await ensureBelongsToArray(manager, collectionName, name, merged, input, transaction);
    }
    return;
  }

  const effectiveType = values.type ?? field.options.type;
  const effectiveElementType = values.elementType ?? field.options.elementType;
  const effectiveDataType = values.dataType !== undefined ? values.dataType : field.options.dataType;
  if (
    (effectiveType === 'array' || effectiveType === 'set') &&
    typeof effectiveElementType === 'string' &&
    effectiveElementType.trim().length > 0 &&
    (effectiveDataType === undefined || effectiveDataType === null || effectiveDataType === '')
  ) {
    const rawTypeIsArray =
      field.options.rawType === undefined ? undefined : isPostgresPhysicalArrayRawType(field.options.rawType);
    const columnIsArray =
      rawTypeIsArray !== undefined
        ? rawTypeIsArray
        : await manager.isPhysicalArrayColumn(collectionName, field.columnName(), transaction);
    if (columnIsArray !== false) {
      values.dataType = 'array';
      input.dataType = 'array';
    }
  }

  const changes: Pick<
    FieldValues,
    'type' | 'dataType' | 'allowNull' | 'defaultValue' | 'unique' | 'length' | 'precision' | 'scale' | 'elementType'
  > = {};
  for (const key of [
    'type',
    'dataType',
    'allowNull',
    'defaultValue',
    'unique',
    'length',
    'precision',
    'scale',
    'elementType',
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(values, key) && !isEqual(values[key], field.options[key])) {
      Object.assign(changes, { [key]: values[key] });
    }
  }
  if (Object.keys(changes).length) {
    await manager.updateField(collectionName, name, changes, transaction);
  }
}
