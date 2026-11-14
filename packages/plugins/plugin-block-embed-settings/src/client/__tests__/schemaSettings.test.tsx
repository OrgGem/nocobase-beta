// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import MockAdapter from 'axios-mock-adapter';
import { ACLContext, Application, useSchemaSettingsRender } from '@nocobase/client';
import { act, render, screen, userEvent, waitFor, within } from '@nocobase/test/client';
import { describe, expect, it } from 'vitest';
import { embedSettingsBlockSettings } from '../schemaSettings';

describe('Embed settings block configuration', () => {
  it('shows enabled, permitted plugins in the v1 settings dialog', async () => {
    function BlockSettings() {
      const settings = useSchemaSettingsRender(embedSettingsBlockSettings, { mode: 'inline' });
      return settings.render();
    }

    const app = new Application({
      providers: [[ACLContext.Provider, { value: { data: { data: { role: 'editor' } } } }], BlockSettings],
      pluginSettings: {
        allowed: { title: 'Allowed plugin', Component: () => null },
        denied: { title: 'Denied plugin', Component: () => null },
        disabled: { title: 'Disabled plugin', Component: () => null },
      },
    });
    app.pluginSettingsManager.setAclSnippets(['!pm.denied']);
    const api = new MockAdapter(app.apiClient.axios);
    api.onGet('embedSettings:enabled').reply(200, {
      data: [
        { pluginName: 'allowed', title: 'Allowed plugin' },
        { pluginName: 'denied', title: 'Denied plugin' },
      ],
    });

    const user = userEvent.setup();
    try {
      const Root = app.getRootComponent();
      render(<Root />);
      const item = await screen.findByRole('menuitem', { name: 'Select plugin' });
      await act(() => user.click(item));
      const dialog = await screen.findByRole('dialog');
      const selector = within(dialog).getByRole('combobox');
      await waitFor(() => expect(selector).toBeEnabled());
      await act(() => user.click(selector));
      expect(await screen.findByText('Allowed plugin')).toBeInTheDocument();
      expect(screen.queryByText('Denied plugin')).not.toBeInTheDocument();
      expect(screen.queryByText('Disabled plugin')).not.toBeInTheDocument();
    } finally {
      const cancel = screen.queryByRole('button', { name: 'Cancel' });
      if (cancel) await act(() => user.click(cancel));
      api.restore();
    }
  });
});
