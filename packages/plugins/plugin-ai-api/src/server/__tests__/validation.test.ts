import type { Model } from '@nocobase/database';
import { describe, expect, it, vi } from 'vitest';

vi.mock('dayjs', () => ({
  default: () => ({ tz: vi.fn() }),
}));

import { validateQuotaPolicy } from '../validation';

function quotaPolicy(values: Record<string, unknown>): Model {
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
    expect(() => validateQuotaPolicy(quotaPolicy(requiredPolicy))).not.toThrow();
  });

  it.each(['reject', 'truncate'] as const)('accepts %s context overflow behavior', (contextOverflowBehavior) => {
    expect(() => validateQuotaPolicy(quotaPolicy({ ...requiredPolicy, contextOverflowBehavior }))).not.toThrow();
  });

  it('rejects an unsupported context overflow behavior', () => {
    expect(() => validateQuotaPolicy(quotaPolicy({ ...requiredPolicy, contextOverflowBehavior: 'compact' }))).toThrow(
      'contextOverflowBehavior must be reject or truncate.',
    );
  });

  it.each(['share', 'per_user'] as const)('accepts %s quota mode', (quotaMode) => {
    expect(() => validateQuotaPolicy(quotaPolicy({ ...requiredPolicy, quotaMode }))).not.toThrow();
  });

  it('rejects an unsupported quota mode', () => {
    expect(() => validateQuotaPolicy(quotaPolicy({ ...requiredPolicy, quotaMode: 'global' }))).toThrow(
      'quotaMode must be share or per_user.',
    );
  });
});
