// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as ClientV2 from '@nocobase/client-v2';
import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SftpgoFolders } from '../components/SftpgoFolders';

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

describe('SftpgoFolders mapped path validation', () => {
  it('allows a remote folder with empty mapped_path to change its description without overwriting the path', async () => {
    const app = ClientV2.createMockClient();
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      if (url === 'sftpgoConnections:list') return apiResponse([{ id: 1, name: 'Primary' }]);
      if (url === 'sftpgoFolders:list') {
        return apiResponse([
          {
            name: 'remote-folder',
            mapped_path: '',
            description: 'Before',
            filesystem: { provider: 1 },
          },
        ]);
      }
      return apiResponse({});
    });

    render(<SftpgoFolders />);
    await screen.findByText('remote-folder');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'After' } });
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));

    await waitFor(() => {
      const update = request.mock.calls.find(([config]) => 'url' in config && config.url === 'sftpgoFolders:update');
      expect(update).toBeDefined();
      if (!update) throw new Error('Folder update request was not sent');
      const payload = 'data' in update[0] ? (update[0].data as Record<string, unknown>) : {};
      expect(payload).toMatchObject({ description: 'After' });
      expect(payload).not.toHaveProperty('mapped_path');
    });
  });

  it.each([0, 4])('keeps mapped_path required for local or crypted provider %s', async (provider) => {
    const app = ClientV2.createMockClient();
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      if (url === 'sftpgoConnections:list') return apiResponse([{ id: 1, name: 'Primary' }]);
      if (url === 'sftpgoFolders:list') {
        return apiResponse([
          {
            name: 'local-folder',
            mapped_path: '',
            description: 'Before',
            filesystem: { provider },
          },
        ]);
      }
      return apiResponse({});
    });

    render(<SftpgoFolders />);
    await screen.findByText('local-folder');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const mappedPathInput = screen.getByLabelText('Mapped Path');
    const label = mappedPathInput.closest('.ant-form-item')?.querySelector('label');
    expect(label).toHaveClass('ant-form-item-required');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'After' } });
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => {
      expect(mappedPathInput.closest('.ant-form-item')?.querySelector('.ant-form-item-explain-error')).not.toBeNull();
    });
    expect(request.mock.calls.some(([config]) => 'url' in config && config.url === 'sftpgoFolders:update')).toBe(false);
  });
});
