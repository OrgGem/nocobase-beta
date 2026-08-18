import type { Context } from '@nocobase/actions';
import { createMockDatabase, type Database } from '@nocobase/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiApiQuotaError, finalizeLlmBilling, markLlmProviderAttempted, prepareLlmBilling } from '../billing';

describe('AI API group quota reservation', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createMockDatabase();
    db.collection({
      name: 'aiApiConfig',
      fields: [
        { name: 'quotaEnabled', type: 'boolean' },
        { name: 'defaultReservationOutputTokens', type: 'integer' },
      ],
    });
    db.collection({
      name: 'aiApiModelPrices',
      fields: [
        { name: 'llmService', type: 'string' },
        { name: 'model', type: 'string' },
        { name: 'enabled', type: 'boolean' },
        { name: 'currency', type: 'string' },
        { name: 'inputPricePerMillionTokens', type: 'decimal', precision: 20, scale: 10 },
        { name: 'outputPricePerMillionTokens', type: 'decimal', precision: 20, scale: 10 },
        { name: 'fixedCostPerRequest', type: 'decimal', precision: 20, scale: 10 },
        { name: 'effectiveFrom', type: 'datetimeTz' },
        { name: 'effectiveTo', type: 'datetimeTz' },
      ],
    });
    db.collection({
      name: 'aiApiUsageGroups',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'isDefault', type: 'boolean' },
        { name: 'quotaMode', type: 'string' },
        { name: 'rateLimitPerMinute', type: 'integer' },
        { name: 'enabled', type: 'boolean' },
        { name: 'periodType', type: 'string' },
        { name: 'timezone', type: 'string' },
        { name: 'requestLimit', type: 'bigInt' },
        { name: 'totalTokenLimit', type: 'bigInt' },
        { name: 'costLimit', type: 'decimal', precision: 20, scale: 8 },
        { name: 'currency', type: 'string' },
        { name: 'rejectUnpricedModel', type: 'boolean' },
        { name: 'missingUsageBehavior', type: 'string' },
        { name: 'contextOverflowBehavior', type: 'string' },
      ],
    });
    db.collection({
      name: 'aiApiGroupMembers',
      fields: [
        { name: 'groupId', type: 'bigInt' },
        { name: 'userId', type: 'bigInt' },
      ],
      indexes: [{ fields: ['userId'], unique: true }],
    });
    db.collection({
      name: 'aiApiGroupQuotaBuckets',
      fields: [
        { name: 'groupId', type: 'bigInt' },
        { name: 'userId', type: 'bigInt' },
        { name: 'periodStart', type: 'datetimeTz' },
        { name: 'periodEnd', type: 'datetimeTz' },
        { name: 'requestCount', type: 'bigInt' },
        { name: 'totalTokens', type: 'bigInt' },
        { name: 'cost', type: 'decimal', precision: 20, scale: 8 },
        { name: 'reservedRequests', type: 'bigInt' },
        { name: 'reservedTokens', type: 'bigInt' },
        { name: 'reservedCost', type: 'decimal', precision: 20, scale: 8 },
      ],
      indexes: [{ fields: ['groupId', 'userId', 'periodStart'], unique: true }],
    });
    await db.sync({ force: true });
    await db.getRepository('aiApiConfig').create({
      values: { quotaEnabled: true, defaultReservationOutputTokens: 100 },
    });
    await db.getRepository('aiApiModelPrices').create({
      values: {
        llmService: 'service-a',
        model: 'model-a',
        enabled: true,
        currency: 'USD',
        inputPricePerMillionTokens: '5',
        outputPricePerMillionTokens: '15',
        fixedCostPerRequest: '0',
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      },
    });
    const group = await db.getRepository('aiApiUsageGroups').create({
      values: {
        name: 'Default',
        isDefault: true,
        quotaMode: 'per_user',
        rateLimitPerMinute: 60,
        enabled: true,
        periodType: 'monthly',
        timezone: 'UTC',
        requestLimit: 1,
        totalTokenLimit: 1000,
        costLimit: '10',
        currency: 'USD',
        rejectUnpricedModel: true,
        missingUsageBehavior: 'use_reserved',
        contextOverflowBehavior: 'reject',
      },
    });
    await db.getRepository('aiApiGroupMembers').create({
      values: { groupId: group.get('id'), userId: 7 },
    });
  });

  afterEach(async () => {
    await db.close();
  });

  function context(): Context {
    return {
      db,
      request: { body: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 } },
      state: { currentUser: { id: 7 } },
    } as unknown as Context;
  }

  const resolved = {
    service: { name: 'service-a', provider: 'custom-llm' },
    modelId: 'model-a',
  };

  it('reserves atomically and reconciles actual provider usage', async () => {
    const first = context();
    await prepareLlmBilling(first, resolved);

    const competing = context();
    await expect(prepareLlmBilling(competing, resolved)).rejects.toMatchObject<Partial<AiApiQuotaError>>({
      code: 'request_quota_exceeded',
    });

    markLlmProviderAttempted(first);
    const finalized = await finalizeLlmBilling(
      first,
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      true,
    );
    expect(finalized).toMatchObject({ estimatedCost: '0.00012500', costStatus: 'calculated' });

    const bucket = await db.getRepository('aiApiGroupQuotaBuckets').findOne();
    expect(String(bucket?.get('requestCount'))).toBe('1');
    expect(String(bucket?.get('totalTokens'))).toBe('15');
    expect(String(bucket?.get('reservedRequests'))).toBe('0');
  });
});
