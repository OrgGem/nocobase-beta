// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HelpSettingsPage } from '../HelpSettingsPage';
import { HelpSettingsPage as HelpSettingsPageV2 } from '../../client-v2/HelpSettingsPage';
import { AIChatSettingsPage } from '../../client-v2/AIChatSettingsPage';
import { SettingsSearchSettingsPage } from '../../client-v2/SettingsSearchSettingsPage';

type SystemSettingsEnvelope = {
  data?: {
    id?: number;
    title?: string;
    options?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

const testState = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let envelope: SystemSettingsEnvelope | undefined = { data: { id: 1, title: 'NocoBase', options: {} } };

  const setEnvelope = (next: SystemSettingsEnvelope | undefined) => {
    envelope = next;
    listeners.forEach((listener) => listener());
  };

  return {
    apiRequest: vi.fn(),
    mutate: vi.fn((next?: { data?: SystemSettingsEnvelope }) => {
      if (next && Object.prototype.hasOwnProperty.call(next, 'data')) {
        setEnvelope(next.data);
      }
    }),
    getEnvelope: () => envelope,
    setEnvelope,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

function useMockSystemSettings() {
  const [, forceUpdate] = useState(0);
  useEffect(() => testState.subscribe(() => forceUpdate((v) => v + 1)), []);
  return {
    data: testState.getEnvelope(),
    mutate: testState.mutate,
  };
}

function MockIconPicker({
  value,
  disabled,
  onChange,
}: {
  value?: string;
  disabled?: boolean;
  onChange?: (next?: string | null) => void;
}) {
  return (
    <div data-testid="mock-icon-picker" data-value={value || ''} data-disabled={String(Boolean(disabled))}>
      <button type="button" disabled={disabled} onClick={() => onChange?.('FilterOutlined')}>
        Select FilterOutlined
      </button>
      <button type="button" disabled={disabled} onClick={() => onChange?.(null)}>
        Clear search icon
      </button>
    </div>
  );
}

vi.mock('@nocobase/client', () => ({
  IconPicker: MockIconPicker,
  useAPIClient: () => ({ request: testState.apiRequest }),
  useSystemSettings: () => useMockSystemSettings(),
}));

vi.mock('@nocobase/client-v2', () => ({
  IconPicker: MockIconPicker,
  useApp: () => ({
    i18n: { t: (key: string) => key },
    apiClient: { request: testState.apiRequest },
  }),
  useSystemSettings: () => useMockSystemSettings(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('Advance Settings pages (stateful systemSettings.mutate)', () => {
  beforeEach(() => {
    testState.apiRequest.mockReset().mockResolvedValue({});
    testState.mutate.mockClear();
    testState.setEnvelope({ data: { id: 1, title: 'NocoBase', options: {} } });
  });

  afterEach(cleanup);

  it('defaults AI chat resizing to disabled in V1 and keeps controls interactive after saving', async () => {
    testState.setEnvelope({
      data: { id: 1, title: 'NocoBase', options: { showHelp: false, retainOtherSetting: 'value' } },
    });
    render(<HelpSettingsPage />);

    const resizeSwitch = screen.getByRole('switch', { name: 'Enable AI chat resizing' }) as HTMLButtonElement;
    expect(resizeSwitch.getAttribute('aria-checked')).toBe('false');
    expect(resizeSwitch.disabled).toBe(false);

    fireEvent.click(resizeSwitch);

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
    expect(testState.mutate).toHaveBeenCalledWith({
      data: { data: { id: 1, title: 'NocoBase', options: savedOptions } },
    });
    await waitFor(() => {
      expect(resizeSwitch.getAttribute('aria-checked')).toBe('true');
      expect(resizeSwitch.disabled).toBe(false);
    });
  });

  it('saves V2 Help and AI Chat tabs with a two-level envelope and respects server response data', async () => {
    testState.setEnvelope({ data: { id: 1, options: { showHelp: true, retainOtherSetting: 42 } } });
    render(
      <>
        <HelpSettingsPageV2 />
        <AIChatSettingsPage />
      </>,
    );

    const aiSwitch = screen.getByRole('switch', { name: 'Enable AI chat resizing' }) as HTMLButtonElement;
    const helpSwitch = screen.getByRole('switch', { name: 'Show help button in header' }) as HTMLButtonElement;
    expect(aiSwitch.getAttribute('aria-checked')).toBe('false');
    expect(helpSwitch.getAttribute('aria-checked')).toBe('true');

    testState.apiRequest.mockResolvedValueOnce({
      data: { data: { id: 1, options: { showHelp: true, retainOtherSetting: 42, enableAIChatResize: true } } },
    });
    fireEvent.click(aiSwitch);

    await waitFor(() => {
      expect(aiSwitch.getAttribute('aria-checked')).toBe('true');
      expect(aiSwitch.disabled).toBe(false);
    });

    fireEvent.click(helpSwitch);
    await waitFor(() => {
      expect(helpSwitch.getAttribute('aria-checked')).toBe('false');
      expect(helpSwitch.disabled).toBe(false);
    });
  });

  it('updates settings search toggle and icon selection live without remounting in V1 and V2', async () => {
    testState.setEnvelope({ data: { id: 1, options: { showHelp: true, retainOtherSetting: 'keep' } } });
    render(<SettingsSearchSettingsPage />);

    const searchSwitch = screen.getByRole('switch', { name: 'Enable settings search' }) as HTMLButtonElement;
    const picker = screen.getByTestId('mock-icon-picker');
    expect(searchSwitch.getAttribute('aria-checked')).toBe('true');
    expect(picker.getAttribute('data-value')).toBe('SearchOutlined');
    expect(picker.getAttribute('data-disabled')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Select FilterOutlined' }));
    await waitFor(() => {
      expect(picker.getAttribute('data-value')).toBe('FilterOutlined');
      expect(picker.getAttribute('data-disabled')).toBe('false');
    });
    expect(testState.apiRequest).toHaveBeenLastCalledWith({
      url: 'systemSettings:put',
      method: 'post',
      data: {
        options: {
          showHelp: true,
          retainOtherSetting: 'keep',
          settingsSearchIcon: 'FilterOutlined',
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear search icon' }));
    await waitFor(() => {
      expect(picker.getAttribute('data-value')).toBe('');
      expect(picker.getAttribute('data-disabled')).toBe('false');
    });

    fireEvent.click(searchSwitch);
    await waitFor(() => {
      expect(searchSwitch.getAttribute('aria-checked')).toBe('false');
      expect(searchSwitch.disabled).toBe(false);
    });
    expect(testState.apiRequest).toHaveBeenLastCalledWith({
      url: 'systemSettings:put',
      method: 'post',
      data: {
        options: {
          showHelp: true,
          retainOtherSetting: 'keep',
          settingsSearchIcon: '',
          enableSettingsSearch: false,
        },
      },
    });
  });
});
