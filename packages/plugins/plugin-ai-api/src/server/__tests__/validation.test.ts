import type { Model } from '@nocobase/database';
import { describe, expect, it, vi } from 'vitest';

vi.mock('dayjs', () => ({
  default: () => ({ tz: vi.fn() }),
}));

import { validateModelMetadata, validateQuotaPolicy, validateVirtualModel } from '../validation';

function record(values: Record<string, unknown>): Model {
  return {
    get: (key: string) => values[key],
  } as Model;
}

const requiredPolicy = {
  periodType: 'monthly',
  missingUsageBehavior: 'use_reserved',
  quotaMode: 'per_user',
  timezone: 'UTC',
};

describe('AI API quota policy validation', () => {
  it('uses reject when context overflow behavior is absent', () => {
    expect(() => validateQuotaPolicy(record(requiredPolicy))).not.toThrow();
  });

  it.each(['reject', 'truncate'] as const)('accepts %s context overflow behavior', (contextOverflowBehavior) => {
    expect(() => validateQuotaPolicy(record({ ...requiredPolicy, contextOverflowBehavior }))).not.toThrow();
  });

  it('rejects an unsupported context overflow behavior', () => {
    expect(() => validateQuotaPolicy(record({ ...requiredPolicy, contextOverflowBehavior: 'compact' }))).toThrow(
      'contextOverflowBehavior must be reject or truncate.',
    );
  });

  it.each(['share', 'per_user'] as const)('accepts %s quota mode', (quotaMode) => {
    expect(() => validateQuotaPolicy(record({ ...requiredPolicy, quotaMode }))).not.toThrow();
  });

  it('rejects an unsupported quota mode', () => {
    expect(() => validateQuotaPolicy(record({ ...requiredPolicy, quotaMode: 'global' }))).toThrow(
      'quotaMode must be share or per_user.',
    );
  });
});

describe('AI API model metadata validation', () => {
  const validMetadata = {
    llmService: 'openai',
    model: 'gpt-5',
    supportsVision: true,
    supportsToolCalling: true,
    reasoningTier: 'general',
    sortOrder: 0,
    enabled: true,
  };

  it('accepts routing metadata fields', () => {
    expect(() => validateModelMetadata(record(validMetadata))).not.toThrow();
  });

  it('accepts omitted fields that receive collection defaults', () => {
    expect(() => validateModelMetadata(record({ llmService: 'openai', model: 'gpt-5' }))).not.toThrow();
  });

  it.each([
    [{ ...validMetadata, reasoningTier: 'fast' }, 'reasoningTier must be cheap, general, or reasoning.'],
    [{ ...validMetadata, sortOrder: 1.5 }, 'sortOrder must be an integer.'],
    [{ ...validMetadata, supportsVision: 'yes' }, 'supportsVision must be a boolean.'],
  ])('rejects invalid routing metadata', (values, message) => {
    expect(() => validateModelMetadata(record(values))).toThrow(message);
  });
});

describe('AI API virtual model validation', () => {
  const validVirtualModel = {
    name: 'auto',
    mode: 'chat',
    fallbackModel: 'openai/gpt-5',
    visionModels: [],
    toolModels: ['openai/gpt-5'],
    reasoningModels: [],
    cheapModels: [],
    generalModels: [],
    enabled: true,
  };

  it('accepts a complete virtual model', () => {
    expect(() => validateVirtualModel(record(validVirtualModel))).not.toThrow();
  });

  it('accepts omitted fields that receive collection defaults', () => {
    expect(() => validateVirtualModel(record({ name: 'auto', fallbackModel: 'openai/gpt-5' }))).not.toThrow();
  });

  it.each([
    [{ ...validVirtualModel, mode: 'audio' }, 'mode must be chat or embedding.'],
    [{ ...validVirtualModel, fallbackModel: 'gpt-5' }, 'fallbackModel must use the service/modelId format.'],
    [{ ...validVirtualModel, toolModels: 'openai/gpt-5' }, 'toolModels must be an array.'],
    [{ ...validVirtualModel, visionModels: ['invalid'] }, 'visionModels[0] must use the service/modelId format.'],
  ])('rejects an invalid virtual model', (values, message) => {
    expect(() => validateVirtualModel(record(values))).toThrow(message);
  });
});
