/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import Page from '../shared/OidcClientsPage';

afterEach(cleanup);
const t = (key: string) => key;
describe('OIDC client manager with native record IDs', () => {
  it('renders a string-ID client and preserves its exact ID on update', async () => {
    const app = createMockClient();
    const client = {
      id: '90071992547409933',
      name: 'Desktop client',
      clientId: 'desktop',
      clientType: 'public',
      redirectUris: ['http://127.0.0.1/callback'],
      postLogoutRedirectUris: [],
      scopes: ['openid'],
      allowDynamicLoopbackPort: true,
      enabled: true,
    };
    app.apiMock.onGet('oidcClientManager:list').reply(200, { data: [client] });
    app.apiMock.onGet('oidcClientManager:providerInfo').reply(200, { data: {} });
    app.apiMock.onPost('oidcClientManager:update/90071992547409933').reply(200, { data: client });
    render(<Page api={app.apiClient} t={t} />);
    expect(await screen.findByText('Desktop client')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(app.apiMock.history.post).toHaveLength(1));
    expect(app.apiMock.history.post[0].url).toBe('oidcClientManager:update/90071992547409933');
  });
});
