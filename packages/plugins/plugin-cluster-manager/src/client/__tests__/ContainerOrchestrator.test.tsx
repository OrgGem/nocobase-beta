/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { ContainerOrchestrator } from '../ContainerOrchestrator';

const mockRequest = vi.fn();
const mockApp = {
  apiClient: {
    request: mockRequest,
  },
  i18n: {
    t: (key: string) => key,
  },
};

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => mockApp,
}));

describe('ContainerOrchestrator unconfigured state', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('shows Orchestrator Not Connected without pinging adapter or showing errors when config is unset', async () => {
    const errorSpy = vi.spyOn(message, 'error');
    mockRequest.mockImplementation(async (config: { url?: string }) => {
      if (config.url === '/workerOrchestrator:getSettings') {
        return { data: { adapterType: 'none' } };
      }
      if (config.url === '/workerQueueMappings:scanQueues') {
        return { data: { discovered: [] } };
      }
      throw new Error(`Unexpected request: ${config.url}`);
    });

    render(<ContainerOrchestrator />);

    await waitFor(() => {
      expect(screen.getByText('Orchestrator Not Connected')).toBeDefined();
    });

    const calledUrls = mockRequest.mock.calls.map(([cfg]) => cfg.url);
    expect(calledUrls).toContain('/workerOrchestrator:getSettings');
    expect(calledUrls).not.toContain('/workerOrchestrator:ping');
    expect(calledUrls).not.toContain('/orchestratorStacks:list');
    expect(calledUrls).not.toContain('/workerOrchestrator:containers');
    expect(calledUrls).not.toContain('/workerOrchestrator:networks');
    expect(errorSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => {
      expect(
        mockRequest.mock.calls.filter(([cfg]) => cfg.url === '/workerOrchestrator:getSettings').length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(mockRequest.mock.calls.map(([cfg]) => cfg.url)).not.toContain('/workerOrchestrator:ping');

    errorSpy.mockRestore();
  });

  it('checks adapter connectivity and loads stacks once an adapter is configured', async () => {
    mockRequest.mockImplementation(async (config: { url?: string }) => {
      if (config.url === '/workerOrchestrator:getSettings') {
        return { data: { adapterType: 'docker' } };
      }
      if (config.url === '/workerOrchestrator:ping') {
        return { data: { adapter: 'docker', connected: true, leader: true } };
      }
      if (config.url === '/orchestratorStacks:list') {
        return { data: { data: [] } };
      }
      if (config.url === '/workerQueueMappings:scanQueues') {
        return { data: { discovered: [] } };
      }
      return { data: {} };
    });

    render(<ContainerOrchestrator />);

    await waitFor(() => {
      expect(screen.getByText('No stacks configured')).toBeDefined();
    });

    const calledUrls = mockRequest.mock.calls.map(([cfg]) => cfg.url);
    expect(calledUrls).toContain('/workerOrchestrator:ping');
    expect(calledUrls).toContain('/orchestratorStacks:list');
  });
});
