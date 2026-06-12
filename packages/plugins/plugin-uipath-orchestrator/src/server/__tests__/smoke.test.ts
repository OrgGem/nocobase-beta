import { createMockServer } from '@nocobase/test';
import { createHmac } from 'crypto';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import type { Context, Next } from '@nocobase/actions';
import { UiPathWebhookVerifier } from '../services/UiPathWebhookVerifier';
import { DEFAULT_UIPATH_SCOPES, UiPathApiClient } from '../services/UiPathApiClient';
import { createProcessActions } from '../actions/processes';
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
