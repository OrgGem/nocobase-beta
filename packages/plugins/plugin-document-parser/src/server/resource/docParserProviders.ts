import type { Context, Next } from '@nocobase/actions';
import type { OcrEngineConfig } from '../services/document-parse.types';
import { testOcrProviderConnection } from '../services/external-ocr-client';
import { DEFAULT_SETTINGS, resolvePipeline } from '../../shared/defaults';

type SettingsPayload = {
  imagePassThrough?: boolean;
  includedExtnames?: string[];
  useDocpixie?: boolean;
  enableMarkitdown?: boolean;
  pipeline?: unknown;
};

type SettingsResponse = {
  id?: string | number;
  imagePassThrough: boolean;
  includedExtnames: string[];
  useDocpixie: boolean;
  enableMarkitdown: boolean;
  pipeline: ReturnType<typeof resolvePipeline>;
};

type DocumentParserPlugin = {
  parseRouter?: { invalidateSettingsCache(): void };
};

export async function testConnection(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  const repo = ctx.db.getRepository('docParserProviders');
  const record = await repo.findOne({ filterByTk });

  if (!record) {
    ctx.throw(404, 'Provider not found');
    return;
  }

  const result = await testOcrProviderConnection({
    apiEndpoint: record.get('apiEndpoint'),
    authType: record.get('authType'),
    apiKey: record.get('apiKey'),
    authConfig: record.get('authConfig') ?? {},
    requestFormat: record.get('requestFormat'),
    requestConfig: record.get('requestConfig') ?? {},
    timeout: Math.min(record.get('timeout') ?? 10000, 15000),
  });

  ctx.body = result;
  await next();
}

export async function getSettings(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository('docParserSettings');
  let record = await repo.findOne({});
  if (!record) {
    record = await repo.create({ values: { ...DEFAULT_SETTINGS } });
  }
  ctx.body = toSettingsResponse(record);
  await next();
}

export async function saveSettings(ctx: Context, next: Next) {
  const body = parseSettingsPayload(ctx.request.body);
  const repo = ctx.db.getRepository('docParserSettings');
  const existing = await repo.findOne({});
  const pipeline = resolvePipeline(body.pipeline ?? existing?.get('pipeline'), {
    activeProviderId: existing?.get('activeProviderId'),
    fallbackToDefault: existing?.get('fallbackToDefault'),
  });

  await validateOcrConfig(ctx, pipeline.ocr.primary);
  await validateOcrConfig(ctx, pipeline.ocr.fallback);
  if (sameOcrEngine(pipeline.ocr.primary, pipeline.ocr.fallback)) {
    ctx.throw(400, 'OCR primary and fallback must be different.');
    return;
  }

  const values = { ...body, pipeline };
  let record = existing;
  if (!record) {
    record = await repo.create({ values: { ...DEFAULT_SETTINGS, ...values } });
  } else {
    await repo.update({ filterByTk: record.get('id'), values });
    record = await repo.findOne({ filterByTk: record.get('id') });
  }

  const plugin = ctx.app.pm.get('plugin-document-parser') as DocumentParserPlugin | undefined;
  plugin?.parseRouter?.invalidateSettingsCache();

  ctx.body = toSettingsResponse(record);
  await next();
}

async function validateOcrConfig(ctx: Context, config: OcrEngineConfig): Promise<void> {
  if (config.kind === 'llm-vision') {
    if (!config.serviceId.trim() || !config.model.trim()) {
      ctx.throw(400, 'Vision OCR requires a service ID and model.');
    }
    return;
  }
  if (config.kind !== 'external-provider') {
    return;
  }

  const provider = await ctx.db.getRepository('docParserProviders').findOne({ filterByTk: config.providerId });
  if (!provider || !provider.get('enabled')) {
    ctx.throw(400, 'The configured external OCR provider is unavailable.');
  }
}

function sameOcrEngine(primary: OcrEngineConfig, fallback: OcrEngineConfig): boolean {
  if (primary.kind === 'external-provider' && fallback.kind === 'external-provider') {
    return String(primary.providerId) === String(fallback.providerId);
  }
  return (
    primary.kind === 'llm-vision' &&
    fallback.kind === 'llm-vision' &&
    primary.serviceId === fallback.serviceId &&
    primary.model === fallback.model
  );
}

function toSettingsResponse(record: { get(name: string): unknown }): SettingsResponse {
  return {
    id: record.get('id') as string | number | undefined,
    imagePassThrough: record.get('imagePassThrough') !== false,
    includedExtnames: Array.isArray(record.get('includedExtnames')) ? (record.get('includedExtnames') as string[]) : [],
    useDocpixie: record.get('useDocpixie') === true,
    enableMarkitdown: record.get('enableMarkitdown') !== false,
    pipeline: resolvePipeline(record.get('pipeline'), {
      activeProviderId: record.get('activeProviderId'),
      fallbackToDefault: record.get('fallbackToDefault'),
    }),
  };
}

function parseSettingsPayload(value: unknown): SettingsPayload {
  if (!isRecord(value)) {
    return {};
  }

  const payload: SettingsPayload = {};
  if (typeof value.imagePassThrough === 'boolean') payload.imagePassThrough = value.imagePassThrough;
  if (typeof value.useDocpixie === 'boolean') payload.useDocpixie = value.useDocpixie;
  if (typeof value.enableMarkitdown === 'boolean') payload.enableMarkitdown = value.enableMarkitdown;
  if (Array.isArray(value.includedExtnames) && value.includedExtnames.every((extname) => typeof extname === 'string')) {
    payload.includedExtnames = value.includedExtnames;
  }
  if ('pipeline' in value) payload.pipeline = value.pipeline;
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
