// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InitializeTheme, { useThemeId } from '../../client/components/InitializeTheme';

const mockSetTheme = vi.fn();
const mockSetOption = vi.fn();
const mockGetOption = vi.fn(() => null);
const mockRun = vi.fn();

const mockThemes = [
  {
    id: 5,
    uid: 'business_pro',
    optional: true,
    default: false,
    config: { name: 'Business Pro', token: { colorPrimary: '#4F46E5' } },
  },
  {
    id: 10,
    uid: 'vpbank_light',
    optional: true,
    default: true,
    config: { name: 'VPBank Light', token: { colorPrimary: '#00B74F' } },
  },
];

let mockV2CurrentUser: { data?: { data?: unknown }; loading?: boolean } | null = null;
let mockFlowEngineUser: unknown = undefined;

vi.mock('@nocobase/client-v2', () => ({
  defaultTheme: { token: { colorSettings: '#F18B62', motionUnit: 0.03 } },
  useCurrentUserContext: () => mockV2CurrentUser,
  useGlobalTheme: () => ({ setTheme: mockSetTheme }),
  useApp: () => ({
    apiClient: {
      auth: {
        getOption: mockGetOption,
        setOption: mockSetOption,
      },
    },
    flowEngine: {
      context: {
        get user() {
          return mockFlowEngineUser;
        },
      },
    },
  }),
}));

vi.mock('@nocobase/flow-engine', () => ({
  useFlowEngine: () => ({
    context: {
      get user() {
        return mockFlowEngineUser;
      },
    },
  }),
}));

vi.mock('../../client/components/ThemeListProvider', () => ({
  useThemeListContext: () => ({
    run: mockRun,
    data: mockThemes,
    loading: false,
  }),
}));

const ThemeIdProbe = () => {
  const { currentThemeId, defaultThemeId } = useThemeId();
  return <div data-testid="probe">{`${currentThemeId ?? ''}:${defaultThemeId ?? ''}`}</div>;
};

describe('InitializeTheme user theme resolution across V1 and V2 runtimes', () => {
  beforeEach(() => {
    mockSetTheme.mockReset();
    mockSetOption.mockReset();
    mockGetOption.mockReset();
    mockRun.mockReset();
    mockV2CurrentUser = null;
    mockFlowEngineUser = undefined;
  });

  it('resolves user selected theme from flowEngine.context.user when V2 CurrentUserContext is null (Client V1)', async () => {
    mockV2CurrentUser = null;
    mockFlowEngineUser = {
      id: 1,
      systemSettings: {
        antdStyleThemeId: 5,
        themeId: 5,
      },
    };

    const { getByTestId } = render(
      <InitializeTheme>
        <ThemeIdProbe />
      </InitializeTheme>,
    );

    await waitFor(() => {
      expect(getByTestId('probe').textContent).toBe('5:10');
    });
    expect(mockSetTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Business Pro',
        token: expect.objectContaining({ colorPrimary: '#4F46E5' }),
      }),
    );
  });

  it('prefers V2 CurrentUserContext user when present and falls back to default theme when user has no preference', async () => {
    mockV2CurrentUser = {
      data: {
        data: {
          id: 1,
          systemSettings: {
            antdStyleThemeId: null,
          },
        },
      },
      loading: false,
    };
    mockFlowEngineUser = {
      id: 1,
      systemSettings: {
        antdStyleThemeId: 5,
      },
    };

    const { getByTestId } = render(
      <InitializeTheme>
        <ThemeIdProbe />
      </InitializeTheme>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(getByTestId('probe').textContent).toBe('10:10');
    expect(mockSetTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'VPBank Light',
        token: expect.objectContaining({ colorPrimary: '#00B74F' }),
      }),
    );
  });
});
