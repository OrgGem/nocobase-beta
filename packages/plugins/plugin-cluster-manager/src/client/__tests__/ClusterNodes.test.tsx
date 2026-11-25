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
import { ClusterNodes } from '../ClusterNodes';

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

describe('ClusterNodes single-server hard restart', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('shows warning in Popconfirm and allows Hard Restart Cluster when only 1 app server is online', async () => {
    const warningSpy = vi.spyOn(message, 'warning');
    const errorSpy = vi.spyOn(message, 'error');

    mockRequest.mockImplementation(async (config: { url?: string; method?: string; data?: unknown }) => {
      if (config.url === 'clusterManagerCluster:current') {
        return {
          data: {
            data: {
              node: {
                hostname: 'app-1',
                pid: 100,
                nodeVersion: 'v22.0.0',
                uptime: 60,
                workerMode: 'main',
                appPort: '13000',
                clusterMode: '',
              },
              memory: { rss: 1024, heapUsed: 512, heapTotal: 1024 },
              os: { freeMemory: 1024, totalMemory: 2048, cpuCount: 2 },
            },
          },
        };
      }
      if (config.url === 'clusterManagerCluster:list') {
        return {
          data: {
            data: [{ id: 'app-1', name: 'main (app-1)', status: 'online', workerMode: 'main', pid: 100 }],
            meta: { fallback: true, registry: { configured: false } },
          },
        };
      }
      if (config.url === 'clusterManagerCluster:health') {
        return { data: { data: { healthy: true, checks: {} } } };
      }
      if (config.url === 'clusterManagerCluster:drift') {
        return { data: { data: { healthy: true, summary: {} } } };
      }
      if (config.url === 'clusterManagerCluster:legacyDiagnostics') {
        return { data: { data: { healthy: true, findings: [], plugins: [] } } };
      }
      if (config.url === 'clusterManagerCluster:restart') {
        return {
          data: {
            data: {
              success: true,
              singleNodeWarning: true,
              warning:
                'Only 1 app server is active. Hard restarting will cause temporary downtime until the server comes back online.',
            },
          },
        };
      }
      return { data: {} };
    });

    const { unmount } = render(<ClusterNodes />);

    await waitFor(() => {
      expect(screen.getByText('main (app-1)')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Hard Restart Cluster'));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Only 1 app server is active. Hard restarting will cause temporary downtime until the server comes back online.',
        ),
      ).toBeDefined();
    });

    fireEvent.click(screen.getByText('OK'));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith({
        url: 'clusterManagerCluster:restart',
        method: 'POST',
        data: { hostname: '*', mode: 'hard' },
      });
    });

    expect(warningSpy).toHaveBeenCalledWith(
      'Only 1 app server is active. Hard restarting will cause temporary downtime until the server comes back online.',
    );
    expect(errorSpy).not.toHaveBeenCalled();

    unmount();
    warningSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
