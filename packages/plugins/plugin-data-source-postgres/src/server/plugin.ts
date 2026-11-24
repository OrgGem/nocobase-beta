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
import { isValidFilter } from '@nocobase/utils';
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
import { applyPostgresArrayDataType } from './postgres-collection-manager';
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

const UNRESOLVED_TEMPLATE_RE = /\{\{[\s\S]*\}\}/;
const NEGATED_ARRAY_OPERATORS = new Set([
  '$ne',
  '$notIn',
  '$notIncludes',
  '$notStartsWith',
  '$notEndWith',
  '$empty',
  '$noneOf',
]);
const KNOWN_FILTER_OPERATORS = new Set([
  '$eq',
  '$ne',
  '$in',
  '$notIn',
  '$includes',
  '$notIncludes',
  '$startsWith',
  '$notStartsWith',
  '$endWith',
  '$notEndWith',
  '$empty',
  '$notEmpty',
  '$isFalsy',
  '$isTruly',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$match',
  '$notMatch',
  '$anyOf',
  '$noneOf',
  '$exists',
  '$notExists',
]);
const LOGICAL_OPERATORS = new Set(['$and', '$or', '$not']);

function containsUnresolvedTemplate(value: unknown): boolean {
  if (typeof value === 'string') return UNRESOLVED_TEMPLATE_RE.test(value);
  if (Array.isArray(value)) return value.some((item) => containsUnresolvedTemplate(item));
  if (isRecord(value)) return Object.values(value).some((item) => containsUnresolvedTemplate(item));
  return false;
}

function compareOrdered(actual: unknown, operand: unknown): number | null {
  if (
    typeof actual === 'number' &&
    typeof operand === 'number' &&
    Number.isFinite(actual) &&
    Number.isFinite(operand)
  ) {
    return actual === operand ? 0 : actual < operand ? -1 : 1;
  }
  if (typeof actual === 'string' && typeof operand === 'string') {
    return actual === operand ? 0 : actual < operand ? -1 : 1;
  }
  if (actual instanceof Date && operand instanceof Date) {
    const left = actual.getTime();
    const right = operand.getTime();
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return null;
}

function isCaseInsensitiveEqualityDialect(dialect: string): boolean {
  return dialect === 'mysql' || dialect === 'mariadb';
}

function valuesEqual(left: unknown, right: unknown, metadataDialect: string): boolean {
  if (isCaseInsensitiveEqualityDialect(metadataDialect) && typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return isEqual(left, right);
}

function coerceLikeActual(actual: unknown, metadataDialect: string): string | null {
  if (typeof actual === 'string') return actual;
  if (
    (metadataDialect === 'postgres' ||
      metadataDialect === 'mysql' ||
      metadataDialect === 'mariadb' ||
      metadataDialect === 'sqlite') &&
    (typeof actual === 'number' || typeof actual === 'boolean')
  ) {
    return String(actual);
  }
  return null;
}

function foldLikeCase(text: string, metadataDialect: string): string {
  // Match core SQL LIKE/ILIKE case semantics per metadata DB dialect (ASCII-only folding for SQLite LIKE).
  return metadataDialect === 'sqlite' ? text.replace(/[A-Z]/g, (ch) => ch.toLowerCase()) : text.toLowerCase();
}

function escapeRegExpChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

function buildCoreLikePattern(
  operand: string,
  metadataDialect: string,
  mode: 'includes' | 'startsWith' | 'endsWith',
): string {
  const escaped = operand.replace(/[_%]/g, '\\$&');
  if (mode === 'startsWith') return `${escaped}%`;
  if (mode === 'endsWith') return `%${escaped}`;
  return `%${escaped}%`;
}

function compileSqlLikePattern(patternFolded: string, metadataDialect: string): RegExp | null {
  // Sequelize emits `LIKE '...'` on SQLite without `ESCAPE '\'`, so `\` is literal while `_` and `%` stay wildcards.
  // PostgreSQL ILIKE and MySQL/MariaDB LIKE use `\` as their default escape character.
  const escapeChar = metadataDialect === 'sqlite' ? null : '\\';
  const chars = Array.from(patternFolded);
  let source = '^';
  let prevWildcardMany = false;

  for (let idx = 0; idx < chars.length; idx += 1) {
    const ch = chars[idx];
    if (escapeChar !== null && ch === escapeChar) {
      if (idx + 1 >= chars.length) {
        if (metadataDialect === 'postgres') return null;
        source += '\\\\';
        prevWildcardMany = false;
        continue;
      }
      idx += 1;
      source += escapeRegExpChar(chars[idx]);
      prevWildcardMany = false;
      continue;
    }
    if (ch === '%') {
      if (!prevWildcardMany) {
        source += '.*';
        prevWildcardMany = true;
      }
      continue;
    }
    prevWildcardMany = false;
    source += ch === '_' ? '.' : escapeRegExpChar(ch);
  }

  source += '$';
  return new RegExp(source, 'su');
}

function matchLikeValue(
  actualFolded: string,
  rawOperand: string,
  metadataDialect: string,
  mode: 'includes' | 'startsWith' | 'endsWith',
): boolean {
  if (metadataDialect === 'mssql') {
    const foldedOperand = foldLikeCase(rawOperand, metadataDialect);
    if (mode === 'startsWith') return actualFolded.startsWith(foldedOperand);
    if (mode === 'endsWith') return actualFolded.endsWith(foldedOperand);
    return actualFolded.includes(foldedOperand);
  }
  const patternFolded = foldLikeCase(buildCoreLikePattern(rawOperand, metadataDialect, mode), metadataDialect);
  const compiled = compileSqlLikePattern(patternFolded, metadataDialect);
  return compiled !== null && compiled.test(actualFolded);
}

function evaluateLikeOperator(
  actual: unknown,
  operand: unknown,
  metadataDialect: string,
  mode: 'includes' | 'startsWith' | 'endsWith',
  negated: boolean,
): boolean {
  if (mode === 'includes' && operand === null) {
    return negated ? actual !== null && actual !== undefined : actual === null || actual === undefined;
  }
  const actualText = coerceLikeActual(actual, metadataDialect);
  if (actualText === null) return false;
  const actualFolded = foldLikeCase(actualText, metadataDialect);
  if (typeof operand === 'string') {
    const matched = matchLikeValue(actualFolded, operand, metadataDialect, mode);
    return negated ? !matched : matched;
  }
  if (Array.isArray(operand) && operand.every((item): item is string => typeof item === 'string')) {
    if (negated) {
      return operand.every((item) => !matchLikeValue(actualFolded, item, metadataDialect, mode));
    }
    return operand.some((item) => matchLikeValue(actualFolded, item, metadataDialect, mode));
  }
  return false;
}

function evaluateSingleOperator(
  actual: unknown,
  operator: string,
  operand: unknown,
  metadataDialect = 'postgres',
): boolean {
  if (!KNOWN_FILTER_OPERATORS.has(operator) || containsUnresolvedTemplate(operand)) return false;
  switch (operator) {
    case '$eq':
      if (operand === undefined) return true;
      if (operand === null) return actual === null || actual === undefined;
      if (Array.isArray(operand) && !Array.isArray(actual)) {
        return (
          actual !== null &&
          actual !== undefined &&
          operand.some((item) => item !== null && item !== undefined && valuesEqual(actual, item, metadataDialect))
        );
      }
      return valuesEqual(actual, operand, metadataDialect);
    case '$ne':
      if (operand === null) return actual !== null && actual !== undefined;
      if (Array.isArray(operand) && !Array.isArray(actual)) {
        if (operand.length === 0) return true;
        if (actual === null || actual === undefined) return false;
        if (operand.some((item) => item === null || item === undefined)) return false;
        return !operand.some((item) => valuesEqual(actual, item, metadataDialect));
      }
      return !Array.isArray(actual) && (actual === null || actual === undefined)
        ? true
        : !valuesEqual(actual, operand, metadataDialect);
    case '$in': {
      if (operand === null || operand === undefined) return false;
      const list = Array.isArray(operand) ? operand : [operand];
      return (
        actual !== null &&
        actual !== undefined &&
        list.some((item) => item !== null && item !== undefined && valuesEqual(actual, item, metadataDialect))
      );
    }
    case '$notIn':
      if (!Array.isArray(operand)) return false;
      if (actual === null || actual === undefined || operand.length === 0) return true;
      if (operand.some((item) => item === null || item === undefined)) return false;
      return !operand.some((item) => valuesEqual(actual, item, metadataDialect));
    case '$exists': {
      if (operand !== undefined && typeof operand !== 'boolean') return false;
      const exists = Array.isArray(actual) ? actual.length > 0 : actual !== null && actual !== undefined;
      return operand === false ? !exists : exists;
    }
    case '$notExists': {
      if (operand !== undefined && typeof operand !== 'boolean') return false;
      const exists = Array.isArray(actual) ? actual.length > 0 : actual !== null && actual !== undefined;
      return operand === false ? exists : !exists;
    }
    case '$includes':
      return evaluateLikeOperator(actual, operand, metadataDialect, 'includes', false);
    case '$notIncludes':
      return evaluateLikeOperator(actual, operand, metadataDialect, 'includes', true);
    case '$startsWith':
      return evaluateLikeOperator(actual, operand, metadataDialect, 'startsWith', false);
    case '$notStartsWith':
      return evaluateLikeOperator(actual, operand, metadataDialect, 'startsWith', true);
    case '$endWith':
      return evaluateLikeOperator(actual, operand, metadataDialect, 'endsWith', false);
    case '$notEndWith':
      return evaluateLikeOperator(actual, operand, metadataDialect, 'endsWith', true);
    case '$empty': {
      if (operand !== undefined && typeof operand !== 'boolean') return false;
      const empty =
        actual === null || actual === undefined || actual === '' || (Array.isArray(actual) && !actual.length);
      return operand === false ? !empty : empty;
    }
    case '$notEmpty': {
      if (operand !== undefined && typeof operand !== 'boolean') return false;
      const empty =
        actual === null || actual === undefined || actual === '' || (Array.isArray(actual) && !actual.length);
      return operand === false ? empty : !empty;
    }
    case '$isFalsy':
      if (operand !== undefined && typeof operand !== 'boolean') return false;
      return operand === false ? Boolean(actual) : !actual;
    case '$isTruly':
      if (operand !== undefined && typeof operand !== 'boolean') return false;
      return operand === false ? !actual : Boolean(actual);
    case '$gt': {
      const cmp = compareOrdered(actual, operand);
      return cmp !== null && cmp > 0;
    }
    case '$gte': {
      const cmp = compareOrdered(actual, operand);
      return cmp !== null && cmp >= 0;
    }
    case '$lt': {
      const cmp = compareOrdered(actual, operand);
      return cmp !== null && cmp < 0;
    }
    case '$lte': {
      const cmp = compareOrdered(actual, operand);
      return cmp !== null && cmp <= 0;
    }
    case '$anyOf':
      return (
        Array.isArray(actual) &&
        Array.isArray(operand) &&
        actual.some((item) => operand.some((target) => valuesEqual(item, target, metadataDialect)))
      );
    case '$noneOf':
      return (
        Array.isArray(actual) &&
        Array.isArray(operand) &&
        !actual.some((item) => operand.some((target) => valuesEqual(item, target, metadataDialect)))
      );
    case '$match':
      return (
        Array.isArray(actual) &&
        isRecord(operand) &&
        actual.some((item) => isRecord(item) && matchesCollectionFilter(item, operand, metadataDialect))
      );
    case '$notMatch':
      return (
        Array.isArray(actual) &&
        isRecord(operand) &&
        !actual.some((item) => isRecord(item) && matchesCollectionFilter(item, operand, metadataDialect))
      );
    default:
      return false;
  }
}

const ARRAY_LEVEL_OPERATORS = new Set([
  '$match',
  '$notMatch',
  '$anyOf',
  '$noneOf',
  '$empty',
  '$notEmpty',
  '$exists',
  '$notExists',
]);
const CONTAINER_ARRAY_KEYS = new Set(['fields', 'indexes']);
const MAX_PINNED_FILTER_CONTEXTS = 10_000;

function evaluateOperatorGroup(
  target: { values: unknown[]; traversedArray: boolean },
  entries: Array<[string, unknown]>,
  metadataDialect: string,
): boolean {
  if (!entries.length) return true;
  if (
    entries.some(([operator, operand]) => !KNOWN_FILTER_OPERATORS.has(operator) || containsUnresolvedTemplate(operand))
  ) {
    return false;
  }
  if (target.traversedArray && entries.every(([operator]) => NEGATED_ARRAY_OPERATORS.has(operator))) {
    return target.values.every((value) =>
      entries.every(([operator, operand]) => evaluateSingleOperator(value, operator, operand, metadataDialect)),
    );
  }
  return target.values.some((value) =>
    entries.every(([operator, operand]) => evaluateSingleOperator(value, operator, operand, metadataDialect)),
  );
}

function collectPositiveArrayPrefixes(filter: unknown, out: string[][], prefix: string[] = []): void {
  if (!isRecord(filter)) return;
  for (const [rawKey, condition] of Object.entries(filter)) {
    if (rawKey === '$and' || rawKey === '$or') {
      const items = Array.isArray(condition) ? condition : isRecord(condition) ? Object.values(condition) : null;
      if (items) {
        for (const item of items) collectPositiveArrayPrefixes(item, out, prefix);
      }
      continue;
    }
    if (rawKey === '$not' || rawKey.startsWith('$')) continue;

    const parts = rawKey.split('.');
    const lastPart = parts[parts.length - 1];
    const hasTrailingOp = parts.length > 1 && lastPart.startsWith('$');
    const fieldParts = hasTrailingOp ? parts.slice(0, -1) : parts;
    if (fieldParts.some((part) => !part || part.startsWith('$'))) continue;

    const fullParts = [...prefix, ...fieldParts];
    let arrayLevelOnly = false;
    if (hasTrailingOp) {
      arrayLevelOnly = ARRAY_LEVEL_OPERATORS.has(lastPart);
    } else if (isRecord(condition)) {
      const keys = Object.keys(condition);
      if (keys.length && keys.every((key) => KNOWN_FILTER_OPERATORS.has(key))) {
        arrayLevelOnly = keys.every((key) => ARRAY_LEVEL_OPERATORS.has(key));
      } else if (keys.length && keys.every((key) => !key.startsWith('$') || LOGICAL_OPERATORS.has(key))) {
        for (let len = 1; len <= fullParts.length; len += 1) {
          out.push(fullParts.slice(0, len));
        }
        collectPositiveArrayPrefixes(condition, out, fullParts);
        continue;
      }
    }

    const maxLen = arrayLevelOnly ? fullParts.length - 1 : fullParts.length;
    for (let len = 1; len <= maxLen; len += 1) {
      out.push(fullParts.slice(0, len));
    }
  }
}

function readPathWithPins(
  record: Record<string, unknown>,
  parts: string[],
  pins: ReadonlyMap<string, unknown>,
  ignoreLeafPin = false,
): { values: unknown[]; traversedArray: boolean } {
  let current: unknown[] = [record];
  let traversedArray = false;
  for (let idx = 0; idx < parts.length; idx += 1) {
    const part = parts[idx];
    const pathSoFar = parts.slice(0, idx + 1).join('.');
    if (!(ignoreLeafPin && idx === parts.length - 1) && pins.has(pathSoFar)) {
      current = [pins.get(pathSoFar)];
      continue;
    }
    const next: unknown[] = [];
    for (const item of current) {
      if (Array.isArray(item)) {
        traversedArray = true;
        for (const entry of item) {
          if (isRecord(entry)) {
            if (part in entry) next.push(entry[part]);
            else if (isRecord(entry.options) && part in entry.options) next.push(entry.options[part]);
          }
        }
      } else if (isRecord(item)) {
        if (part in item) {
          next.push(item[part]);
        } else if (isRecord(item.options) && part in item.options) {
          next.push(item.options[part]);
        } else {
          next.push(undefined);
        }
      }
    }
    current = next;
  }
  return { values: current.length ? current : [undefined], traversedArray };
}

function expandPinsForPrefixes(
  record: Record<string, unknown>,
  inheritedPins: ReadonlyMap<string, unknown>,
  candidatePrefixes: string[][],
): Array<Map<string, unknown>> | null {
  const uniquePrefixes = new Map<string, string[]>();
  for (const parts of candidatePrefixes) {
    const key = parts.join('.');
    if (!inheritedPins.has(key) && !uniquePrefixes.has(key)) {
      uniquePrefixes.set(key, parts);
    }
  }
  const sortedPrefixes = [...uniquePrefixes.entries()].sort((a, b) => a[1].length - b[1].length);
  let contexts: Array<Map<string, unknown>> = [new Map(inheritedPins)];

  for (const [key, parts] of sortedPrefixes) {
    const leafKey = parts[parts.length - 1];
    const nextContexts: Array<Map<string, unknown>> = [];
    for (const ctxPins of contexts) {
      const rawTarget = readPathWithPins(record, parts, ctxPins, true);
      if (rawTarget.values.length === 1 && Array.isArray(rawTarget.values[0])) {
        const arr = rawTarget.values[0];
        if (CONTAINER_ARRAY_KEYS.has(leafKey) || arr.some((entry) => isRecord(entry))) {
          if (arr.length === 0) {
            const forked = new Map(ctxPins);
            forked.set(key, undefined);
            nextContexts.push(forked);
          } else {
            for (const entry of arr) {
              const forked = new Map(ctxPins);
              forked.set(key, entry);
              nextContexts.push(forked);
              if (nextContexts.length > MAX_PINNED_FILTER_CONTEXTS) return null;
            }
          }
          continue;
        }
      }
      nextContexts.push(ctxPins);
      if (nextContexts.length > MAX_PINNED_FILTER_CONTEXTS) return null;
    }
    contexts = nextContexts;
  }
  return contexts;
}

function extractSubPins(pins: ReadonlyMap<string, unknown>, prefix: string): Map<string, unknown> {
  const prefixDot = `${prefix}.`;
  const subPins = new Map<string, unknown>();
  for (const [key, value] of pins.entries()) {
    if (key.startsWith(prefixDot)) {
      subPins.set(key.slice(prefixDot.length), value);
    }
  }
  return subPins;
}

function evaluateEntriesWithPins(
  record: Record<string, unknown>,
  pins: ReadonlyMap<string, unknown>,
  filter: unknown,
  metadataDialect: string,
): boolean {
  if (!isRecord(filter)) return false;
  for (const [rawKey, condition] of Object.entries(filter)) {
    if (rawKey === '$and') {
      const items = Array.isArray(condition) ? condition : isRecord(condition) ? Object.values(condition) : null;
      if (!items || !items.every((item) => evaluateEntriesWithPins(record, pins, item, metadataDialect))) return false;
      continue;
    }
    if (rawKey === '$or') {
      const items = Array.isArray(condition) ? condition : isRecord(condition) ? Object.values(condition) : null;
      if (!items || !items.some((item) => matchesScope(record, pins, item, metadataDialect))) return false;
      continue;
    }
    if (rawKey === '$not') {
      if (!isRecord(condition) || matchesScope(record, pins, condition, metadataDialect)) return false;
      continue;
    }
    if (rawKey.startsWith('$')) return false;

    const parts = rawKey.split('.');
    const lastPart = parts[parts.length - 1];
    const hasTrailingOp = parts.length > 1 && lastPart.startsWith('$');
    const fieldParts = hasTrailingOp ? parts.slice(0, -1) : parts;
    if (fieldParts.some((part) => !part || part.startsWith('$'))) return false;

    if (hasTrailingOp) {
      const target = readPathWithPins(record, fieldParts, pins, ARRAY_LEVEL_OPERATORS.has(lastPart));
      if (!evaluateOperatorGroup(target, [[lastPart, condition]], metadataDialect)) return false;
      continue;
    }

    if (isRecord(condition)) {
      const entries = Object.entries(condition);
      if (!entries.length) continue;
      if (entries.every(([key]) => KNOWN_FILTER_OPERATORS.has(key))) {
        const arrayLevelEntries = entries.filter(([key]) => ARRAY_LEVEL_OPERATORS.has(key));
        const elementEntries = entries.filter(([key]) => !ARRAY_LEVEL_OPERATORS.has(key));
        if (arrayLevelEntries.length) {
          const arrayTarget = readPathWithPins(record, fieldParts, pins, true);
          if (!evaluateOperatorGroup(arrayTarget, arrayLevelEntries, metadataDialect)) return false;
        }
        if (elementEntries.length) {
          const elemTarget = readPathWithPins(record, fieldParts, pins, false);
          if (!evaluateOperatorGroup(elemTarget, elementEntries, metadataDialect)) return false;
        }
        continue;
      }
      if (!entries.every(([key]) => !key.startsWith('$') || LOGICAL_OPERATORS.has(key))) return false;

      const fieldPathKey = fieldParts.join('.');
      const subPins = extractSubPins(pins, fieldPathKey);
      if (pins.has(fieldPathKey)) {
        const pinnedVal = pins.get(fieldPathKey);
        if (!isRecord(pinnedVal) || !matchesScope(pinnedVal, subPins, condition, metadataDialect)) return false;
        continue;
      }
      const target = readPathWithPins(record, fieldParts, pins, false);
      const nestedMatched = target.values.some((value) => {
        if (Array.isArray(value)) {
          return value.some((entry) => isRecord(entry) && matchesScope(entry, subPins, condition, metadataDialect));
        }
        return isRecord(value) && matchesScope(value, subPins, condition, metadataDialect);
      });
      if (!nestedMatched) return false;
      continue;
    }

    const target = readPathWithPins(record, fieldParts, pins, false);
    if (!evaluateOperatorGroup(target, [['$eq', condition]], metadataDialect)) return false;
  }
  return true;
}

function matchesScope(
  record: Record<string, unknown>,
  inheritedPins: ReadonlyMap<string, unknown>,
  filter: unknown,
  metadataDialect: string,
): boolean {
  if (!isRecord(filter)) return false;
  const prefixes: string[][] = [];
  collectPositiveArrayPrefixes(filter, prefixes);
  const expanded = expandPinsForPrefixes(record, inheritedPins, prefixes);
  if (!expanded) return false;
  return expanded.some((pins) => evaluateEntriesWithPins(record, pins, filter, metadataDialect));
}

function matchesCollectionFilter(
  record: Record<string, unknown>,
  filter: unknown,
  metadataDialect = 'postgres',
): boolean {
  return matchesScope(record, new Map(), filter, metadataDialect);
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
    if (typeof field !== 'string') {
      if (isRecord(field.settings)) {
        if (field.elementType === undefined && typeof field.settings.elementType === 'string') {
          field.elementType = field.settings.elementType;
        }
        if (field.dataType === undefined && typeof field.settings.dataType === 'string') {
          field.dataType = field.settings.dataType;
        }
      }
      return applyPostgresArrayDataType(field);
    }
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
          const dataSourceKey = ctx.action?.sourceId || params?.associatedIndex;
          const dataSource = dataSourceKey ? this.app.dataSourceManager.get(dataSourceKey) : undefined;
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

  private async resolveCollectionsToDestroy(ctx: Context, source: PostgresDataSource): Promise<string[]> {
    const params = ctx.action?.params || {};
    const permission = (
      ctx as {
        permission?: {
          parsedParams?: { filter?: unknown };
          can?: { params?: { filter?: unknown } };
        };
      }
    ).permission;
    const rawFilter = params.filter;
    const scopeFilter = permission?.parsedParams?.filter ?? permission?.can?.params?.filter;
    const hasRawFilter = isValidFilter(rawFilter);
    const hasScopeFilter = isValidFilter(scopeFilter);
    const effectiveFilter =
      hasRawFilter && hasScopeFilter && !isEqual(rawFilter, scopeFilter)
        ? { $and: [rawFilter, scopeFilter] }
        : hasRawFilter
          ? rawFilter
          : hasScopeFilter
            ? scopeFilter
            : undefined;

    const hasFilterByTk = params.filterByTk !== undefined && params.filterByTk !== null;
    let requestedNames: string[] | undefined;
    if (hasFilterByTk) {
      if (Array.isArray(params.filterByTk) && params.filterByTk.length === 0) {
        return [];
      }
      requestedNames = names(params.filterByTk);
    } else if (!effectiveFilter) {
      throw new PostgresValidationError('A collection name is required');
    }

    const manager = source.collectionManager;
    if (!effectiveFilter) {
      for (const name of requestedNames ?? []) {
        if (!manager.getCollection(name)) {
          ctx.throw(404, translate(ctx, 'Collection {{name}} does not exist', { name }));
        }
      }
      return requestedNames ?? [];
    }

    const db = this.app.db || ctx.db;
    const metadataDialect = db?.sequelize?.getDialect?.() ?? 'postgres';
    const collectionsRepo = db?.getRepository?.('dataSourcesCollections') as
      | { find?: (options: Record<string, unknown>) => Promise<Model[]> }
      | undefined;

    if (collectionsRepo && typeof collectionsRepo.find === 'function') {
      const baseFilter: Record<string, unknown> = {
        dataSourceKey: source.name,
        ...(requestedNames ? { name: { $in: requestedNames } } : {}),
      };
      const persistedAll = await collectionsRepo.find({ filter: baseFilter, context: ctx });
      const persistedNames = new Set(persistedAll.map((row) => String(row.get('name'))));
      const persistedMatched = await collectionsRepo.find({
        filter: { $and: [baseFilter, effectiveFilter] },
        context: ctx,
      });
      const matchedSet = new Set(persistedMatched.map((row) => String(row.get('name'))));

      for (const collection of manager.getCollections()) {
        if (persistedNames.has(collection.name)) continue;
        if (requestedNames && !requestedNames.includes(collection.name)) continue;
        const record: Record<string, unknown> = {
          ...collection.options,
          name: collection.name,
          dataSourceKey: source.name,
          dataSources: { key: source.name, type: DATA_SOURCE_TYPE },
          options: collection.options,
          fields: collection.getFields().map((field) => field.options),
        };
        if (matchesCollectionFilter(record, effectiveFilter, metadataDialect)) {
          matchedSet.add(collection.name);
        }
      }

      return requestedNames ? requestedNames.filter((name) => matchedSet.has(name)) : [...matchedSet];
    }

    const matchedRuntime = new Set<string>();
    for (const collection of manager.getCollections()) {
      if (requestedNames && !requestedNames.includes(collection.name)) continue;
      const record: Record<string, unknown> = {
        ...collection.options,
        name: collection.name,
        dataSourceKey: source.name,
        dataSources: { key: source.name, type: DATA_SOURCE_TYPE },
        options: collection.options,
        fields: collection.getFields().map((field) => field.options),
      };
      if (matchesCollectionFilter(record, effectiveFilter, metadataDialect)) {
        matchedRuntime.add(collection.name);
      }
    }
    return requestedNames ? requestedNames.filter((name) => matchedRuntime.has(name)) : [...matchedRuntime];
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

    const collectionNames = await this.resolveCollectionsToDestroy(ctx, source);
    if (collectionNames.length === 0) {
      ctx.body = true;
      return;
    }

    const snapshots = collectionNames.flatMap((name) => {
      const collection = manager.getCollection(name);
      if (!collection) return [];
      return [
        {
          name,
          physicalName: String(collection.options.tableName || name),
          isSql: Boolean(collection.options.sql),
          options: cloneDeep({
            ...collection.options,
            tableName: String(collection.options.tableName || name),
            fields: collection.getFields().map((field) => field.options),
          }),
        },
      ];
    });
    const cascade = params.cascade === true || params.cascade === 'true';
    const hadFilterByTk = Object.prototype.hasOwnProperty.call(params, 'filterByTk');
    const hadFilter = Object.prototype.hasOwnProperty.call(params, 'filter');
    const originalFilterByTk = params.filterByTk;
    const originalFilter = params.filter;
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
        params.filterByTk = collectionNames;
        delete params.filter;
        await next();
      });
    } catch (error) {
      if (hadFilterByTk) params.filterByTk = originalFilterByTk;
      else delete params.filterByTk;
      if (hadFilter) params.filter = originalFilter;
      else delete params.filter;
      for (const snapshot of snapshots) {
        if (!manager.hasCollection(snapshot.name)) manager.defineCollection(snapshot.options);
      }
      throw error;
    }
    const fieldsRepo = (this.app.db || ctx.db)?.getRepository?.('dataSourcesFields') as
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
      collectionNames,
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
        if (input.dataType === 'array' && isRecord(params.values)) {
          if (
            params.values.dataType === undefined ||
            params.values.dataType === null ||
            params.values.dataType === ''
          ) {
            params.values.dataType = 'array';
          }
          if (params.values.elementType === undefined && typeof input.elementType === 'string') {
            params.values.elementType = input.elementType;
          }
        }
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
