/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import { describe, expect, it, vi } from 'vitest';
import Plugin from '../plugin';

describe('Advance Settings V2 configuration authorization', () => {
  it('grants the actions used by the native settings form under the plugin instance snippet', async () => {
    const registerSnippet = vi.fn();
    await new Plugin({ acl: { registerSnippet } } as unknown as Application, {
      name: 'plugin-advance-settings',
    }).load();
    expect(registerSnippet).toHaveBeenCalledWith({
      name: 'pm.plugin-advance-settings',
      actions: ['systemSettings:get', 'systemSettings:put'],
    });
  });
});
