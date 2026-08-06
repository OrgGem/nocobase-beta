import type { Context } from '@nocobase/actions';
import {
  addAiApiUsage,
  finishAiApiObservation,
  markAiApiFirstProviderOutput,
  startAiApiObservation,
} from '../utils/app-observability';

const CONTRACT_SYMBOL = Symbol.for('nocobase.app-observability.contract');

function createContext(contract?: object): Context {
  const app = {
    logger: { warn: vi.fn() },
    ...(contract ? { [CONTRACT_SYMBOL]: contract } : {}),
  };
  return { app, state: {} } as unknown as Context;
}

describe('AI API app observability bridge', () => {
  it('is a no-op when observability is absent', () => {
    const ctx = createContext();
    expect(() => {
      startAiApiObservation(ctx, {
        service: 'llm.chat',
        operation: '/chat/completions',
        streaming: true,
        mode: 'llm',
      });
      markAiApiFirstProviderOutput(ctx);
      addAiApiUsage(ctx, { prompt_tokens: 2, completion_tokens: 3 });
      finishAiApiObservation(ctx, { status: 'succeeded' });
    }).not.toThrow();
  });

  it('records TTFT, normalized usage and finalizes exactly once', () => {
    const handle = {
      markFirstByte: vi.fn(),
      addInputTokens: vi.fn(),
      addOutputTokens: vi.fn(),
      finish: vi.fn(),
    };
    const start = vi.fn(() => handle);
    const ctx = createContext({ start });

    startAiApiObservation(ctx, {
      service: 'llm.agent',
      operation: '/chat/completions',
      streaming: true,
      model: 'service/model',
      mode: 'agent',
    });
    markAiApiFirstProviderOutput(ctx);
    addAiApiUsage(ctx, { prompt_tokens: 11, completion_tokens: 7 });
    finishAiApiObservation(ctx, { status: 'succeeded' });
    finishAiApiObservation(ctx, { status: 'failed' });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'llm.agent',
        streaming: true,
        attributes: expect.objectContaining({ mode: 'agent', model: 'service/model' }),
      }),
    );
    expect(handle.markFirstByte).toHaveBeenCalledTimes(1);
    expect(handle.addInputTokens).toHaveBeenCalledWith(11);
    expect(handle.addOutputTokens).toHaveBeenCalledWith(7);
    expect(handle.finish).toHaveBeenCalledTimes(1);
    expect(handle.finish).toHaveBeenCalledWith({ status: 'succeeded' });
  });

  it('fails open when contract callbacks throw', () => {
    const ctx = createContext({
      start: () => ({
        markFirstByte: () => {
          throw new Error('ttft failed');
        },
        addInputTokens: () => {
          throw new Error('tokens failed');
        },
        addOutputTokens: () => {},
        finish: () => {
          throw new Error('finish failed');
        },
      }),
    });
    expect(() => {
      startAiApiObservation(ctx, {
        service: 'llm.completion',
        operation: '/completions',
        streaming: true,
        mode: 'llm',
      });
      markAiApiFirstProviderOutput(ctx);
      addAiApiUsage(ctx, { prompt_tokens: 1, completion_tokens: null });
      finishAiApiObservation(ctx, { status: 'failed', errorCode: 'stream_error' });
    }).not.toThrow();
  });
});
