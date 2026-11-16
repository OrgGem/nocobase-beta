// SPDX-License-Identifier: Apache-2.0

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
