// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

type MockApplication = { use: (...args: unknown[]) => void };

vi.mock('@nocobase/client', () => ({
  Plugin: class {
    app: MockApplication;
    options: unknown;

    constructor(options: unknown, app: MockApplication) {
      this.app = app;
      this.options = options;
    }

    t(key: string) {
      return key;
    }
  },
}));
vi.mock('../../shared/SettingsSearchInjector', () => ({
  SettingsSearchInjector: function SettingsSearchInjector() {},
}));
vi.mock('../HelpVisibilityProvider', () => ({
  HelpVisibilityProvider: function HelpVisibilityProvider() {},
}));
vi.mock('../HelpSettingsPage', () => ({ HelpSettingsPage: function HelpSettingsPage() {} }));

import type { Application } from '@nocobase/client';
import { SettingsSearchInjector } from '../../shared/SettingsSearchInjector';
import { PluginAdvanceSettingsClient } from '../plugin';

describe('Advance Settings V1 search registration', () => {
  it('registers the shared Settings search provider in the V1 application', async () => {
    const app = {
      use: vi.fn(),
      pluginSettingsManager: {
        add: vi.fn(),
      },
    } as unknown as Application;

    await new PluginAdvanceSettingsClient({}, app).load();

    expect(app.use).toHaveBeenCalledWith(SettingsSearchInjector);
  });
});
