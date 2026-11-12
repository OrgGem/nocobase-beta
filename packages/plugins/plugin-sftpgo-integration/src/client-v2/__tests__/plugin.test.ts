// SPDX-License-Identifier: Apache-2.0

import * as ClientV2 from '@nocobase/client-v2';
import { describe, expect, it } from 'vitest';
import PluginSftpgoIntegrationClient from '../plugin';

describe('SFTPGo settings registration', () => {
  it('registers connections, users, folders, and API keys as immediately visible tabs', async () => {
    const app = ClientV2.createMockClient();
    await new PluginSftpgoIntegrationClient({}, app).load();

    const menu = app.pluginSettingsManager.get('sftpgo-integration', false);
    const tabs = menu?.children ?? [];

    expect(menu?.title).toBe('SFTPGo');
    expect(new Set(tabs.map((tab) => tab.key))).toEqual(
      new Set([
        'sftpgo-integration.connections',
        'sftpgo-integration.users',
        'sftpgo-integration.folders',
        'sftpgo-integration.apikeys',
      ]),
    );
    expect(tabs.every((tab) => !tab.hidden)).toBe(true);
    expect(tabs.every((tab) => typeof tab.componentLoader === 'function')).toBe(true);
  });
});
