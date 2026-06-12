import type { ResourceOptions } from '@nocobase/resourcer';

import { MAX_COLLECTIONS, SETTINGS_COLLECTION_NAME } from '../../shared/constants';

interface SettingsRecord {
  id?: number | string;
  defaultDataSource?: string | null;
  defaultCollections?: unknown;
  defaultLLMService?: string | null;
  defaultModel?: string | null;
  enableAITool?: boolean | null;
  get?(key: string): unknown;
  update(values: Record<string, unknown>): Promise<void>;
}

interface SettingsRepository {
  findOne(): Promise<SettingsRecord | null>;
  create(options: { values: Record<string, unknown> }): Promise<SettingsRecord>;
}

const DEFAULT_SETTINGS = {
  defaultCollections: [],
  enableAITool: true,
};

function readRecordValue(record: SettingsRecord, key: string): unknown {
  if (typeof record.get === 'function') {
    return record.get(key);
  }
  return (record as Record<string, unknown>)[key];
}

function normalizeCollections(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, MAX_COLLECTIONS);
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function serializeSettings(record: SettingsRecord) {
  return {
    defaultDataSource: normalizeOptionalString(readRecordValue(record, 'defaultDataSource')),
    defaultCollections: normalizeCollections(readRecordValue(record, 'defaultCollections')),
    defaultLLMService: normalizeOptionalString(readRecordValue(record, 'defaultLLMService')),
    defaultModel: normalizeOptionalString(readRecordValue(record, 'defaultModel')),
    enableAITool: readRecordValue(record, 'enableAITool') !== false,
  };
}

function sanitizeValues(values: unknown) {
  const source = values && typeof values === 'object' ? (values as Record<string, unknown>) : {};
  return {
    defaultDataSource: normalizeOptionalString(source.defaultDataSource),
    defaultCollections: normalizeCollections(source.defaultCollections),
    defaultLLMService: normalizeOptionalString(source.defaultLLMService),
    defaultModel: normalizeOptionalString(source.defaultModel),
    enableAITool: source.enableAITool !== false,
  };
}

async function getSettings(ctx: { db: { getRepository(name: string): SettingsRepository } }) {
  const repo = ctx.db.getRepository(SETTINGS_COLLECTION_NAME);
  const existing = await repo.findOne();
  if (existing) {
    return existing;
  }
  return repo.create({ values: DEFAULT_SETTINGS });
}

export const aiVisualizationBuildSettings: ResourceOptions = {
  name: SETTINGS_COLLECTION_NAME,
  actions: {
    get: async (ctx, next) => {
      const settings = await getSettings(ctx);
      ctx.body = serializeSettings(settings);
      await next();
    },
    publicGet: async (ctx, next) => {
      const settings = await getSettings(ctx);
      ctx.body = serializeSettings(settings);
      await next();
    },
    update: async (ctx, next) => {
      const settings = await getSettings(ctx);
      const nextValues = sanitizeValues(ctx.action.params.values);
      await settings.update(nextValues);
      ctx.body = nextValues;
      await next();
    },
  },
};

export default aiVisualizationBuildSettings;
