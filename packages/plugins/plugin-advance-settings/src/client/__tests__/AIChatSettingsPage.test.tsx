// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HelpSettingsPage } from '../HelpSettingsPage';
import { AIChatSettingsPage } from '../../client-v2/AIChatSettingsPage';

const testState = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  mutate: vi.fn(),
  options: {} as Record<string, unknown>,
}));

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => ({ request: testState.apiRequest }),
  useSystemSettings: () => ({
    data: { data: { options: testState.options } },
    mutate: testState.mutate,
  }),
}));

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({
    i18n: { t: (key: string) => key },
    apiClient: { request: testState.apiRequest },
  }),
  useSystemSettings: () => ({
    data: { data: { options: testState.options } },
    mutate: testState.mutate,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('AI chat resize setting', () => {
  beforeEach(() => {
    testState.apiRequest.mockReset().mockResolvedValue({});
    testState.mutate.mockReset();
    testState.options = {};
  });

  afterEach(cleanup);

  it('defaults to disabled in the V1 settings page and saves without discarding other options', async () => {
    render(<HelpSettingsPage />);

    const resizeSwitch = screen.getByRole('switch', { name: 'Enable AI chat resizing' });
    expect(resizeSwitch.getAttribute('aria-checked')).toBe('false');

    testState.options = { showHelp: false, retainOtherSetting: 'value' };
    cleanup();
    render(<HelpSettingsPage />);
    fireEvent.click(screen.getByRole('switch', { name: 'Enable AI chat resizing' }));

    const savedOptions = {
      showHelp: false,
      retainOtherSetting: 'value',
      enableAIChatResize: true,
    };
    await waitFor(() => {
      expect(testState.apiRequest).toHaveBeenCalledWith({
        url: 'systemSettings:put',
        method: 'post',
        data: { options: savedOptions },
      });
    });
    expect(testState.mutate).toHaveBeenCalledWith({ data: { options: savedOptions } });
  });

  it('defaults to disabled in the V2 settings page and saves the shared system option', async () => {
    render(<AIChatSettingsPage />);

    expect(screen.getByRole('switch', { name: 'Enable AI chat resizing' }).getAttribute('aria-checked')).toBe('false');

    testState.options = { showHelp: true, retainOtherSetting: 42 };
    cleanup();
    render(<AIChatSettingsPage />);
    fireEvent.click(screen.getByRole('switch', { name: 'Enable AI chat resizing' }));

    const savedOptions = {
      showHelp: true,
      retainOtherSetting: 42,
      enableAIChatResize: true,
    };
    await waitFor(() => {
      expect(testState.apiRequest).toHaveBeenCalledWith({
        url: 'systemSettings:put',
        method: 'post',
        data: { options: savedOptions },
      });
    });
    expect(testState.mutate).toHaveBeenCalledWith({ data: { options: savedOptions } });
  });
});
