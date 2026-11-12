// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

type MockSettingsManager = {
  addMenuItem: (...args: unknown[]) => void;
  addPageTabItem: (...args: unknown[]) => void;
};

type MockApplication = {
  pluginSettingsManager: MockSettingsManager;
  use: (...args: unknown[]) => void;
};

vi.mock('@nocobase/client-v2', () => ({
  Plugin: class {
    app: MockApplication;
    options: { name?: string };
    pluginSettingsManager: MockSettingsManager;

    constructor(options: { name?: string }, app: MockApplication) {
      this.app = app;
      this.options = options;
      this.pluginSettingsManager = app.pluginSettingsManager;
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
  HelpVisibilityProviderV2: function HelpVisibilityProviderV2() {},
}));
vi.mock('../HelpSettingsPage', () => ({ HelpSettingsPage: function HelpSettingsPage() {} }));

import type { Application } from '@nocobase/client-v2';
import { SettingsSearchInjector } from '../../shared/SettingsSearchInjector';
import { PluginAdvanceSettingsClient } from '../plugin';

describe('Advance Settings V2 search registration', () => {
  it('registers the shared Settings search provider in the V2 application', async () => {
    const app = {
      use: vi.fn(),
      pluginSettingsManager: {
        addMenuItem: vi.fn(),
        addPageTabItem: vi.fn(),
      },
    } as unknown as Application;

    await new PluginAdvanceSettingsClient({}, app).load();

    expect(app.use).toHaveBeenCalledWith(SettingsSearchInjector);
  });
});
