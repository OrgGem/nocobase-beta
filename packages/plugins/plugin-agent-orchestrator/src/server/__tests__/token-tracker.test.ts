/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenTracker, usageFromAIUsageEvent } from '../services/TokenTracker';

type Row = Record<string, unknown>;

class MemoryRepository {
  rows: Row[];
  private nextId: number;

  constructor(rows: Row[] = []) {
    this.rows = rows;
    this.nextId = Math.max(0, ...rows.map((row) => Number(row.id) || 0)) + 1;
  }

  async find(options: Record<string, unknown> = {}) {
    const filter = (options.filter || {}) as Row;
    return this.rows.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
  }

  async findOne(options: Record<string, unknown> = {}) {
    const id = options.filterByTk;
    if (id !== undefined) return this.rows.find((row) => row.id === id) ?? null;
    return (await this.find(options))[0] ?? null;
  }

  async create(options: Record<string, unknown>) {
    const values = options.values as Row;
    const row = { id: this.nextId++, ...values };
    this.rows.push(row);
    return row;
  }

  async update(options: Record<string, unknown>) {
    const values = options.values as Row;
    const row = this.rows.find((item) => item.id === options.filterByTk);
    if (row) Object.assign(row, values);
    return row;
  }
}

function createTracker(options: { spans?: Row[]; runs?: Row[]; events?: Row[] } = {}) {
  const spanRepo = new MemoryRepository(options.spans);
  const runRepo = new MemoryRepository(options.runs ?? [{ id: 7, budgetMaxTokens: 0, budgetMaxCost: 0 }]);
  const eventRepo = new MemoryRepository(options.events);
  const repositories = new Map([
    ['agentExecutionSpans', spanRepo],
    ['agentLoopRuns', runRepo],
    ['aiUsageEvents', eventRepo],
  ]);
  const plugin = {
    app: { log: { warn: vi.fn() } },
    db: { getRepository: (name: string) => repositories.get(name) },
  };
  return { tracker: new TokenTracker(plugin), spanRepo, runRepo, eventRepo };
}

describe('TokenTracker', () => {
  const originalModelPricing = process.env.ORCHESTRATOR_MODEL_PRICING_JSON;
  const originalInputPrice = process.env.ORCHESTRATOR_PRICE_PER_1K_INPUT;
  const originalOutputPrice = process.env.ORCHESTRATOR_PRICE_PER_1K_OUTPUT;

  beforeEach(() => {
    delete process.env.ORCHESTRATOR_MODEL_PRICING_JSON;
    delete process.env.ORCHESTRATOR_PRICE_PER_1K_INPUT;
    delete process.env.ORCHESTRATOR_PRICE_PER_1K_OUTPUT;
  });

  afterEach(() => {
    if (originalModelPricing === undefined) delete process.env.ORCHESTRATOR_MODEL_PRICING_JSON;
    else process.env.ORCHESTRATOR_MODEL_PRICING_JSON = originalModelPricing;
    if (originalInputPrice === undefined) delete process.env.ORCHESTRATOR_PRICE_PER_1K_INPUT;
    else process.env.ORCHESTRATOR_PRICE_PER_1K_INPUT = originalInputPrice;
    if (originalOutputPrice === undefined) delete process.env.ORCHESTRATOR_PRICE_PER_1K_OUTPUT;
    else process.env.ORCHESTRATOR_PRICE_PER_1K_OUTPUT = originalOutputPrice;
  });

  it('keeps loop step IDs separate from execution span IDs', async () => {
    const { tracker, spanRepo } = createTracker({
      spans: [{ id: 12, type: 'sub_agent', inputTokens: 2, outputTokens: 3, cost: null }],
    });

    await tracker.trackLoopInvocationUsage({
      runId: 7,
      stepId: 12,
      sessionId: 'session-1',
      messageId: 'message-1',
      usage: null,
      input: 'prompt text',
      output: 'answer text',
      role: 'leader',
      employeeUsername: 'planner',
    });

    expect(spanRepo.rows[0]).toMatchObject({ id: 12, type: 'sub_agent', inputTokens: 2, outputTokens: 3 });
    expect(spanRepo.rows).toContainEqual(
      expect.objectContaining({
        type: 'invocation_summary',
        agentLoopStepId: 12,
        usageSource: 'estimated',
        cost: null,
        pricingStatus: 'unpriced',
      }),
    );
  });

  it('updates one usage identity on retry and resume instead of counting it twice', async () => {
    const { tracker, spanRepo, runRepo } = createTracker();
    const usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };
    const event = {
      sessionId: 'session-1',
      messageId: 'message-1',
      eventType: 'llm_message',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cachedTokens: 0,
      reasoningTokens: 0,
      rawUsageMetadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      model: 'model-a',
      provider: 'provider-a',
    };
    const first = await tracker.recordModelCallUsage({
      usageIdentity: 'ai-usage-event:session-1:message-1',
      nativeIdentity: 'ai-usage-event:session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      usage,
      model: 'model-a',
      provider: 'provider-a',
      runId: 7,
      source: 'ai_usage_event',
    });
    const second = await tracker.recordModelCallUsage({
      usageIdentity: 'ai-usage-event:session-1:message-1',
      nativeIdentity: 'ai-usage-event:session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      usage,
      model: 'model-a',
      provider: 'provider-a',
      runId: 7,
      source: 'ai_usage_event',
    });

    expect(first).toBe(second);
    expect(spanRepo.rows.filter((row) => row.type === 'model_call')).toHaveLength(1);
    expect(runRepo.rows[0]).toMatchObject({ totalInputTokens: 10, totalOutputTokens: 4, totalTokens: 14 });
  });

  it('replaces estimates with actual usage and preserves the actual provider counts', async () => {
    process.env.ORCHESTRATOR_MODEL_PRICING_JSON = JSON.stringify({
      'provider-a/model-a': {
        inputPer1k: 0.002,
        outputPer1k: 0.008,
        currency: 'USD',
        version: 'pricing-v3',
      },
    });
    const { tracker, spanRepo } = createTracker({
      spans: [
        {
          id: 3,
          type: 'model_call',
          usageIdentity: 'ai-usage-event:session-1:message-1',
          usageSource: 'estimated',
          usageOrigin: 'text_length_estimate',
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cost: null,
          pricingStatus: 'unpriced',
        },
      ],
    });

    await tracker.recordModelCallUsage({
      usageIdentity: 'ai-usage-event:session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      usage: { inputTokens: 80, outputTokens: 10, totalTokens: 90 },
      model: 'model-a',
      provider: 'provider-a',
      source: 'ai_usage_event',
    });

    expect(spanRepo.rows[0]).toMatchObject({
      usageSource: 'actual',
      inputTokens: 80,
      outputTokens: 10,
      totalTokens: 90,
      pricingStatus: 'configured',
      priceVersion: 'pricing-v3',
    });
    expect(spanRepo.rows[0].cost).toBeCloseTo(0.00024, 8);
  });

  it('keeps the original price snapshot on replay and applies it to corrected actual counts', async () => {
    process.env.ORCHESTRATOR_MODEL_PRICING_JSON = JSON.stringify({
      'provider-a/model-a': {
        inputPer1k: 0.002,
        outputPer1k: 0.008,
        currency: 'USD',
        version: 'pricing-v1',
      },
    });
    const { tracker, spanRepo } = createTracker();
    const base = {
      usageIdentity: 'ai-usage-event:session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      model: 'model-a',
      provider: 'provider-a',
      source: 'ai_usage_event' as const,
    };

    await tracker.recordModelCallUsage({
      ...base,
      usage: { inputTokens: 80, outputTokens: 10, totalTokens: 90 },
    });
    process.env.ORCHESTRATOR_MODEL_PRICING_JSON = JSON.stringify({
      'provider-a/model-a': {
        inputPer1k: 0.02,
        outputPer1k: 0.08,
        currency: 'USD',
        version: 'pricing-v2',
      },
    });

    await tracker.recordModelCallUsage({
      ...base,
      usage: { inputTokens: 80, outputTokens: 10, totalTokens: 90 },
    });
    expect(spanRepo.rows[0]).toMatchObject({ usageSource: 'actual', priceVersion: 'pricing-v1' });
    expect(spanRepo.rows[0].cost).toBeCloseTo(0.00024, 8);

    await tracker.recordModelCallUsage({
      ...base,
      usage: { inputTokens: 160, outputTokens: 20, totalTokens: 180 },
    });
    expect(spanRepo.rows[0]).toMatchObject({
      inputTokens: 160,
      outputTokens: 20,
      totalTokens: 180,
      priceVersion: 'pricing-v1',
    });
    expect(spanRepo.rows[0].cost).toBeCloseTo(0.00048, 8);
  });

  it('does not let missing usage replace an existing actual model call', async () => {
    const { tracker, spanRepo } = createTracker();
    const base = {
      usageIdentity: 'ai-usage-event:session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      model: 'model-a',
      provider: 'provider-a',
      source: 'ai_usage_event' as const,
    };

    await tracker.recordModelCallUsage({
      ...base,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    await tracker.recordModelCallUsage({ ...base, usage: null });

    expect(spanRepo.rows).toHaveLength(1);
    expect(spanRepo.rows[0]).toMatchObject({
      usageSource: 'actual',
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
  });

  it('accepts provider-confirmed zero counts but rejects ambiguous zero defaults', () => {
    expect(
      usageFromAIUsageEvent({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        rawUsageMetadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      }),
    ).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(
      usageFromAIUsageEvent({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        rawUsageMetadata: {},
      }),
    ).toBeNull();
  });

  it('uses the native occurrence time for the model-call span', async () => {
    const { tracker, spanRepo } = createTracker();
    const occurredAt = new Date('2026-11-09T12:34:56.000Z');

    await tracker.recordModelCallUsage({
      usageIdentity: 'ai-usage-event:session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      source: 'ai_usage_event',
      occurredAt,
    });

    expect(spanRepo.rows[0]).toMatchObject({ usageOccurredAt: occurredAt, startedAt: occurredAt, endedAt: occurredAt });
  });

  it('reports failed persistence without claiming the model call was recorded', async () => {
    const { tracker, spanRepo } = createTracker();
    vi.spyOn(spanRepo, 'create').mockRejectedValue(new Error('fixture write failure'));

    await expect(
      tracker.recordModelCallUsage({
        usageIdentity: 'ai-usage-event:session-1:message-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        source: 'ai_usage_event',
      }),
    ).resolves.toBeUndefined();
    expect(spanRepo.rows).toHaveLength(0);
  });

  it('does not count parent span tokens or invocation summaries with model-call totals', async () => {
    const { tracker, runRepo } = createTracker({
      spans: [
        { id: 1, type: 'sub_agent', agentLoopRunId: 7, inputTokens: 900, outputTokens: 300, cost: 2 },
        {
          id: 2,
          type: 'invocation_summary',
          agentLoopRunId: 7,
          inputTokens: 800,
          outputTokens: 200,
          cost: 1,
        },
        {
          id: 3,
          type: 'model_call',
          agentLoopRunId: 7,
          usageSource: 'actual',
          pricingStatus: 'unpriced',
          inputTokens: 70,
          outputTokens: 30,
          totalTokens: 100,
          cost: null,
        },
      ],
    });

    await tracker.accumulateToRun(7);

    expect(runRepo.rows[0]).toMatchObject({
      totalInputTokens: 70,
      totalOutputTokens: 30,
      totalTokens: 100,
      totalCost: null,
      usageStatus: 'actual',
      pricingStatus: 'unpriced',
    });
  });

  it('keeps missing usage and unpriced cost explicit instead of turning them into zeros', async () => {
    const { tracker, spanRepo, runRepo } = createTracker();

    await tracker.recordModelCallUsage({
      usageIdentity: 'ai-usage-event:session-1:message-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      usage: null,
      model: 'model-a',
      provider: 'provider-a',
      runId: 7,
      source: 'ai_usage_event',
    });

    expect(spanRepo.rows[0]).toMatchObject({
      usageSource: 'missing',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cost: null,
      pricingStatus: 'unpriced',
    });
    expect(runRepo.rows[0]).toMatchObject({
      totalInputTokens: null,
      totalOutputTokens: null,
      totalTokens: null,
      totalCost: null,
      usageStatus: 'missing',
      pricingStatus: 'unpriced',
    });
  });

  it('treats explicit zero-token usage as actual rather than estimating from text', async () => {
    const { tracker, spanRepo } = createTracker({
      spans: [{ id: 5, type: 'model_call', inputTokens: null, outputTokens: null, totalTokens: null, cost: null }],
    });

    await tracker.trackActualUsage(5, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, 'long prompt', 'response');

    expect(spanRepo.rows[0]).toMatchObject({
      usageSource: 'actual',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: null,
      pricingStatus: 'unpriced',
    });
  });

  it('synchronizes native event histories idempotently and distinguishes missing usage from zero', async () => {
    const event = {
      sessionId: 'session-2',
      messageId: 'message-2',
      eventType: 'llm_message',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      rawUsageMetadata: {},
      model: 'model-b',
      provider: 'provider-b',
    };
    const { tracker, spanRepo } = createTracker({ events: [event] });

    await tracker.syncNativeUsageEvents({ sessionId: 'session-2', runId: 7 });
    await tracker.syncNativeUsageEvents({ sessionId: 'session-2', runId: 7 });

    expect(spanRepo.rows.filter((row) => row.type === 'model_call')).toHaveLength(1);
    expect(spanRepo.rows[0]).toMatchObject({ usageSource: 'missing', inputTokens: null, cost: null });
  });

  it('keeps an empty native session incomplete until a provider-confirmed zero event is reconciled', async () => {
    const { tracker, runRepo, eventRepo, spanRepo } = createTracker();
    await tracker.trackLoopInvocationUsage({
      runId: 7,
      stepId: 3,
      sessionId: 'session-empty',
      messageId: 'message-empty',
      usage: null,
      input: 'prompt',
      output: 'response',
      role: 'leader',
      employeeUsername: 'planner',
    });

    expect(runRepo.rows[0]).toMatchObject({
      usageStatus: 'missing',
      pricingStatus: 'unpriced',
      totalCost: null,
      usageIncompleteSessions: ['session-empty'],
    });
    await tracker.syncNativeUsageEvents({ sessionId: 'session-empty', runId: 7 });
    expect(runRepo.rows[0].usageIncompleteSessions).toEqual(['session-empty']);

    eventRepo.rows.push({
      sessionId: 'session-empty',
      messageId: 'message-empty',
      eventType: 'llm_message',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      rawUsageMetadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      occurredAt: new Date('2026-11-09T12:34:56.000Z'),
    });
    await tracker.syncNativeUsageEvents({ sessionId: 'session-empty', runId: 7 });

    expect(runRepo.rows[0]).toMatchObject({
      usageStatus: 'actual',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      usageIncompleteSessions: [],
    });
    expect(spanRepo.rows.filter((row) => row.type === 'model_call')).toHaveLength(1);
  });

  it('persists incomplete status on a partial ingestion failure and clears it after reconciliation', async () => {
    const { tracker, spanRepo, runRepo } = createTracker({
      spans: [
        {
          id: 1,
          type: 'model_call',
          usageIdentity: 'prior-known-call',
          agentLoopRunId: 7,
          usageSource: 'actual',
          pricingStatus: 'configured',
          priceCurrency: 'USD',
          inputTokens: 9,
          outputTokens: 4,
          totalTokens: 13,
          cost: 0.02,
        },
      ],
      runs: [
        {
          id: 7,
          budgetMaxTokens: 100,
          budgetMaxCost: 0,
          invocationCount: 1,
          totalInputTokens: 9,
          totalOutputTokens: 4,
          totalTokens: 13,
          totalCost: 0.02,
          usageStatus: 'actual',
          pricingStatus: 'configured',
          usageIncompleteSessions: [],
        },
      ],
      events: [
        {
          sessionId: 'session-partial',
          messageId: 'message-1',
          eventType: 'llm_message',
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          rawUsageMetadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
        {
          sessionId: 'session-partial',
          messageId: 'message-2',
          eventType: 'llm_message',
          inputTokens: 4,
          outputTokens: 3,
          totalTokens: 7,
          rawUsageMetadata: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
        },
      ],
    });
    const originalCreate = spanRepo.create.bind(spanRepo);
    vi.spyOn(spanRepo, 'create').mockImplementation(async (options) => {
      const values = options.values as Row;
      if (values.usageIdentity === 'ai-usage-event:session-partial:message-2') {
        throw new Error('fixture write failure');
      }
      return originalCreate(options);
    });

    await expect(tracker.syncNativeUsageEvents({ sessionId: 'session-partial', runId: 7 })).resolves.toBe(-1);
    expect(runRepo.rows[0]).toMatchObject({
      usageStatus: 'partial',
      pricingStatus: 'unpriced',
      totalTokens: 13,
      totalCost: null,
      usageIncompleteSessions: ['session-partial'],
    });
    await expect(tracker.checkBudget(7)).resolves.toMatchObject({ allowed: false });

    vi.mocked(spanRepo.create).mockRestore();
    await expect(tracker.syncNativeUsageEvents({ sessionId: 'session-partial', runId: 7 })).resolves.toBe(2);
    expect(runRepo.rows[0]).toMatchObject({
      usageStatus: 'actual',
      totalTokens: 35,
      usageIncompleteSessions: [],
    });
    await expect(tracker.checkBudget(7)).resolves.toMatchObject({ allowed: true });
  });

  it('fails closed for incomplete budgets even with a known token subtotal but allows an empty run', async () => {
    for (const usageState of [
      { usageStatus: 'missing' },
      { usageStatus: 'partial' },
      { usageStatus: 'actual', usageIncompleteSessions: ['session-1'] },
    ]) {
      const { tracker } = createTracker({
        runs: [
          {
            id: 7,
            budgetMaxTokens: 100,
            budgetMaxCost: 0,
            invocationCount: 1,
            totalTokens: 24,
            ...usageState,
          },
        ],
      });
      await expect(tracker.checkBudget(7)).resolves.toMatchObject({ allowed: false });
    }

    const emptyRun = createTracker({
      runs: [{ id: 7, budgetMaxTokens: 100, budgetMaxCost: 0, invocationCount: 0, totalTokens: 0 }],
    });
    await expect(emptyRun.tracker.checkBudget(7)).resolves.toEqual({ allowed: true });
  });

  it('rejects malformed currency text and keeps valid non-USD cost out of USD totals', async () => {
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    process.env.ORCHESTRATOR_MODEL_PRICING_JSON = JSON.stringify({
      'provider-a/model-invalid-currency': {
        inputPer1k: 1,
        outputPer1k: 1,
        currency: 'US dollars long',
      },
    });
    const invalid = createTracker();
    await invalid.tracker.recordModelCallUsage({
      usageIdentity: 'invalid-currency-call',
      sessionId: 'session-1',
      messageId: 'invalid-currency-message',
      model: 'model-invalid-currency',
      provider: 'provider-a',
      usage,
      source: 'ai_usage_event',
    });
    expect(invalid.spanRepo.rows[0]).toMatchObject({ pricingStatus: 'unpriced', priceCurrency: null, cost: null });

    process.env.ORCHESTRATOR_MODEL_PRICING_JSON = JSON.stringify({
      'provider-a/model-eur': {
        inputPer1k: 1,
        outputPer1k: 1,
        currency: 'eur',
      },
    });
    const nonUsd = createTracker();
    await nonUsd.tracker.recordModelCallUsage({
      usageIdentity: 'non-usd-call',
      sessionId: 'session-1',
      messageId: 'non-usd-message',
      model: 'model-eur',
      provider: 'provider-a',
      usage,
      source: 'ai_usage_event',
      runId: 7,
    });
    expect(nonUsd.spanRepo.rows[0]).toMatchObject({ pricingStatus: 'non_usd', priceCurrency: 'EUR', cost: null });
    expect(nonUsd.runRepo.rows[0]).toMatchObject({ totalCost: null, pricingStatus: 'non_usd' });
  });
});
