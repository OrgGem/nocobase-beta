import { createHash } from 'node:crypto';

export function normalizeSort(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : ['id'];
  const result = values.filter(
    (item): item is string => typeof item === 'string' && /^[+-]?[A-Za-z][A-Za-z0-9_.]*$/.test(item),
  );
  if (!result.length) throw new Error('At least one valid sort field is required');
  return result.includes('id') || result.includes('-id') ? result : [...result, 'id'];
}

export function hashFilter(filter: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(filter ?? {}))
    .digest('hex');
}
