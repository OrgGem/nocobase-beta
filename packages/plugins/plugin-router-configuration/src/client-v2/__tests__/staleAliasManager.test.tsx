/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { App } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouterConfigManagerView } from '../RouterConfigManager';

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

afterEach(() => {
  cleanup();
});

const route = {
  id: 'route-42',
  title: 'Legacy page',
  type: 'page',
  schemaUid: 'legacy-page',
  options: { pathAlias: 'forged-route-alias', otherOption: true },
};

const createApi = (aliases: Array<{ desktopRouteId: string; pathAlias: string }>) => {
  const request = vi.fn(async (config: { url: string }) => {
    switch (config.url) {
      case '/desktopRoutes:list':
        return { data: { data: [route] } };
      case '/desktopRoutes:listPathAliases':
        return { data: { data: aliases } };
      case '/uiLayouts:listAccessible':
        return { data: { data: [] } };
      case '/desktopRoutes:listAccessible':
        return { data: { data: [] } };
      default:
        return { data: { data: [] } };
    }
  });
  const api = { request } as unknown as React.ComponentProps<typeof RouterConfigManagerView>['api'];
  return { api, request };
};

const renderManager = (api: React.ComponentProps<typeof RouterConfigManagerView>['api']) =>
  render(
    <App>
      <RouterConfigManagerView api={api} enablePathAliases />
    </App>,
  );

describe('Router Configuration stale aliases', () => {
  it('shows the stored alias for an ineligible route and permits removal only', async () => {
    const { api, request } = createApi([{ desktopRouteId: route.id, pathAlias: 'sales-dashboard' }]);
    renderManager(api);

    expect(await screen.findByText('sales-dashboard')).toBeTruthy();
    expect(screen.queryByText('forged-route-alias')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Edit URL Alias/ }));

    const aliasInput = await screen.findByDisplayValue('sales-dashboard');
    const saveButton = screen.getByRole('button', { name: 'OK' });
    expect(
      screen.getByText('This route is not eligible for a URL alias. Clear the field to remove the existing alias.'),
    ).toBeTruthy();
    expect(saveButton.hasAttribute('disabled')).toBe(true);

    request.mockClear();
    fireEvent.change(aliasInput, { target: { value: 'replacement-alias' } });
    await waitFor(() => expect(saveButton.hasAttribute('disabled')).toBe(true));
    fireEvent.click(saveButton);
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ url: '/desktopRoutes:setPathAlias' }));

    fireEvent.change(aliasInput, { target: { value: '' } });
    await waitFor(() => expect(saveButton.hasAttribute('disabled')).toBe(false));
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        method: 'POST',
        url: '/desktopRoutes:setPathAlias',
        data: { values: { id: route.id, pathAlias: null } },
      }),
    );
  });

  it('ignores a persisted route option when no alias table row exists', async () => {
    const { api } = createApi([]);
    renderManager(api);

    expect(await screen.findByText('Legacy page')).toBeTruthy();
    expect(screen.queryByText('forged-route-alias')).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit URL Alias/ })).toBeNull();
  });
});
