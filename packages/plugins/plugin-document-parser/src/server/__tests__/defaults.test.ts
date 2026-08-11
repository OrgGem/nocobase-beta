import { DEFAULT_PIPELINE, resolvePipeline } from '../../shared/defaults';

describe('resolvePipeline', () => {
  it('normalizes a legacy provider configuration when no canonical pipeline exists', () => {
    expect(resolvePipeline(undefined, { activeProviderId: 42, fallbackToDefault: false })).toEqual({
      ...DEFAULT_PIPELINE,
      ocr: {
        ...DEFAULT_PIPELINE.ocr,
        primary: { kind: 'external-provider', providerId: 42 },
      },
      chat: { fallbackToProviderDefault: false },
    });
  });

  it('prefers canonical pipeline values over legacy routing fields', () => {
    const pipeline = resolvePipeline(
      {
        ocr: {
          primary: { kind: 'llm-vision', serviceId: 'vision-service', model: 'vision-model' },
          fallback: { kind: 'none' },
        },
        chat: { fallbackToProviderDefault: true },
      },
      { activeProviderId: 42, fallbackToDefault: false },
    );

    expect(pipeline.ocr.primary).toEqual({ kind: 'llm-vision', serviceId: 'vision-service', model: 'vision-model' });
    expect(pipeline.chat.fallbackToProviderDefault).toBe(true);
  });

  it('replaces invalid values with canonical defaults', () => {
    const pipeline = resolvePipeline(
      {
        pdf: { maxBytes: 0, maxPages: -1, textThreshold: { minCharacters: 1.5 } },
        ocr: { timeoutMs: 'invalid', primary: { kind: 'external-provider' } },
      },
      {},
    );

    expect(pipeline.pdf).toEqual(DEFAULT_PIPELINE.pdf);
    expect(pipeline.ocr).toEqual(DEFAULT_PIPELINE.ocr);
  });
});
