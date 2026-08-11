import type { DocumentParserPipeline, OcrEngineConfig } from '../server/services/document-parse.types';

export const DEFAULT_PIPELINE: DocumentParserPipeline = {
  version: 1,
  pdf: {
    enabled: true,
    textThreshold: { minCharacters: 200 },
    maxBytes: 50 * 1024 * 1024,
    maxPages: 20,
  },
  ocr: {
    enabled: true,
    primary: { kind: 'none' },
    fallback: { kind: 'none' },
    timeoutMs: 60_000,
  },
  chat: {
    fallbackToProviderDefault: true,
  },
};

export const DEFAULT_SETTINGS = {
  imagePassThrough: true,
  includedExtnames: [] as string[],
  useDocpixie: false,
  enableMarkitdown: true,
  pipeline: DEFAULT_PIPELINE,
} as const;

export function resolvePipeline(
  value: unknown,
  legacy: { activeProviderId?: unknown; fallbackToDefault?: unknown },
): DocumentParserPipeline {
  const source = asRecord(value);
  const pdf = asRecord(source?.pdf);
  const textThreshold = asRecord(pdf?.textThreshold);
  const ocr = asRecord(source?.ocr);
  const chat = asRecord(source?.chat);
  const primary = parseOcrConfig(ocr?.primary) ?? resolveLegacyPrimary(legacy.activeProviderId);
  const fallback = parseOcrConfig(ocr?.fallback) ?? { kind: 'none' };

  return {
    version: 1,
    pdf: {
      enabled: booleanOrDefault(pdf?.enabled, DEFAULT_PIPELINE.pdf.enabled),
      textThreshold: {
        minCharacters: positiveIntegerOrDefault(
          textThreshold?.minCharacters,
          DEFAULT_PIPELINE.pdf.textThreshold.minCharacters,
        ),
      },
      maxBytes: positiveIntegerOrDefault(pdf?.maxBytes, DEFAULT_PIPELINE.pdf.maxBytes),
      maxPages: positiveIntegerOrDefault(pdf?.maxPages, DEFAULT_PIPELINE.pdf.maxPages),
    },
    ocr: {
      enabled: booleanOrDefault(ocr?.enabled, DEFAULT_PIPELINE.ocr.enabled),
      primary,
      fallback,
      timeoutMs: positiveIntegerOrDefault(ocr?.timeoutMs, DEFAULT_PIPELINE.ocr.timeoutMs),
    },
    chat: {
      fallbackToProviderDefault: booleanOrDefault(chat?.fallbackToProviderDefault, legacy.fallbackToDefault !== false),
    },
  };
}

function resolveLegacyPrimary(activeProviderId: unknown): OcrEngineConfig {
  return typeof activeProviderId === 'string' || typeof activeProviderId === 'number'
    ? { kind: 'external-provider', providerId: activeProviderId }
    : { kind: 'none' };
}

function parseOcrConfig(value: unknown): OcrEngineConfig | null {
  const config = asRecord(value);
  if (!config || config.kind === 'none' || config.kind === 'provider-default') {
    return config ? { kind: config.kind } : null;
  }
  if (
    config.kind === 'external-provider' &&
    (typeof config.providerId === 'string' || typeof config.providerId === 'number')
  ) {
    return { kind: config.kind, providerId: config.providerId };
  }
  if (config.kind === 'llm-vision' && typeof config.serviceId === 'string' && typeof config.model === 'string') {
    return { kind: config.kind, serviceId: config.serviceId, model: config.model };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
