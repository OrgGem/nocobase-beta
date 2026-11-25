// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { HelpVisibilityProvider } from '../HelpVisibilityProvider';
import { HelpVisibilityProviderV2 } from '../../client-v2/HelpVisibilityProvider';
import { SettingsSearchInjector } from '../../shared/SettingsSearchInjector';

const testState = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));

vi.mock('@nocobase/client', () => ({
  hasIcon: (type?: string) => Boolean(type && type !== 'unknown-icon'),
  Icon: ({ type }: { type: string }) => <span data-testid={`nb-icon-${type}`} />,
  useSystemSettings: () => ({ data: { data: { options: testState.options } } }),
}));

vi.mock('@nocobase/client-v2', () => ({
  hasIcon: (type?: string) => Boolean(type && type !== 'unknown-icon'),
  Icon: ({ type }: { type: string }) => <span data-testid={`nb-icon-${type}`} />,
  useSystemSettings: () => ({ data: { data: { options: testState.options } } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const providers: Array<{
  name: string;
  Component: React.ComponentType<React.PropsWithChildren>;
}> = [
  { name: 'V1', Component: HelpVisibilityProvider },
  { name: 'V2', Component: HelpVisibilityProviderV2 },
];

describe.each(providers)('$name AI chat resize provider', ({ Component }) => {
  beforeEach(() => {
    testState.options = {};
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });

    const dialog = document.createElement('div');
    const chatRef = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.dataset.providerTestFixture = '';
    dialog.style.position = 'fixed';
    dialog.style.height = '100vh';
    dialog.style.width = '450px';
    dialog.style.right = '-450px';
    dialog.append(chatRef);
    document.body.append(dialog);

    const sider = document.createElement('aside');
    sider.className = 'ant-layout-sider ant-pro-sider';
    sider.dataset.providerTestFixture = '';
    sider.style.width = '200px';
    document.body.append(sider);

    Object.defineProperty(globalThis, '__nocobasePluginAIStores', {
      configurable: true,
      value: {
        '@nocobase/plugin-ai/chat-box-runtime': {
          chatBoxModel: { chatBoxRef: { current: chatRef } },
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll('[data-provider-test-fixture]').forEach((fixture) => fixture.remove());
    delete (globalThis as typeof globalThis & { __nocobasePluginAIStores?: unknown }).__nocobasePluginAIStores;
    document.documentElement.removeAttribute('data-advance-ai-chat-resize');
    document.documentElement.removeAttribute('data-advance-left-nav-resize');
    document.documentElement.style.removeProperty('--advance-settings-ai-chat-width');
    document.documentElement.style.removeProperty('--advance-settings-left-nav-width');
  });

  it('keeps resizing off when the system option is missing and enables it after settings load', async () => {
    const view = render(
      <Component>
        <div>Application</div>
      </Component>,
    );

    expect(screen.queryByTestId('ai-chat-resize-handle')).toBeNull();
    expect(screen.queryByTestId('left-nav-resize-handle')).toBeNull();

    testState.options = { enableAIChatResize: true, enableLeftNavResize: true };
    view.rerender(
      <Component>
        <div>Application</div>
      </Component>,
    );

    const handle = await screen.findByTestId('ai-chat-resize-handle');
    expect(handle.getAttribute('aria-label')).toBe('Resize AI chat');
    const leftNavHandle = await screen.findByTestId('left-nav-resize-handle');
    expect(leftNavHandle.getAttribute('aria-label')).toBe('Resize left navigator');
  });

  it('provides settings search visibility and selected icon to SettingsSearchInjector', async () => {
    const renderSettings = () => (
      <MemoryRouter initialEntries={['/admin/settings/general']}>
        <Component>
          <SettingsSearchInjector>
            <div className="ant-layout ant-layout-has-sider">
              <aside className="ant-layout-sider">
                <div className="ant-layout-sider-children">
                  <ul className="ant-menu">
                    <li className="ant-menu-item">General</li>
                  </ul>
                </div>
              </aside>
              <main className="ant-layout-content">
                <div className="ant-page-header">Settings</div>
              </main>
            </div>
          </SettingsSearchInjector>
        </Component>
      </MemoryRouter>
    );

    const view = render(renderSettings());
    expect(await screen.findByRole('searchbox', { name: 'Settings Search' })).toBeTruthy();
    expect(await screen.findByTestId('nb-icon-SearchOutlined')).toBeTruthy();

    testState.options = { settingsSearchIcon: 'FilterOutlined' };
    view.rerender(renderSettings());
    expect(await screen.findByTestId('nb-icon-FilterOutlined')).toBeTruthy();

    testState.options = { enableSettingsSearch: false };
    view.rerender(renderSettings());
    await waitFor(() => expect(document.getElementById('settings-sidebar-search')).toBeNull());
  });
});
