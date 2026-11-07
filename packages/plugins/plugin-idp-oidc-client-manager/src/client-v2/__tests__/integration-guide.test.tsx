/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LegacyGuide from '../../shared/IntegrationGuide';
import V2Guide from '../shared/IntegrationGuide';

afterEach(cleanup);

describe.each([
  ['v1', LegacyGuide],
  ['v2', V2Guide],
] as const)('%s integration guide', (_runtime, Guide) => {
  it.each([false, true])('generates consistent UserInfo and resource examples for API access=%s', (api) => {
    render(
      <Guide
        client={{
          id: 1,
          name: 'Application',
          clientId: 'test-client',
          clientType: 'public',
          redirectUris: ['https://client.example.com/callback'],
          postLogoutRedirectUris: [],
          scopes: ['openid', 'profile', 'email', ...(api ? ['api', 'offline_access'] : [])],
          tokenEndpointAuthMethod: 'none',
          allowDynamicLoopbackPort: false,
          enabled: true,
        }}
        provider={{ issuer: 'https://idp.example.com/api' }}
        t={(key) => key}
        onClose={() => {}}
      />,
    );
    // Ant Design renders the modal in a portal outside the testing-library container.
    fireEvent.click(screen.getByRole('tab', { name: 'Node.js' }));
    const nodeExample = document.querySelector('.ant-tabs-tabpane-active pre')?.textContent || '';
    expect(nodeExample).toContain("resource: 'https://idp.example.com/api/'");
    fireEvent.click(screen.getByRole('tab', { name: 'ASP.NET Core' }));
    const dotnetExample = document.querySelector('.ant-tabs-tabpane-active pre')?.textContent || '';
    expect(dotnetExample).toContain('GetClaimsFromUserInfoEndpoint = false');
    expect(dotnetExample).toContain('TokenEndpointRequest!.SetParameter("resource"');
    expect(dotnetExample).toContain('ProtocolMessage.SetParameter("resource"');
  });
});
