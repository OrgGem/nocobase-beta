/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { FlowEngine } from '@nocobase/flow-engine';
import { describe, expect, it, vi } from 'vitest';
import { registerVaultProperty } from '../registerVaultProperty';

describe('Vault native V2 context lifecycle', () => {
  it('does not keep resolved client-exposed values cached across permission/configuration changes', async () => {
    const engine = new FlowEngine();
    const api = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ data: { data: { values: { visible: 'old-value' } } } })
        .mockResolvedValueOnce({ data: { data: { values: {} } } }),
    };
    registerVaultProperty(engine.context, api, (key) => key);
    expect(await engine.context.$vault).toEqual({ visible: 'old-value' });
    expect(await engine.context.$vault).toEqual({});
    expect(api.request).toHaveBeenCalledTimes(2);
  });
});
