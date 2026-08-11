import { DEFAULT_SETTINGS } from '../constants';
import type { FileSearchSettings } from '../types';

function normalizeExtnames(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_SETTINGS.allowedExtnames;
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((item) => (item.startsWith('.') ? item : `.${item}`)),
    ),
  );
}

function toPositiveInteger(value: unknown, fallback: number, min = 1) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.round(numberValue));
}

export function normalizeSettings(record: Record<string, unknown> = {}): FileSearchSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...record,
    enabled: record.enabled !== undefined ? Boolean(record.enabled) : DEFAULT_SETTINGS.enabled,
    autoIndex: record.autoIndex !== undefined ? Boolean(record.autoIndex) : DEFAULT_SETTINGS.autoIndex,
    enableAiTool: record.enableAiTool !== undefined ? Boolean(record.enableAiTool) : DEFAULT_SETTINGS.enableAiTool,
    parserStrategy: record.parserStrategy === 'direct' ? 'direct' : DEFAULT_SETTINGS.parserStrategy,
    llmService: typeof record.llmService === 'string' && record.llmService ? record.llmService : null,
    indexModel: typeof record.indexModel === 'string' && record.indexModel ? record.indexModel : null,
    retrieveModel: typeof record.retrieveModel === 'string' && record.retrieveModel ? record.retrieveModel : null,
    pageIndexWorkspace:
      typeof record.pageIndexWorkspace === 'string' && record.pageIndexWorkspace
        ? record.pageIndexWorkspace
        : DEFAULT_SETTINGS.pageIndexWorkspace,
    pageIndexPythonCommand:
      typeof record.pageIndexPythonCommand === 'string' && record.pageIndexPythonCommand
        ? record.pageIndexPythonCommand
        : DEFAULT_SETTINGS.pageIndexPythonCommand,
    maxFileSizeMb: toPositiveInteger(record.maxFileSizeMb, DEFAULT_SETTINGS.maxFileSizeMb),
    allowedExtnames: normalizeExtnames(record.allowedExtnames),
    concurrency: toPositiveInteger(record.concurrency, DEFAULT_SETTINGS.concurrency),
    timeoutMs: toPositiveInteger(record.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 60_000),
  };
}

export async function getOrCreateSettings(db: any): Promise<FileSearchSettings> {
  const repo = db.getRepository('fileSearchSettings');
  let record = await repo.findOne({ filter: { singletonKey: 'default' } });
  if (!record) {
    record = await repo.create({ values: DEFAULT_SETTINGS });
  }
  return normalizeSettings(typeof record.toJSON === 'function' ? record.toJSON() : record);
}

export async function saveSettings(db: any, values: Record<string, unknown>): Promise<FileSearchSettings> {
  const repo = db.getRepository('fileSearchSettings');
  const current = await getOrCreateSettings(db);
  const next = normalizeSettings({ ...current, ...values, singletonKey: 'default' });
  const existing = await repo.findOne({ filter: { singletonKey: 'default' } });
  if (existing) {
    await repo.update({ filterByTk: existing.get('id'), values: next });
  } else {
    await repo.create({ values: next });
  }
  return next;
}
