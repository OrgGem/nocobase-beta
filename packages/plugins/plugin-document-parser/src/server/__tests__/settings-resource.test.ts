import type { Context, Next } from '@nocobase/actions';
import { getSettings, saveSettings } from '../resource/docParserProviders';

const next = vi.fn() as unknown as Next;

type RecordValues = Record<string, unknown>;
type ResourceRecord = { get(name: string): unknown };

function record(values: RecordValues): ResourceRecord {
  return { get: (name) => values[name] };
}

function context(options: {
  body?: unknown;
  settings?: RecordValues;
  providers?: Map<string | number, RecordValues>;
}): { ctx: Context; updates: RecordValues[] } {
  const updates: RecordValues[] = [];
  const settings = options.settings ? record(options.settings) : null;
  const providers = options.providers ?? new Map<string | number, RecordValues>();
  const ctx = {
    request: { body: options.body },
    action: { params: {} },
    body: undefined,
    db: {
      getRepository(name: string) {
        if (name === 'docParserSettings') {
          return {
            findOne: vi.fn().mockResolvedValue(settings),
            create: vi.fn().mockImplementation(async ({ values }) => record({ id: 1, ...values })),
            update: vi.fn().mockImplementation(async ({ values }) => updates.push(values)),
          };
        }
        return {
          findOne: vi.fn().mockImplementation(async ({ filterByTk }) => {
            const values = providers.get(filterByTk);
            return values ? record(values) : null;
          }),
        };
      },
    },
    app: { pm: { get: vi.fn() } },
    throw(status: number, message: string) {
      throw new Error(`${status}: ${message}`);
    },
  } as unknown as Context;

  return { ctx, updates };
}

describe('document parser settings resource', () => {
  it('returns only the canonical settings DTO', async () => {
    const { ctx } = context({
      settings: {
        id: 3,
        imagePassThrough: false,
        includedExtnames: ['.pdf'],
        useDocpixie: true,
        enableMarkitdown: false,
        activeProviderId: 9,
        fallbackToDefault: false,
        mode: 'smart-fallback',
      },
    });

    await getSettings(ctx, next);

    expect(ctx.body).toEqual({
      id: 3,
      imagePassThrough: false,
      includedExtnames: ['.pdf'],
      useDocpixie: true,
      enableMarkitdown: false,
      pipeline: expect.objectContaining({
        ocr: expect.objectContaining({ primary: { kind: 'external-provider', providerId: 9 } }),
        chat: { fallbackToProviderDefault: false },
      }),
    });
    expect(ctx.body).not.toHaveProperty('mode');
    expect(ctx.body).not.toHaveProperty('activeProviderId');
    expect(ctx.body).not.toHaveProperty('fallbackToDefault');
  });

  it('ignores legacy routing fields submitted by a client', async () => {
    const { ctx, updates } = context({
      settings: {
        id: 3,
        activeProviderId: 9,
        fallbackToDefault: false,
        pipeline: {
          version: 1,
          ocr: { primary: { kind: 'none' }, fallback: { kind: 'none' } },
          chat: { fallbackToProviderDefault: true },
        },
      },
      body: {
        mode: 'external-provider',
        activeProviderId: 12,
        fallbackToDefault: false,
        imagePassThrough: false,
        pipeline: {
          version: 1,
          ocr: { primary: { kind: 'none' }, fallback: { kind: 'none' } },
          chat: { fallbackToProviderDefault: true },
        },
      },
    });

    await saveSettings(ctx, next);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ imagePassThrough: false, pipeline: expect.any(Object) });
    expect(updates[0]).not.toHaveProperty('mode');
    expect(updates[0]).not.toHaveProperty('activeProviderId');
    expect(updates[0]).not.toHaveProperty('fallbackToDefault');
  });

  it('rejects unavailable external OCR providers', async () => {
    const { ctx } = context({
      settings: { id: 3 },
      body: {
        pipeline: {
          ocr: {
            primary: { kind: 'external-provider', providerId: 'missing' },
            fallback: { kind: 'none' },
          },
        },
      },
    });

    await expect(saveSettings(ctx, next)).rejects.toThrow('400: The configured external OCR provider is unavailable.');
  });

  it('rejects incomplete Vision OCR configuration', async () => {
    const { ctx } = context({
      settings: { id: 3 },
      body: {
        pipeline: {
          ocr: {
            primary: { kind: 'llm-vision', serviceId: 'vision-service', model: '' },
            fallback: { kind: 'none' },
          },
        },
      },
    });

    await expect(saveSettings(ctx, next)).rejects.toThrow('400: Vision OCR requires a service ID and model.');
  });

  it('rejects duplicate primary and fallback OCR engines', async () => {
    const { ctx } = context({
      settings: { id: 3 },
      body: {
        pipeline: {
          ocr: {
            primary: { kind: 'llm-vision', serviceId: 'vision-service', model: 'vision-model' },
            fallback: { kind: 'llm-vision', serviceId: 'vision-service', model: 'vision-model' },
          },
        },
      },
    });

    await expect(saveSettings(ctx, next)).rejects.toThrow('400: OCR primary and fallback must be different.');
  });
});
