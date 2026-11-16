// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { getHarnessProfileRetentionDays } from '../services/TracingRetentionPolicy';

describe('getHarnessProfileRetentionDays', () => {
  it('prefers the canonical nested observability setting', () => {
    expect(
      getHarnessProfileRetentionDays({
        observability: { tracingRetentionDays: 14 },
        tracingRetentionDays: 90,
      }),
    ).toBe(14);
  });

  it('falls back to the legacy top-level setting when the canonical value is absent or invalid', () => {
    expect(getHarnessProfileRetentionDays({ tracingRetentionDays: 21 })).toBe(21);
    expect(
      getHarnessProfileRetentionDays({
        observability: { tracingRetentionDays: 0 },
        tracingRetentionDays: 21,
      }),
    ).toBe(21);
  });

  it('returns null when neither setting is a positive finite number', () => {
    expect(getHarnessProfileRetentionDays({ observability: { tracingRetentionDays: 'invalid' } })).toBeNull();
    expect(getHarnessProfileRetentionDays(null)).toBeNull();
  });
});
