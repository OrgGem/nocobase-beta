import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@nocobase/actions';
import { Op } from 'sequelize';
import aiApiUsageMonitorResource from '../resource/ai-api-usage-monitor';

describe('AI API usage monitor summary', () => {
  it('aggregates filtered token and cost totals', async () => {
    const findOne = vi.fn().mockResolvedValue({
      requestCount: '3',
      inputTokens: '100',
      outputTokens: '25',
      totalTokens: '125',
    });
    const findAll = vi.fn().mockResolvedValue([
      { currency: 'USD', totalCost: '0.12500000' },
      { currency: 'EUR', totalCost: '0.05000000' },
    ]);
    const context = {
      action: {
        params: {
          start: '2026-08-01T00:00:00.000Z',
          end: '2026-08-01T23:59:59.999Z',
          userId: 7,
          resolvedService: 'custom-llm',
          resolvedModel: 'model-a',
          status: 'succeeded',
        },
      },
      db: {
        getCollection: () => ({ model: { findOne, findAll } }),
      },
      body: undefined,
    } as unknown as Context;
    const next = vi.fn();
    const summary = aiApiUsageMonitorResource.actions?.summary;
    if (typeof summary !== 'function') throw new Error('summary action is not registered');

    await summary(context, next);

    const totalsQuery = findOne.mock.calls[0][0];
    expect(totalsQuery.where).toEqual(
      expect.objectContaining({
        userId: 7,
        resolvedService: 'custom-llm',
        resolvedModel: 'model-a',
        status: 'succeeded',
      }),
    );
    expect(totalsQuery.where.startedAt[Op.gte]).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(totalsQuery.where.startedAt[Op.lte]).toEqual(new Date('2026-08-01T23:59:59.999Z'));
    expect(context.body).toEqual({
      requestCount: 3,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      costsByCurrency: [
        { currency: 'USD', totalCost: '0.12500000' },
        { currency: 'EUR', totalCost: '0.05000000' },
      ],
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
