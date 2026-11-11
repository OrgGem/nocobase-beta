/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
