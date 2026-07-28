import { isRecord } from '../contracts/types';

export type RegistryModel = {
  get(attribute: string): unknown;
};

export function getString(model: RegistryModel, attribute: string, fallback = ''): string {
  const value = model.get(attribute);
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}

export function getBoolean(model: RegistryModel, attribute: string, fallback = false): boolean {
  const value = model.get(attribute);
  return typeof value === 'boolean' ? value : fallback;
}

export function getJson(model: RegistryModel, attribute: string): Record<string, unknown> {
  const value = model.get(attribute);
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
