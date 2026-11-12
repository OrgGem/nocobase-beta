// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as ClientV2 from '@nocobase/client-v2';
import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SftpgoApiKeys } from '../components/SftpgoApiKeys';

vi.mock('../locale', () => {
  const translate = (value: string, options?: Record<string, unknown>) =>
    value.replace(/\{\{\s*([^\s}]+)\s*\}\}/g, (match, key: string) =>
      options?.[key] === undefined ? match : String(options[key]),
    );
  return { useT: () => translate };
});

function apiResponse(data: unknown) {
  return {
    data: { data },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    matches: false,
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SftpgoApiKeys', () => {
  it('keeps an unbound user key unbound when only its description changes', async () => {
    const app = ClientV2.createMockClient();
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      if (url === 'sftpgoConnections:list') {
        return apiResponse([{ id: 1, name: 'Primary', authMethod: 'admin' }]);
      }
      if (url === 'sftpgoApiKeys:list') {
        return apiResponse([
          {
            id: 'unbound-user-key',
            name: 'unbound-key',
            scope: 2,
            user: '',
            admin: '',
            description: 'Before',
          },
        ]);
      }
      if (url === 'sftpgoUsers:list') return apiResponse([]);
      return apiResponse({});
    });

    render(<SftpgoApiKeys />);
    await screen.findByText('unbound-key');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'After' } });
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));

    await waitFor(() => {
      const update = request.mock.calls.find(([config]) => 'url' in config && config.url === 'sftpgoApiKeys:update');
      expect(update).toBeDefined();
      if (!update) throw new Error('API key update request was not sent');
      const payload = 'data' in update[0] ? (update[0].data as Record<string, unknown>) : {};
      expect(payload).toMatchObject({ description: 'After' });
      expect(payload).not.toHaveProperty('scope');
      expect(payload).not.toHaveProperty('user');
      expect(payload).not.toHaveProperty('admin');
    });
  });
});
