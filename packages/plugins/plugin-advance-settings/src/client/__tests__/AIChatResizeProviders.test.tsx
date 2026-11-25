// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HelpVisibilityProvider } from '../HelpVisibilityProvider';
import { HelpVisibilityProviderV2 } from '../../client-v2/HelpVisibilityProvider';

const testState = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));

vi.mock('@nocobase/client', () => ({
  useSystemSettings: () => ({ data: { data: { options: testState.options } } }),
}));

vi.mock('@nocobase/client-v2', () => ({
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
    document.documentElement.style.removeProperty('--advance-settings-ai-chat-width');
  });

  it('keeps resizing off when the system option is missing and enables it after settings load', async () => {
    const view = render(
      <Component>
        <div>Application</div>
      </Component>,
    );

    expect(screen.queryByTestId('ai-chat-resize-handle')).toBeNull();

    testState.options = { enableAIChatResize: true };
    view.rerender(
      <Component>
        <div>Application</div>
      </Component>,
    );

    const handle = await screen.findByTestId('ai-chat-resize-handle');
    expect(handle.getAttribute('aria-label')).toBe('Resize AI chat');
  });
});
