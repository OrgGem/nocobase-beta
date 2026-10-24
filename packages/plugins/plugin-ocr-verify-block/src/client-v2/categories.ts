import { DEFAULT_MAPPING, DEFAULT_SETTINGS } from '../shared/constants';

export const categoryFields = [
  ['name', 'Name (unique ID)', true],
  ['title', 'Title', true],
  ['description', 'Description'],
  ['callbackUrl', 'Callback URL'],
  ['acceptStatus', 'Accept status'],
  ['rejectStatus', 'Reject status'],
  ['itemsPath', 'Items path', true],
  ['idPath', 'ID path'],
  ['keyPath', 'Key path', true],
  ['valuePath', 'Value path', true],
  ['pagePath', 'Page path'],
  ['rectPath', 'Rectangle path'],
  ['pointsPath', 'Points path'],
  ['confidencePath', 'Confidence path'],
  ['statusPath', 'Status path'],
] as const;
type TextField = (typeof categoryFields)[number][0];
export type CategoryValues = Partial<Record<TextField, string>> & {
  enabled?: boolean;
  callbackApiKey?: string;
  callbackTimeoutMs?: number;
  clearCallbackApiKey?: boolean;
};
export type Category = CategoryValues & { id: string | number };
export const categoryListFields = ['id', ...categoryFields.map(([name]) => name), 'enabled', 'callbackTimeoutMs'];

export function newCategory(): CategoryValues {
  const { name: _name, title: _title, ...mapping } = DEFAULT_MAPPING;
  return {
    ...mapping,
    acceptStatus: DEFAULT_SETTINGS.acceptStatus,
    rejectStatus: DEFAULT_SETTINGS.rejectStatus,
    callbackTimeoutMs: DEFAULT_SETTINGS.callbackTimeoutMs,
  };
}

export function categoryValues(values: CategoryValues): CategoryValues {
  const result: CategoryValues = {};
  for (const [name] of categoryFields) if (values[name] !== undefined) result[name] = values[name];
  result.enabled = values.enabled;
  result.callbackTimeoutMs = values.callbackTimeoutMs;
  if (values.clearCallbackApiKey) result.callbackApiKey = '';
  else if (values.callbackApiKey) result.callbackApiKey = values.callbackApiKey;
  return result;
}
