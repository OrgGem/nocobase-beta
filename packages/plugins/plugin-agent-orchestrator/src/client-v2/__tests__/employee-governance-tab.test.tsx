// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as ClientV2 from '@nocobase/client-v2';
import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { EmployeeGovernanceTab } from '../components/EmployeeGovernanceTab';

const LARGE_DEPARTMENT_ID = '9007199254740993';

function apiResponse(data: unknown) {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

function setupApp() {
  const app = ClientV2.createMockClient();
  const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
    const url = 'url' in config ? config.url : undefined;
    const params = ('params' in config ? config.params : undefined) as Record<string, unknown> | undefined;
    if (url === 'aiEmployees:list') {
      return apiResponse({
        data: [{ username: 'dara', nickname: 'Dara' }],
        meta: { count: 1 },
      });
    }
    if (url === 'agentGovernance:listTargets') {
      if (params?.target === 'user') {
        return apiResponse({
          data: [
            { id: '12', nickname: 'Alice Nguyen', username: 'alice', email: 'alice@example.com' },
            { id: '18', nickname: null, username: 'bob', email: 'bob@example.com' },
          ],
        });
      }
      if (params?.target === 'department') {
        return apiResponse({
          data: [
            { id: '10', title: 'Engineering', parentId: null },
            { id: LARGE_DEPARTMENT_ID, title: 'Platform', parentId: '10' },
          ],
        });
      }
    }
    if (url === 'agentGovernance:preview') {
      return apiResponse({
        data: {
          userId: '12',
          employeeUsername: 'dara',
          departmentId: LARGE_DEPARTMENT_ID,
          instruction: 'Follow platform rules.',
          promptMode: 'default',
          managed: false,
          projectedPrompt: 'Follow platform rules.\n\nPersonal note.',
          policies: [],
        },
      });
    }
    if (url === 'agentGovernance:saveDraft') {
      return apiResponse({
        data: {
          policyId: 1,
          version: { id: 1, policyId: 1, version: 1, revision: 1, status: 'draft', settings: {} },
        },
      });
    }
    return apiResponse({ data: [], meta: { count: 0 } });
  });
  vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
  return { app, request };
}

async function selectComboboxOption(combobox: HTMLElement, optionLabel: string) {
  fireEvent.mouseDown(combobox);
  const option = await screen.findByTitle(optionLabel);
  fireEvent.click(option);
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

describe('EmployeeGovernanceTab target selectors', () => {
  it('selects User ID in Preview and apply managed instruction and submits preview', async () => {
    const { request } = setupApp();
    render(
      <AIEmployeesProvider>
        <EmployeeGovernanceTab />
      </AIEmployeesProvider>,
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'agentGovernance:listTargets', params: { target: 'user' } }),
      ),
    );

    await selectComboboxOption(screen.getByLabelText('User ID'), 'Alice Nguyen (#12)');
    await selectComboboxOption(screen.getByLabelText('Employee'), 'Dara');

    fireEvent.click(screen.getByRole('button', { name: 'Preview effective policy' }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'agentGovernance:preview',
          method: 'post',
          data: { userId: '12', employeeUsername: 'dara' },
        }),
      ),
    );
    expect(await screen.findByText('Follow platform rules.')).toBeTruthy();
  });

  it('selects Department ID and User ID in Create policy and clears scopeId when switching scope', async () => {
    const { request } = setupApp();
    render(
      <AIEmployeesProvider>
        <EmployeeGovernanceTab />
      </AIEmployeesProvider>,
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'agentGovernance:listTargets', params: { target: 'department' } }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));
    const dialog = await screen.findByRole('dialog');

    await selectComboboxOption(
      within(dialog).getByLabelText('Department ID'),
      `Engineering / Platform (#${LARGE_DEPARTMENT_ID})`,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'agentGovernance:saveDraft',
          method: 'post',
          data: expect.objectContaining({
            scope: 'department',
            scopeId: LARGE_DEPARTMENT_ID,
          }),
        }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));
    const nextDialog = await screen.findByRole('dialog');

    await selectComboboxOption(
      within(nextDialog).getByLabelText('Department ID'),
      `Engineering / Platform (#${LARGE_DEPARTMENT_ID})`,
    );
    await selectComboboxOption(within(nextDialog).getByLabelText('Scope'), 'Governance scope: user');

    expect(within(nextDialog).queryByTitle(`Engineering / Platform (#${LARGE_DEPARTMENT_ID})`)).toBeNull();
    await selectComboboxOption(within(nextDialog).getByLabelText('User ID'), 'bob (#18)');
    fireEvent.click(within(nextDialog).getByRole('button', { name: 'Save draft' }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'agentGovernance:saveDraft',
          method: 'post',
          data: expect.objectContaining({
            scope: 'user',
            scopeId: '18',
          }),
        }),
      ),
    );
  });

  it('fetches remote search results at the 200-item limit and resolves missing scopeId when editing', async () => {
    const app = ClientV2.createMockClient();
    const initialUsers = Array.from({ length: 200 }, (_, index) => ({
      id: String(index + 1),
      nickname: `User ${index + 1}`,
      username: `user_${index + 1}`,
    }));
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      const params = ('params' in config ? config.params : undefined) as Record<string, unknown> | undefined;
      if (url === 'aiEmployees:list') {
        return apiResponse({ data: [{ username: 'dara', nickname: 'Dara' }], meta: { count: 1 } });
      }
      if (url === 'agentGovernance:list') {
        return apiResponse({
          data: [
            {
              id: 55,
              scope: 'department',
              scopeId: '999',
              currentVersion: { id: 9, policyId: 55, version: 1, status: 'published', settings: {} },
            },
          ],
          meta: { count: 1 },
        });
      }
      if (url === 'agentGovernance:listTargets') {
        if (params?.target === 'user') {
          if (params.search === 'zoe') {
            return apiResponse({ data: [{ id: '250', nickname: 'Zoe', username: 'zoe_ops' }] });
          }
          return apiResponse({ data: initialUsers });
        }
        if (params?.target === 'department') {
          if (params.id === '999') {
            return apiResponse({ data: [{ id: '999', title: 'Security', parentId: null }] });
          }
          return apiResponse({ data: [{ id: '10', title: 'Engineering', parentId: null }] });
        }
      }
      return apiResponse({ data: [], meta: { count: 0 } });
    });
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);

    render(
      <AIEmployeesProvider>
        <EmployeeGovernanceTab />
      </AIEmployeesProvider>,
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'agentGovernance:listTargets', params: { target: 'user' } }),
      ),
    );

    const userCombobox = screen.getByLabelText('User ID');
    fireEvent.mouseDown(userCombobox);
    fireEvent.change(userCombobox, { target: { value: 'zoe' } });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'agentGovernance:listTargets',
          params: { target: 'user', search: 'zoe' },
        }),
      ),
    );
    expect(await screen.findByTitle('Zoe (#250)')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'agentGovernance:listTargets',
          params: { target: 'department', id: '999' },
        }),
      ),
    );
    expect(await within(dialog).findByText('Security (#999)')).toBeTruthy();
  });
});
