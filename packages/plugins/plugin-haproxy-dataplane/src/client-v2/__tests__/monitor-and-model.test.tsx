// SPDX-License-Identifier: Apache-2.0

import { createMockClient } from '@nocobase/client-v2';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RESOURCE_NAME } from '../../shared/constants';
import { HaproxyConsoleView } from '../components/HaproxyConsoleView';
import { HaproxyMonitorView } from '../components/HaproxyMonitorView';
import { HaproxyReverseProxyView } from '../components/HaproxyReverseProxyView';
import { HaproxyRevisionsView } from '../components/HaproxyRevisionsView';
import { HaproxyDataplaneBlockModel } from '../models/HaproxyDataplaneBlockModel';
import PluginHaproxyDataplaneClientV2 from '../plugin';

beforeAll(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
});

afterEach(cleanup);

describe('PluginHaproxyDataplaneClientV2, HaproxyConsoleView & HaproxyMonitorView', () => {
  it('registers HaproxyDataplaneBlockModel and persists console/monitor step parameters', async () => {
    const app = createMockClient();
    await new PluginHaproxyDataplaneClientV2({}, app).load();

    const block = app.flowEngine.createModel<HaproxyDataplaneBlockModel>({
      use: 'HaproxyDataplaneBlockModel',
      stepParams: {
        haproxyDataplaneBlockSettings: {
          configureMonitor: {
            viewMode: 'console',
            connectionId: 2,
            refreshSeconds: 10,
            defaultTab: 'backends',
          },
        },
      },
    });

    expect(block).toBeInstanceOf(HaproxyDataplaneBlockModel);
    expect(block.serialize().stepParams.haproxyDataplaneBlockSettings.configureMonitor).toEqual({
      viewMode: 'console',
      connectionId: 2,
      refreshSeconds: 10,
      defaultTab: 'backends',
    });
  });

  it('renders full administration console tabs and dispatches zero-reload runtime drain action', async () => {
    const app = createMockClient();
    const requestMock = vi.fn(async (cfg: { url?: string; data?: { values?: Record<string, unknown> } }) => {
      if (cfg.url === `${RESOURCE_NAME}:myPermissions`) {
        return {
          data: {
            data: {
              canAccess: true,
              canRead: true,
              canRuntime: true,
              canConfig: true,
              canRawConfig: true,
              canStorage: true,
              canManageConnections: true,
              canManage: true,
            },
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:fleetOverview`) {
        return {
          data: {
            data: [
              {
                connectionId: 1,
                name: 'edge-lb-01',
                title: 'Edge LB 01',
                reachable: true,
                error: null,
                hostname: 'haproxy-edge-01',
                apiVersion: 'v3.1.2',
                haproxyVersion: '3.0.8',
                uptime: 3600,
                configVersion: 7,
                currConns: 24,
                maxConn: 4096,
                upServers: 1,
                totalServers: 1,
                frontendsCount: 1,
                backendsCount: 1,
                openTransactions: 0,
                lastReloadStatus: 'succeeded',
                lastReloadId: '2026-11-25-0',
              },
            ],
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:listConnections`) {
        return {
          data: {
            data: [
              {
                id: 1,
                name: 'edge-lb-01',
                title: 'Edge LB 01',
                baseUrl: 'http://10.0.0.10:5555',
                authType: 'basic',
                username: 'admin',
                password: '********',
                tlsSkipVerify: false,
                timeoutMs: 10000,
                enabled: true,
                notes: null,
                lastCheckAt: null,
                lastApiVersion: 'v3.1.2',
                lastHaproxyVersion: '3.0.8',
                lastError: null,
              },
            ],
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:getSnapshot`) {
        return {
          data: {
            data: {
              connectionId: 1,
              connectionName: 'edge-lb-01',
              fetchedAt: '2026-11-25T08:00:00.000Z',
              configVersion: 7,
              apiInfo: {
                apiVersion: 'v3.1.2',
                buildDate: null,
                hostname: 'haproxy-edge-01',
                osString: 'Linux',
                systemUptime: 3600,
              },
              processInfo: {
                runtimeApi: '/var/run/haproxy.sock',
                error: null,
                version: '3.0.8',
                uptime: 3600,
                pid: 10,
                nbthread: 4,
                currConns: 24,
                cumConns: 5000,
                connRate: 3,
                maxConn: 2000,
                currSslConns: null,
                bytesOutRate: null,
              },
              statsError: null,
              frontends: [],
              backends: [],
              servers: [
                {
                  key: 'be_web/app_node_1',
                  backendName: 'be_web',
                  name: 'app_node_1',
                  address: '10.0.0.21',
                  port: 13000,
                  status: 'UP',
                  adminState: 'ready',
                  operationalState: 'up',
                  weight: 100,
                  uweight: 100,
                  iweight: 100,
                  scur: 4,
                  smax: 12,
                  stot: 900,
                  qcur: 0,
                  bin: 4096,
                  bout: 16384,
                  hrsp2xx: 890,
                  hrsp4xx: 10,
                  hrsp5xx: 0,
                  econ: 0,
                  eresp: 0,
                  rtime: 5,
                  checkStatus: 'L7OK',
                  checkCode: 200,
                  checkDuration: 1,
                  lastchg: 1200,
                },
              ],
            },
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:updateRuntimeServer`) {
        return {
          data: {
            data: {
              id: '1',
              name: 'app_node_1',
              backendName: 'be_web',
              address: '10.0.0.21',
              port: 13000,
              adminState: 'drain',
              operationalState: 'stopping',
              weight: 100,
            },
          },
        };
      }
      return { data: { data: [] } };
    });

    app.flowEngine.context.api.request = requestMock as unknown as typeof app.flowEngine.context.api.request;

    const consoleRender = render(
      <FlowEngineProvider engine={app.flowEngine}>
        <HaproxyConsoleView />
      </FlowEngineProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Reverse Proxy (In → Out)')).toBeTruthy();
    });
    expect(screen.getByText('Configuration & Routing')).toBeTruthy();
    expect(screen.getByText('Versions, Diff & Audit')).toBeTruthy();
    expect(screen.getByText('Raw Config & Sync')).toBeTruthy();
    expect(screen.getByText('SSL, Maps & Storage')).toBeTruthy();
    consoleRender.unmount();

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <HaproxyMonitorView />
      </FlowEngineProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('app_node_1')).toBeTruthy();
    });

    const drainButton = screen.getByRole('button', { name: 'Drain be_web/app_node_1' });
    fireEvent.click(drainButton);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `${RESOURCE_NAME}:updateRuntimeServer`,
          method: 'post',
          data: {
            values: {
              connectionId: 1,
              backend: 'be_web',
              server: 'app_node_1',
              adminState: 'drain',
            },
          },
        }),
      );
    });
  });

  it('renders HaproxyRevisionsView history and computes visual diff with live node config', async () => {
    const app = createMockClient();
    const requestMock = vi.fn(async (cfg: { url?: string }) => {
      if (cfg.url === `${RESOURCE_NAME}:myPermissions`) {
        return {
          data: {
            data: {
              canAccess: true,
              canRead: true,
              canRuntime: true,
              canConfig: true,
              canRawConfig: true,
              canStorage: false,
              canManageConnections: false,
              canManage: false,
            },
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:listConnections`) {
        return {
          data: {
            data: [
              {
                id: 1,
                name: 'edge-lb-01',
                title: 'Edge LB 01',
                baseUrl: 'http://10.0.0.10:5555',
                authType: 'basic',
                username: null,
                password: null,
                tlsSkipVerify: false,
                timeoutMs: 10000,
                enabled: true,
                notes: null,
                lastCheckAt: null,
                lastApiVersion: 'v3.1.2',
                lastHaproxyVersion: '3.0.8',
                lastError: null,
              },
            ],
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:listRevisions`) {
        return {
          data: {
            data: [
              {
                id: 12,
                connectionId: 1,
                connectionName: 'edge-lb-01',
                configVersion: 7,
                checksum: 'abcd1234',
                source: 'manual_snapshot',
                summary: 'Before canary rollout',
                lineCount: 18,
                byteSize: 420,
                actorUserId: 1,
                actorName: 'ops-admin',
                createdAt: '2026-11-25T10:00:00.000Z',
              },
            ],
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:listAuditLogs`) {
        return {
          data: {
            data: [
              {
                id: 3,
                connectionId: 1,
                connectionName: 'edge-lb-01',
                category: 'config',
                action: 'createSnapshot',
                target: '#12',
                status: 'success',
                detail: 'Before canary rollout',
                actorUserId: 1,
                actorName: 'ops-admin',
                createdAt: '2026-11-25T10:00:00.000Z',
              },
            ],
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:diffRevisions`) {
        return {
          data: {
            data: {
              leftLabel: 'edge-lb-01 #12 (v7)',
              rightLabel: 'edge-lb-01 (Live v8)',
              identical: false,
              addedCount: 1,
              deletedCount: 1,
              unchangedCount: 1,
              truncated: false,
              lines: [
                { type: 'context', oldLineNumber: 1, newLineNumber: 1, content: 'global' },
                { type: 'del', oldLineNumber: 2, newLineNumber: null, content: '  maxconn 2000' },
                { type: 'add', oldLineNumber: null, newLineNumber: 2, content: '  maxconn 4096' },
              ],
            },
          },
        };
      }
      return { data: { data: [] } };
    });

    app.flowEngine.context.api.request = requestMock as unknown as typeof app.flowEngine.context.api.request;

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <HaproxyRevisionsView />
      </FlowEngineProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Before canary rollout')).toBeTruthy();
    });

    const diffBtn = screen.getByRole('button', { name: 'Diff with Live #12' });
    fireEvent.click(diffBtn);

    await waitFor(() => {
      expect(screen.getByText('edge-lb-01 (Live v8)')).toBeTruthy();
    });
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });

  it('renders HaproxyReverseProxyView In -> Out matrix, filters routes, and toggles enable/disable', async () => {
    const app = createMockClient();
    const requestMock = vi.fn(async (cfg: { url?: string }) => {
      if (cfg.url === `${RESOURCE_NAME}:myPermissions`) {
        return {
          data: {
            data: {
              canAccess: true,
              canRead: true,
              canRuntime: true,
              canConfig: true,
              canRawConfig: false,
              canStorage: false,
              canManageConnections: false,
              canManage: false,
            },
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:listConnections`) {
        return {
          data: {
            data: [
              {
                id: 1,
                name: 'edge-lb-01',
                title: 'Edge LB 01',
                baseUrl: 'http://10.0.1.10:5555',
                authType: 'basic',
                username: null,
                password: null,
                tlsSkipVerify: false,
                timeoutMs: 10000,
                enabled: true,
                notes: null,
                lastCheckAt: null,
                lastApiVersion: 'v3.0.28',
                lastHaproxyVersion: '3.0.31',
                lastError: null,
              },
            ],
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:listReverseProxies`) {
        return {
          data: {
            data: {
              routes: [
                {
                  routeKey: '1:default:fe_crm_8090:be_crm_8090',
                  kind: 'dedicated_port',
                  connectionId: 1,
                  nodeName: 'edge-lb-01',
                  nodeTitle: 'Edge LB 01',
                  nodeAddress: '10.0.1.10',
                  nodeHostname: 'haproxy-lb-01',
                  frontendName: 'fe_crm_8090',
                  mode: 'http',
                  binds: [{ name: 'bind_8090', address: '0.0.0.0', port: 8090, ssl: false, sslCertificate: null }],
                  ruleIndex: null,
                  ruleCond: null,
                  ruleCondTest: null,
                  matchedAcls: [],
                  hostMatch: null,
                  pathBegMatch: null,
                  backendName: 'be_crm_8090',
                  isDynamicBackend: false,
                  balanceAlgorithm: 'roundrobin',
                  targets: [
                    {
                      name: 'srv_1',
                      address: '10.0.2.50',
                      port: 3000,
                      weight: 100,
                      ssl: false,
                      check: true,
                      backup: false,
                      maintenance: false,
                      liveStatus: 'UP',
                      checkStatus: 'L7OK',
                      checkCode: 200,
                    },
                  ],
                  enabled: true,
                  canToggle: true,
                  healthState: 'healthy',
                  upTargets: 1,
                  totalTargets: 1,
                  connectTimeoutMs: 5000,
                  serverTimeoutMs: 30000,
                  timeoutInherited: false,
                  advCheck: 'httpchk',
                  httpCheckMethod: 'GET',
                  httpCheckUri: '/health',
                },
              ],
              nodeErrors: [],
            },
          },
        };
      }
      if (cfg.url === `${RESOURCE_NAME}:toggleReverseProxy`) {
        return { data: { data: { status: 200, reloadId: null, configurationVersion: 8 } } };
      }
      return { data: { data: [] } };
    });

    app.flowEngine.context.api.request = requestMock as unknown as typeof app.flowEngine.context.api.request;

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <HaproxyReverseProxyView />
      </FlowEngineProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('0.0.0.0:8090')).toBeTruthy();
    });
    expect(screen.getByText('10.0.1.10')).toBeTruthy();
    expect(screen.getByText('10.0.2.50:3000')).toBeTruthy();

    const disableBtn = screen.getByRole('button', { name: 'Disable edge-lb-01 fe_crm_8090 be_crm_8090' });
    fireEvent.click(disableBtn);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `${RESOURCE_NAME}:toggleReverseProxy`,
          method: 'post',
          data: {
            values: {
              connectionId: 1,
              kind: 'dedicated_port',
              frontendName: 'fe_crm_8090',
              backendName: 'be_crm_8090',
              enabled: false,
            },
          },
        }),
      );
    });
  });
});
