import { createMockServer } from '@nocobase/test';
import { createHmac } from 'crypto';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import type { Context, Next } from '@nocobase/actions';
import { UiPathWebhookVerifier } from '../services/UiPathWebhookVerifier';
import { DEFAULT_UIPATH_SCOPES, UiPathApiClient } from '../services/UiPathApiClient';
import { createProcessActions } from '../actions/processes';
import { createJobActions } from '../actions/jobs';
import { createQueueActions } from '../actions/queues';
import { createAssetActions } from '../actions/assets';
import { createCustomApiActions } from '../actions/customApi';
import { UiPathCorrelationService } from '../services/UiPathCorrelationService';
import { buildDateRangeFilter, combineODataFilters, escapeODataString } from '../utils/odata';
import { PluginUiPathOrchestratorServer } from '../plugin';

describe('UiPath Orchestrator plugin', () => {
  let app;

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads with mock server', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'uipath-orchestrator'],
    });

    expect(app).toBeTruthy();
  });
});

describe('UiPathWebhookVerifier', () => {
  it('verifies valid HMAC-SHA256 signature', () => {
    const secret = 'test-secret';
    const rawBody = JSON.stringify({ Type: 'job.faulted', EventId: 'evt-1' });
    const signature = createHmac('sha256', secret).update(rawBody).digest('base64');

    expect(UiPathWebhookVerifier.verify(secret, signature, rawBody)).toBe(true);
  });

  it('rejects invalid signature', () => {
    expect(UiPathWebhookVerifier.verify('secret', 'invalid-sig', '{}')).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(UiPathWebhookVerifier.verify('', 'sig', '{}')).toBe(false);
    expect(UiPathWebhookVerifier.verify('sec', '', '{}')).toBe(false);
  });

  it('parses event type from payload', () => {
    expect(UiPathWebhookVerifier.parseEventType({ Type: 'job.faulted' })).toBe('job.faulted');
    expect(UiPathWebhookVerifier.parseEventType({ type: 'queueItem.added' })).toBe('queueItem.added');
    expect(UiPathWebhookVerifier.parseEventType({})).toBe('unknown');
  });

  it('extracts entity ID from job webhook payload', () => {
    const payload = { Type: 'job.faulted', Job: { Key: 'job-key-123', Id: 456 } };
    expect(UiPathWebhookVerifier.extractEntityId(payload)).toBe('job-key-123');
  });

  it('extracts entity ID from queue item payload', () => {
    const payload = { Type: 'queueItem.transactionFailed', QueueItem: { Id: 789 } };
    expect(UiPathWebhookVerifier.extractEntityId(payload)).toBe('789');
  });
});

describe('UiPathApiClient OData query builder', () => {
  it('builds basic OData params', () => {
    const params = UiPathApiClient.buildODataParams({ $top: 10, $skip: 20, $count: true });
    expect(params.get('$top')).toBe('10');
    expect(params.get('$skip')).toBe('20');
    expect(params.get('$count')).toBe('true');
  });

  it('handles short-key aliases', () => {
    const params = UiPathApiClient.buildODataParams({ top: 5, filter: "State eq 'Faulted'" });
    expect(params.get('$top')).toBe('5');
    expect(params.get('$filter')).toBe("State eq 'Faulted'");
  });

  it('passes through non-OData params', () => {
    const params = UiPathApiClient.buildODataParams({ custom: 'value', $top: 10 });
    expect(params.get('custom')).toBe('value');
    expect(params.get('$top')).toBe('10');
  });

  it('returns empty params for null query', () => {
    const params = UiPathApiClient.buildODataParams();
    expect(params.toString()).toBe('');
  });
});

describe('UiPath monitoring filter helpers', () => {
  it('escapes OData strings and combines filters', () => {
    expect(escapeODataString("A 'quoted' value")).toBe("A ''quoted'' value");
    expect(combineODataFilters(["State eq 'Faulted'", undefined, 'CreationTime ge 2026-01-01T00:00:00.000Z'])).toBe(
      "(State eq 'Faulted') and (CreationTime ge 2026-01-01T00:00:00.000Z)",
    );
  });

  it('builds date range filters', () => {
    expect(
      buildDateRangeFilter('TimeStamp', {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe('(TimeStamp ge 2026-01-01T00:00:00.000Z) and (TimeStamp le 2026-01-02T00:00:00.000Z)');
  });
});

describe('UiPath read-only action surface', () => {
  it('does not expose mutating Orchestrator actions', () => {
    const plugin = {} as PluginUiPathOrchestratorServer;
    expect(createJobActions(plugin)).not.toHaveProperty('start');
    expect(createJobActions(plugin)).not.toHaveProperty('stop');
    expect(createJobActions(plugin)).not.toHaveProperty('kill');
    expect(createJobActions(plugin)).not.toHaveProperty('restart');
    expect(createQueueActions(plugin)).not.toHaveProperty('addItem');
    expect(createQueueActions(plugin)).not.toHaveProperty('setTransactionResult');
    expect(createQueueActions(plugin)).not.toHaveProperty('retry');
    expect(createAssetActions(plugin)).not.toHaveProperty('create');
    expect(createAssetActions(plugin)).not.toHaveProperty('update');
    expect(createAssetActions(plugin)).not.toHaveProperty('destroy');
  });

  it('rejects non-GET custom API proxy calls', async () => {
    const plugin = {
      getApiClient: async () => ({ request: vi.fn() }),
    } as unknown as PluginUiPathOrchestratorServer;
    const actions = createCustomApiActions(plugin);
    const ctx = {
      action: { params: { instanceId: 1, method: 'POST', endpoint: '/odata/Jobs', body: { x: 1 } } },
    } as unknown as Context;
    const next = vi.fn();

    await actions.proxy(ctx, next as unknown as Next);

    expect(ctx.status).toBe(405);
    expect(ctx.body).toEqual({
      errors: [{ message: 'Custom UiPath API proxy is read-only. Only GET is allowed.' }],
    });
    expect(next).toHaveBeenCalled();
  });
});

describe('UiPathApiClient on-premise configuration', () => {
  it('builds standard on-prem Orchestrator and Identity URLs from server URL', () => {
    const client = new UiPathApiClient({
      id: 1,
      name: 'on-prem',
      deploymentType: 'onPrem',
      baseUrl: 'https://orchestrator.company.com',
      apiBaseUrl: '',
      tokenUrl: '',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: 'OR.Default',
    });

    expect(client.getConfig().apiBaseUrl).toBe('https://orchestrator.company.com/orchestrator');
    expect(client.getConfig().tokenUrl).toBe('https://orchestrator.company.com/identity/connect/token');
    expect(client.getConfig().scopes).toBe(DEFAULT_UIPATH_SCOPES);
  });

  it('keeps a full on-prem Orchestrator API URL when provided', () => {
    const client = new UiPathApiClient({
      id: 1,
      name: 'on-prem',
      deploymentType: 'onPrem',
      baseUrl: 'https://orchestrator.company.com/DefaultTenant/orchestrator_',
      apiBaseUrl: '',
      tokenUrl: '',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: DEFAULT_UIPATH_SCOPES,
    });

    expect(client.getConfig().apiBaseUrl).toBe('https://orchestrator.company.com/DefaultTenant/orchestrator_');
    expect(client.getConfig().tokenUrl).toBe('https://orchestrator.company.com/DefaultTenant/identity/connect/token');
  });

  it('requests on-prem API through /orchestrator and does not send cloud tenant header', async () => {
    const requests: Array<{ url?: string; method?: string; headers: Record<string, string | string[] | undefined> }> =
      [];
    const server = createServer((req, res) => {
      requests.push({ url: req.url, method: req.method, headers: req.headers });

      if (req.url === '/identity/connect/token' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }));
        return;
      }

      if (
        (req.url?.startsWith('/orchestrator/odata/Folders') ||
          req.url?.startsWith('/orchestrator/odata/Jobs') ||
          req.url?.startsWith('/orchestrator/odata/Users') ||
          req.url?.startsWith('/orchestrator/api/CustomFolderOperation')) &&
        req.method === 'GET'
      ) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ value: [{ Id: 1, DisplayName: 'Default' }] }));
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const client = new UiPathApiClient({
        id: 1,
        name: 'on-prem',
        deploymentType: 'onPrem',
        baseUrl: `http://127.0.0.1:${port}`,
        apiBaseUrl: '',
        tokenUrl: '',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        scopes: DEFAULT_UIPATH_SCOPES,
        tenantName: 'should-not-be-sent',
        defaultFolderId: 42,
        defaultFolderKey: 'folder-key-42',
      });

      await client.testConnection();
      await client.get('/odata/Jobs', { query: { $top: 1 } });
      await client.get('/odata/Users', { folder: { folderId: 99 } });
      await client.get('/api/CustomFolderOperation', { folder: { folderId: 77 } });

      const folderRequest = requests.find((request) => request.url?.startsWith('/orchestrator/odata/Folders'));
      expect(folderRequest).toBeTruthy();
      expect(folderRequest?.headers['x-uipath-organizationunitid']).toBeUndefined();

      const jobsRequest = requests.find((request) => request.url?.startsWith('/orchestrator/odata/Jobs'));
      expect(jobsRequest).toBeTruthy();
      expect(jobsRequest?.headers['x-uipath-tenantname']).toBeUndefined();
      expect(jobsRequest?.headers['x-uipath-organizationunitid']).toBe('42');
      expect(jobsRequest?.headers['x-uipath-folderkey']).toBeUndefined();
      expect(jobsRequest?.headers.authorization).toBe('Bearer test-token');

      const usersRequest = requests.find((request) => request.url?.startsWith('/orchestrator/odata/Users'));
      expect(usersRequest?.headers['x-uipath-organizationunitid']).toBeUndefined();

      const customRequest = requests.find(
        (request) => request.url?.startsWith('/orchestrator/api/CustomFolderOperation'),
      );
      expect(customRequest?.headers['x-uipath-organizationunitid']).toBe('77');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe('PluginUiPathOrchestratorServer instance lookup', () => {
  it('does not fall back to another instance when an explicit instanceId is missing', async () => {
    const findOne = vi.fn(async () => null);
    const plugin = Object.create(PluginUiPathOrchestratorServer.prototype) as PluginUiPathOrchestratorServer;
    Object.defineProperty(plugin, 'db', {
      value: { getRepository: () => ({ findOne }) },
    });
    Object.defineProperty(plugin, 'clientCache', { value: new Map() });

    await expect(plugin.getApiClient(404)).rejects.toThrow('UiPath instance not found: 404');
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith({ filter: { id: 404 } });
  });
});

describe('UiPathCorrelationService', () => {
  it('traces a queue item to overlapping jobs and logs cut off by processing window', async () => {
    const calls: Array<{ endpoint: string; options?: any }> = [];
    const client = {
      get: vi.fn(async (endpoint: string, options?: any) => {
        calls.push({ endpoint, options });
        if (endpoint === '/odata/QueueItems(100)') {
          return {
            Id: 100,
            Key: 'queue-key',
            Reference: 'INV-1',
            StartProcessing: '2026-01-01T10:00:00.000Z',
            EndProcessing: '2026-01-01T10:05:00.000Z',
            Robot: { Id: 7 },
          };
        }
        if (endpoint === '/odata/Jobs') {
          return { value: [{ Id: 10, Key: 'job-key', ReleaseName: 'Process A', State: 'Successful' }] };
        }
        if (endpoint === '/odata/RobotLogs') {
          return { value: [{ Id: 1, JobKey: 'job-key', TimeStamp: '2026-01-01T10:02:00.000Z' }] };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
    };

    const service = new UiPathCorrelationService(client);
    const result = await service.fromQueueItem({ queueItemId: 100 });

    expect(result.job?.Key).toBe('job-key');
    expect(result.logs).toHaveLength(1);
    const primaryLogCall = calls.find(
      (call) =>
        call.endpoint === '/odata/RobotLogs' &&
        call.options?.query?.$filter?.includes('TimeStamp ge 2026-01-01T10:00:00.000Z'),
    );
    expect(primaryLogCall?.options.query.$filter).toContain('TimeStamp le 2026-01-01T10:05:00.000Z');
  });

  it('traces a log to a job and queue items at the log timestamp', async () => {
    const client = {
      get: vi.fn(async (endpoint: string) => {
        if (endpoint === '/odata/RobotLogs(9)') {
          return { Id: 9, JobKey: 'job-key', TimeStamp: '2026-01-01T10:02:00.000Z' };
        }
        if (endpoint === '/odata/Jobs') {
          return { value: [{ Id: 10, Key: 'job-key', State: 'Successful' }] };
        }
        if (endpoint === '/odata/QueueItems') {
          return { value: [{ Id: 100, Status: 'Successful' }] };
        }
        if (endpoint === '/odata/RobotLogs') {
          return { value: [{ Id: 9, JobKey: 'job-key' }] };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
    };

    const service = new UiPathCorrelationService(client);
    const result = await service.fromLog({ logId: 9 });

    expect(result.job?.Key).toBe('job-key');
    expect(result.queueItems[0].record.Id).toBe(100);
    expect(result.queueItems[0].confidence).toBe('medium');
  });

  it('prioritizes an exact queue reference from the log over unrelated overlapping items', async () => {
    const filters: string[] = [];
    const client = {
      get: vi.fn(async (endpoint: string, options?: { query?: { $filter?: string } }) => {
        if (endpoint === '/odata/Jobs') {
          return {
            value: [
              {
                Id: 10,
                Key: 'job-key',
                State: 'Successful',
                StartTime: '2026-01-01T10:00:00.000Z',
                EndTime: '2026-01-01T10:05:00.000Z',
              },
            ],
          };
        }
        if (endpoint === '/odata/QueueItems') {
          filters.push(options?.query?.$filter || '');
          return { value: [{ Id: 101, Reference: 'INV-42', Status: 'Successful' }] };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
    };

    const service = new UiPathCorrelationService(client);
    const result = await service.fromLog({
      logId: 9,
      jobKey: 'job-key',
      timeStamp: '2026-01-01T10:02:00.000Z',
      queueReference: 'INV-42',
    });

    expect(filters).toEqual(["(Key eq 'INV-42' or Reference eq 'INV-42')"]);
    expect(result.queueItems).toHaveLength(1);
    expect(result.queueItems[0].record.Id).toBe(101);
    expect(result.queueItems[0].confidence).toBe('high');
  });

  it('traces a job to logs and overlapping queue items', async () => {
    const client = {
      get: vi.fn(async (endpoint: string) => {
        if (endpoint === '/odata/Jobs(10)') {
          return {
            Id: 10,
            Key: 'job-key',
            StartTime: '2026-01-01T10:00:00.000Z',
            EndTime: '2026-01-01T10:05:00.000Z',
          };
        }
        if (endpoint === '/odata/RobotLogs') {
          return {
            value: [
              {
                Id: 1,
                JobKey: 'job-key',
                Message: 'Reference: INV-1',
              },
            ],
          };
        }
        if (endpoint === '/odata/QueueItems') {
          return { value: [{ Id: 100, Reference: 'INV-1', Status: 'Successful' }] };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }),
    };

    const service = new UiPathCorrelationService(client);
    const result = await service.fromJob({ jobId: 10 });

    expect(result.logs).toHaveLength(1);
    expect(result.queueItems[0].record.Reference).toBe('INV-1');
    expect(result.queueItems[0].confidence).toBe('high');
  });
});

describe('UiPath process actions', () => {
  it('loads arguments from the on-prem Processes GetArguments endpoint', async () => {
    const endpoints: string[] = [];
    const plugin = {
      getApiClient: async () => ({
        get: async (endpoint: string) => {
          endpoints.push(endpoint);
          if (endpoint.startsWith('/odata/Releases')) {
            return { Key: 'release-key', Name: 'Release', ProcessKey: "Process 'A" };
          }
          if (endpoint.startsWith('/odata/Processes/UiPath.Server.Configuration.OData.GetArguments')) {
            return {
              Input: '{"customerId":{"type":"String"}}',
              Output: '{"result":{"type":"String"}}',
            };
          }
          throw new Error(`Unexpected endpoint: ${endpoint}`);
        },
      }),
    };
    const actions = createProcessActions(plugin as unknown as PluginUiPathOrchestratorServer);
    const ctx = { action: { params: { instanceId: 1, filterByTk: 10 } } } as unknown as Context;
    const next = vi.fn();

    await actions.getArgs(ctx, next as unknown as Next);

    expect(endpoints[0]).toBe('/odata/Releases(10)');
    expect(endpoints[1]).toBe("/odata/Processes/UiPath.Server.Configuration.OData.GetArguments(key='Process%20''A')");
    expect(ctx.body).toEqual({
      release: { key: 'release-key', name: 'Release', processKey: "Process 'A" },
      inputArguments: { customerId: { type: 'String' } },
      outputArguments: { result: { type: 'String' } },
    });
    expect(next).toHaveBeenCalled();
  });
});
