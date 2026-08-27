import type { Model } from '@nocobase/database';

/**
 * Read a value from a NocoBase model or plain record.
 *
 * NocoBase models use a getter (record.get('fieldName')) to access attributes.
 * Plain records use direct property access. This helper transparently handles both.
 */
export function read(record: Model | Record<string, unknown> | unknown, key: string): unknown {
  const model = record as { get?: (name: string) => unknown } | null;
  return typeof model?.get === 'function' ? model.get(key) : (model as Record<string, unknown> | null)?.[key];
}

/**
 * Coerce a value to a plain object. Returns {} for non-object inputs.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
