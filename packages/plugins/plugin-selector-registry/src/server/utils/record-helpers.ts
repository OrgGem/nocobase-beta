/**
 * Shared record-access helpers for NocoBase models and plain objects.
 *
 * NocoBase repository results may be model instances with a `.get()` accessor
 * or plain objects. These helpers normalize both shapes so services do not
 * need to branch on the record type.
 */

export type AnyRecord = { get?: (name: string) => unknown } & Record<string, unknown>;

export const read = (record: AnyRecord | null | undefined, key: string): unknown => {
  if (!record) return undefined;
  return typeof record.get === 'function' ? record.get(key) : record[key];
};

export const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const toIso = (date: Date): string => date.toISOString();
