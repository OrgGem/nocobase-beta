/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import { AuthenticatorsContext, type Authenticator } from '@nocobase/plugin-auth/client-v2';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OIDCButton from '../OIDCButton';

afterEach(cleanup);
describe('OIDC V2 manual sign-in', () => {
  it('sends the authenticator header and reports an authorization URL request failure without an unhandled rejection', async () => {
    const app = createMockClient();
    const error = vi.fn();
    app.flowEngine.context.defineProperty('message', { value: { error } });
    app.apiMock.onPost('oidc:getAuthUrl').reply(500, { errors: [{ message: 'Provider unavailable' }] });
    const authenticator = { name: 'oidc-a', authType: 'OIDC', title: 'OIDC sign in', options: {} } as Authenticator;
    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <MemoryRouter>
          <AuthenticatorsContext.Provider value={[authenticator]}>
            <OIDCButton authenticator={authenticator} />
          </AuthenticatorsContext.Provider>
        </MemoryRouter>
      </FlowEngineProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'OIDC sign in' }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(app.apiMock.history.post[0].headers['X-Authenticator']).toBe('oidc-a');
  });
});
