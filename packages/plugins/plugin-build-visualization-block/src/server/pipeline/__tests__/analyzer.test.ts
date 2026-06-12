/**
 * Unit tests for the AI Analyzer pipeline stage.
 *
 * These tests exercise the pure output-cleaning / JSON-extraction helpers
 * (`stripThink`, `stripFence`, `toPlainText`, `extractJsonObject`), the
 * parse + shape-validation step (`parseBlockSpec`), and the full `analyze`
 * orchestration. `analyze` is driven against a hand-built fake `app` whose
 * `pm.get('ai')` returns a stub AI plugin exposing a chat model `invoke`, so no
 * real LLM (or server boot) is required. The stub is typed with small local
 * interfaces and cast to `Application` through `unknown` so the production
 * signature is exercised without resorting to `any`.
 */

import type { Application } from '@nocobase/server';
import { describe, expect, it, vi } from 'vitest';

import type { BlockSpec, SchemaSummary } from '../../../shared/blockSpec';
import { analyze, extractJsonObject, parseBlockSpec, stripFence, stripThink, toPlainText } from '../analyzer';

/** A schema summary with a single collection exposing an `id` field. */
const SUMMARY: SchemaSummary = {
  dataSource: 'main',
  collections: [
    {
      name: 'orders',
      fields: [{ name: 'id', type: 'bigInt', interface: 'integer', title: 'ID' }],
      relations: [],
    },
  ],
};

/** A well-formed chart BlockSpec the model is expected to produce. */
const VALID_SPEC: BlockSpec = {
  version: 1,
  blockType: 'chart',
  title: 'Orders overview',
  primaryCollection: 'orders',
  dataSource: 'main',
  charts: [
    {
      key: 'total',
      title: 'Total',
      chartType: 'antd.statistic',
      measures: [{ field: 'id', aggregation: 'count', alias: 'value' }],
    },
  ],
};

/** Minimal chat-model shape the analyzer invokes. */
interface FakeChatModel {
  invoke: (messages: unknown[]) => Promise<{ content: unknown }>;
}

/** Minimal `app` shape `analyze` depends on (only `pm.get('ai')`). */
interface FakeApp {
  pm: { get: (name: string) => unknown };
}

/**
 * Build a fake `app` whose AI plugin returns a provider that resolves the given
 * `content` from `chatModel.invoke`. When `throws` is provided, `invoke`
 * rejects with that error instead (the transport-failure path).
 */
function makeApp(options: { content?: unknown; throws?: Error }): {
  app: Application;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(async () => {
    if (options.throws) {
      throw options.throws;
    }
    return { content: options.content };
  });
  const chatModel: FakeChatModel = { invoke };
  const aiPlugin = {
    aiManager: {
      getLLMService: async () => ({ provider: { chatModel } }),
    },
  };
  const fake: FakeApp = {
    pm: { get: (name: string) => (name === 'ai' ? aiPlugin : undefined) },
  };
  return { app: fake as unknown as Application, invoke };
}

const PARAMS = { requirement: 'show order totals', summary: SUMMARY, llmService: 'svc', model: 'm' };

describe('stripThink', () => {
  it('removes a closed <think> block', () => {
    expect(stripThink('<think>reasoning here</think>hello')).toBe('hello');
  });

  it('removes an unclosed <think> block through end of string', () => {
    expect(stripThink('keep me\n<think>dangling reasoning')).toBe('keep me');
  });

  it('is case-insensitive', () => {
    expect(stripThink('<THINK>noise</THINK>visible')).toBe('visible');
  });
});

describe('stripFence', () => {
  it('strips a leading ```json fence and trailing fence', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips a bare ``` fence pair', () => {
    expect(stripFence('```\nplain text\n```')).toBe('plain text');
  });

  it('leaves unfenced text unchanged', () => {
    expect(stripFence('no fences here')).toBe('no fences here');
  });
});

describe('toPlainText', () => {
  it('passes a plain string through unchanged', () => {
    expect(toPlainText('hello world')).toBe('hello world');
  });

  it('joins an array of string/object parts with newlines', () => {
    const parts = ['a', { text: 'b' }, { content: 'c' }, 42];
    expect(toPlainText(parts)).toBe('a\nb\nc');
  });

  it('reads text/content from an object', () => {
    expect(toPlainText({ text: 'from-text' })).toBe('from-text');
    expect(toPlainText({ content: 'from-content' })).toBe('from-content');
  });

  it('falls back to JSON.stringify for other values', () => {
    expect(toPlainText({ foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(toPlainText(42)).toBe('42');
  });
});

describe('extractJsonObject', () => {
  it('extracts the inner object from prose + fences + think wrapping', () => {
    const raw = [
      '<think>deciding on a chart</think>',
      'Here is the spec you asked for:',
      '```json',
      '{"a": 1, "b": {"c": 2}}',
      '```',
    ].join('\n');
    expect(extractJsonObject(raw)).toBe('{"a": 1, "b": {"c": 2}}');
  });

  it('returns the cleaned text unchanged when no braces are present', () => {
    expect(extractJsonObject('<think>x</think>just words')).toBe('just words');
  });
});

describe('parseBlockSpec', () => {
  it('returns ok with the spec for valid BlockSpec JSON', () => {
    const result = parseBlockSpec(JSON.stringify(VALID_SPEC));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec).toEqual(VALID_SPEC);
    }
  });

  it('reports a parse error for malformed JSON', () => {
    const result = parseBlockSpec('not json {');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Failed to parse LLM output as JSON');
    }
  });

  it('reports a shape error for JSON missing the version field', () => {
    const { version: _omitted, ...withoutVersion } = VALID_SPEC;
    const result = parseBlockSpec(JSON.stringify(withoutVersion));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('did not match BlockSpec shape');
      expect(result.error).toContain('version');
    }
  });

  it('reports a shape error for an invalid blockType', () => {
    const result = parseBlockSpec(JSON.stringify({ ...VALID_SPEC, blockType: 'pie' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('did not match BlockSpec shape');
      expect(result.error).toContain('blockType');
    }
  });
});

describe('analyze', () => {
  it('returns the model spec without fallback for valid BlockSpec output', async () => {
    const { app, invoke } = makeApp({ content: JSON.stringify(VALID_SPEC) });

    const result = await analyze(app, PARAMS);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.usedFallback).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.spec).toEqual(VALID_SPEC);
  });

  it('falls back with an error when the model output cannot be parsed', async () => {
    const { app } = makeApp({ content: 'totally not json' });

    const result = await analyze(app, PARAMS);

    expect(result.usedFallback).toBe(true);
    expect(result.error).toBeTruthy();
    // The fallback is a grounded collection-overview chart bound to the summary.
    expect(result.spec.blockType).toBe('chart');
    expect(result.spec.primaryCollection).toBe('orders');
    expect(result.spec.charts?.[0].measures[0].field).toBe('id');
  });

  it('falls back with an error when the LLM invocation throws', async () => {
    const { app } = makeApp({ throws: new Error('transport exploded') });

    const result = await analyze(app, PARAMS);

    expect(result.usedFallback).toBe(true);
    expect(result.error).toContain('transport exploded');
    expect(result.spec.blockType).toBe('chart');
    expect(result.spec.primaryCollection).toBe('orders');
  });
});
