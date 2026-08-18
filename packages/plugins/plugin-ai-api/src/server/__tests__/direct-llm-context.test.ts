import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import {
  DirectLlmContextError,
  prepareDirectLlmContext,
  type OpenAIMessage,
  parseImageDimensions,
} from '../utils/direct-llm-context';

function context({ behavior = 'reject', metadata = { contextWindow: 120, maxCompletionTokens: 40 } } = {}): Context {
  return {
    state: { currentUser: { id: 1 } },
    db: {
      getRepository: vi.fn((name: string) => {
        if (name === 'aiApiModelMetadata') {
          return {
            findOne: vi.fn().mockResolvedValue({ get: (key: string) => metadata[key as keyof typeof metadata] }),
          };
        }
        if (name === 'aiApiGroupMembers') {
          return {
            findOne: vi.fn().mockResolvedValue(null),
          };
        }
        if (name === 'aiApiUsageGroups') {
          return {
            findOne: vi.fn().mockResolvedValue({
              get: (key?: string) => {
                const record: Record<string, unknown> = {
                  id: 1,
                  name: 'Default',
                  isDefault: true,
                  quotaMode: 'per_user',
                  rateLimitPerMinute: 60,
                  enabled: true,
                  periodType: 'monthly',
                  timezone: 'UTC',
                  currency: 'USD',
                  rejectUnpricedModel: true,
                  missingUsageBehavior: 'use_reserved',
                  contextOverflowBehavior: behavior,
                };
                if (!key) return record;
                return record[key];
              },
            }),
          };
        }
        return { findOne: vi.fn() };
      }),
    },
  } as unknown as Context;
}

function request(messages: OpenAIMessage[], tools?: unknown) {
  return {
    serviceName: 'test-service',
    modelId: 'test-model',
    messages,
    tools,
  };
}

// A 1x1 PNG encoded as a base64 data URL.
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// A tiny valid base64 PDF payload (PDF header + minimal content).
const TINY_PDF_BASE64 = 'data:application/pdf;base64,JVBERi0xLjAKPDwKPiEKZW5kb2JqCmVuZG9iagpl';

// A PNG header with 1280x720 dimensions. The pixel data is truncated/invalid,
// but the header is valid enough for dimension parsing to succeed.
const LARGE_PNG_HEADER_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABQAAAALQCAYAAADPfd1WAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoSAA';

// The fixed conservative estimate used for http(s) image URLs.
const VISION_HTTP_URL_ESTIMATE = 1024;

function largeContext(): Context {
  return context({ metadata: { contextWindow: 2000, maxCompletionTokens: 40 } });
}

describe('direct LLM context preparation', () => {
  it('uses reject when the user has no enabled policy', async () => {
    const ctx = context();
    vi.mocked(ctx.db.getRepository).mockImplementation((name: string) => {
      if (name === 'aiApiModelMetadata') {
        return {
          findOne: vi.fn().mockResolvedValue({ get: (key: string) => (key === 'contextWindow' ? 120 : 40) }),
        } as never;
      }
      if (name === 'aiApiGroupMembers') {
        return { findOne: vi.fn().mockResolvedValue(null) } as never;
      }
      if (name === 'aiApiUsageGroups') {
        return {
          findOne: vi.fn().mockResolvedValue({
            get: (key?: string) => {
              const record: Record<string, unknown> = {
                id: 1,
                name: 'Default',
                isDefault: true,
                quotaMode: 'per_user',
                rateLimitPerMinute: 60,
                enabled: true,
                periodType: 'monthly',
                timezone: 'UTC',
                currency: 'USD',
                rejectUnpricedModel: true,
                missingUsageBehavior: 'use_reserved',
                contextOverflowBehavior: 'reject',
              };
              if (!key) return record;
              return record[key];
            },
          }),
        } as never;
      }
      return { findOne: vi.fn().mockResolvedValue(null) } as never;
    });

    await expect(
      prepareDirectLlmContext(ctx, request([{ role: 'user', content: 'x'.repeat(400) }])),
    ).rejects.toMatchObject<Partial<DirectLlmContextError>>({ code: 'context_length_exceeded' });
  });

  it('keeps a request that fits the model input budget', async () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const prepared = await prepareDirectLlmContext(context(), request(messages));

    expect(prepared.messages).toBe(messages);
    expect(prepared.truncated).toBe(false);
    expect(prepared.inputTokenBudget).toBe(80);
  });

  it('rejects a requested output limit above model metadata', async () => {
    await expect(
      prepareDirectLlmContext(context(), { ...request([{ role: 'user', content: 'hello' }]), maxCompletionTokens: 41 }),
    ).rejects.toMatchObject<Partial<DirectLlmContextError>>({ code: 'max_completion_tokens_exceeds_model_limit' });
  });

  it('truncates oldest complete turns while preserving instructions and newest turn', async () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'Always answer safely.' },
      { role: 'user', content: 'first '.repeat(30) },
      { role: 'assistant', content: 'first answer '.repeat(20) },
      { role: 'user', content: 'latest question' },
    ];

    const prepared = await prepareDirectLlmContext(context({ behavior: 'truncate' }), request(messages));

    expect(prepared.truncated).toBe(true);
    expect(prepared.messages).toEqual([messages[0], messages[3]]);
    expect(messages).toHaveLength(4);
  });

  it('keeps assistant tool calls and their tool responses in the same turn', async () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'old question '.repeat(30) },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-old', type: 'function' }] },
      { role: 'tool', tool_call_id: 'call-old', content: 'old result '.repeat(20) },
      { role: 'user', content: 'latest question' },
    ];

    const prepared = await prepareDirectLlmContext(context({ behavior: 'truncate' }), request(messages));

    expect(prepared.messages).toEqual([messages[3]]);
  });

  it('rejects when the newest turn cannot fit without cutting content', async () => {
    await expect(
      prepareDirectLlmContext(context({ behavior: 'truncate' }), request([{ role: 'user', content: 'x'.repeat(400) }])),
    ).rejects.toMatchObject<Partial<DirectLlmContextError>>({ code: 'context_length_exceeded' });
  });

  it('estimates vision tokens for a base64 image_url and allows small payloads', async () => {
    const prepared = await prepareDirectLlmContext(
      largeContext(),
      request([{ role: 'user', content: [{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG } }] }]),
    );

    expect(prepared.estimatedInputTokens).toBeGreaterThan(0);
    expect(prepared.truncated).toBe(false);
  });

  it('estimates a fixed conservative token count for http(s) image_url URLs', async () => {
    const prepared = await prepareDirectLlmContext(
      largeContext(),
      request([
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] },
      ]),
    );

    expect(prepared.estimatedInputTokens).toBeGreaterThanOrEqual(VISION_HTTP_URL_ESTIMATE);
    expect(prepared.truncated).toBe(false);
  });

  it('rejects a base64 image that exceeds the input budget', async () => {
    // Large header claims 1000x1000, so vision estimate is 85 + 4 * 170 = 765 tokens,
    // which easily exceeds the 80 token budget of the default test context.
    await expect(
      prepareDirectLlmContext(
        context(),
        request([{ role: 'user', content: [{ type: 'image_url', image_url: { url: LARGE_PNG_HEADER_BASE64 } }] }]),
      ),
    ).rejects.toMatchObject<Partial<DirectLlmContextError>>({ code: 'context_length_exceeded' });
  });

  it('estimates file block tokens from decoded base64 size', async () => {
    const prepared = await prepareDirectLlmContext(
      context(),
      request([{ role: 'user', content: [{ type: 'file', file: { file_data: TINY_PDF_BASE64, filename: 'x.pdf' } }] }]),
    );

    expect(prepared.estimatedInputTokens).toBeGreaterThan(0);
    expect(prepared.truncated).toBe(false);
  });

  it('rejects a base64 file that exceeds the input budget', async () => {
    const largeBase64 = `data:application/pdf;base64,${Buffer.alloc(100_000).toString('base64')}`;
    await expect(
      prepareDirectLlmContext(
        context(),
        request([{ role: 'user', content: [{ type: 'file', file: { file_data: largeBase64, filename: 'x.pdf' } }] }]),
      ),
    ).rejects.toMatchObject<Partial<DirectLlmContextError>>({ code: 'context_length_exceeded' });
  });

  it('counts tool definitions as fixed input overhead', async () => {
    await expect(
      prepareDirectLlmContext(
        context(),
        request(
          [{ role: 'user', content: 'hello' }],
          [{ type: 'function', function: { name: 'large', parameters: { text: 'x'.repeat(400) } } }],
        ),
      ),
    ).rejects.toMatchObject<Partial<DirectLlmContextError>>({ code: 'context_length_exceeded' });
  });

  it('prepends the initial system prompt before the client system prompt', async () => {
    const clientMessages: OpenAIMessage[] = [
      { role: 'system', content: 'Client system prompt' },
      { role: 'user', content: 'hello' },
    ];
    const prepared = await prepareDirectLlmContext(
      context({ metadata: { contextWindow: 120, maxCompletionTokens: 40, systemPrompt: 'Initial prompt' } }),
      request(clientMessages),
    );

    expect(prepared.messages).toEqual([
      { role: 'system', content: 'Initial prompt' },
      { role: 'system', content: 'Client system prompt' },
      { role: 'user', content: 'hello' },
    ]);
    expect(prepared.truncated).toBe(false);
    expect(clientMessages).toHaveLength(2);
  });

  it('uses the initial system prompt as the only system message when the client sends none', async () => {
    const prepared = await prepareDirectLlmContext(
      context({ metadata: { contextWindow: 120, maxCompletionTokens: 40, systemPrompt: 'Initial prompt' } }),
      request([{ role: 'user', content: 'hello' }]),
    );

    expect(prepared.messages).toEqual([
      { role: 'system', content: 'Initial prompt' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('ignores a blank initial system prompt', async () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const prepared = await prepareDirectLlmContext(
      context({ metadata: { contextWindow: 120, maxCompletionTokens: 40, systemPrompt: '   ' } }),
      request(messages),
    );

    expect(prepared.messages).toBe(messages);
  });

  it('counts the initial system prompt toward the input budget', async () => {
    await expect(
      prepareDirectLlmContext(
        context({ metadata: { contextWindow: 120, maxCompletionTokens: 40, systemPrompt: 'x'.repeat(400) } }),
        request([{ role: 'user', content: 'hello' }]),
      ),
    ).rejects.toMatchObject<Partial<DirectLlmContextError>>({ code: 'context_length_exceeded' });
  });

  it('keeps the initial system prompt when truncating oldest turns', async () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'first '.repeat(30) },
      { role: 'assistant', content: 'first answer '.repeat(20) },
      { role: 'user', content: 'latest question' },
    ];

    const prepared = await prepareDirectLlmContext(
      context({
        behavior: 'truncate',
        metadata: { contextWindow: 120, maxCompletionTokens: 40, systemPrompt: 'Initial prompt' },
      }),
      request(messages),
    );

    expect(prepared.truncated).toBe(true);
    expect(prepared.messages).toEqual([{ role: 'system', content: 'Initial prompt' }, messages[2]]);
  });
});

describe('image dimension parsing', () => {
  it('parses PNG dimensions', () => {
    // The shared 1x1 test PNG is a valid PNG with dimensions 1x1.
    const base64 = ONE_PIXEL_PNG.split(',')[1];
    const png = Buffer.from(base64, 'base64');
    expect(parseImageDimensions(png)).toEqual({ width: 1, height: 1 });
  });

  it('parses JPEG dimensions without reading past width/height', () => {
    // Minimal JPEG SOF0 segment: height 1024, width 1024.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x04, 0x00, 0x04, 0x00, 0x01, 0x22, 0x00]);
    expect(parseImageDimensions(jpeg)).toEqual({ width: 1024, height: 1024 });
  });
});
