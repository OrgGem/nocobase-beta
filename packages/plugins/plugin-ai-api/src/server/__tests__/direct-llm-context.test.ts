import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import { DirectLlmContextError, prepareDirectLlmContext, type OpenAIMessage } from '../utils/direct-llm-context';

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
        if (name === 'aiApiUserQuotaPolicies') {
          return {
            findOne: vi
              .fn()
              .mockResolvedValue({ get: (key: string) => (key === 'contextOverflowBehavior' ? behavior : undefined) }),
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

describe('direct LLM context preparation', () => {
  it('uses reject when the user has no enabled policy', async () => {
    const ctx = context();
    vi.mocked(ctx.db.getRepository).mockImplementation((name: string) => {
      if (name === 'aiApiModelMetadata') {
        return {
          findOne: vi.fn().mockResolvedValue({ get: (key: string) => (key === 'contextWindow' ? 120 : 40) }),
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

  it('rejects image content until a model-specific estimator is available', async () => {
    await expect(
      prepareDirectLlmContext(
        context(),
        request([
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] },
        ]),
      ),
    ).rejects.toMatchObject<Partial<DirectLlmContextError>>({ code: 'context_estimation_unsupported' });
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
});
