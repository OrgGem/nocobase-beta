import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@nocobase/actions';
import { describe, beforeEach, it, expect, vi } from 'vitest';
import PluginMicrosoftGraphGatewayServer from '../plugin';

describe('Microsoft Graph Gateway Audit & Monitoring System', () => {
  let plugin: PluginMicrosoftGraphGatewayServer;
  let mockDb: any;
  let mockApp: any;
  let mockAuditLogsRepo: any;
  let mockQueueRepo: any;
  let mockApiKeysRepo: any;
  let createdAuditLogs: any[];
  let createdJobs: any[];

  beforeEach(() => {
    createdAuditLogs = [];
    createdJobs = [];

    mockAuditLogsRepo = {
      create: vi.fn().mockImplementation(async ({ values }: { values: any }) => {
        const record = { id: createdAuditLogs.length + 1, ...values };
        createdAuditLogs.push(record);
        return record;
      }),
      find: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    };

    mockQueueRepo = {
      create: vi.fn().mockImplementation(async ({ values }: { values: any }) => {
        const record = {
          id: createdJobs.length + 1,
          jobId: `mg_${randomUUID().slice(0, 8)}`,
          ...values,
          get: (key: string) => record[key],
          update: vi.fn().mockImplementation(async (up: any) => Object.assign(record, up)),
        };
        createdJobs.push(record);
        return record;
      }),
      findOne: vi.fn().mockImplementation(async ({ filter }: { filter: any }) => {
        if (filter?.idempotencyKey) {
          return createdJobs.find((j) => j.idempotencyKey === filter.idempotencyKey) || null;
        }
        return null;
      }),
      find: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue([1]),
    };

    const validKeyHash = createHash('sha256').update('mgk_validkey123456789').digest('hex');

    mockApiKeysRepo = {
      findOne: vi.fn().mockImplementation(async ({ filter }: { filter: any }) => {
        if (filter?.keyHash === validKeyHash && filter?.enabled) {
          return {
            get: (key: string) => {
              const data: Record<string, any> = {
                id: 'key_1',
                name: 'Production Key',
                keyPrefix: 'mgk_validkey',
                scopes: ['email:read', 'email:write', 'lists:read'],
                enabled: true,
              };
              return data[key];
            },
            update: vi.fn().mockResolvedValue(true),
          };
        }
        return null;
      }),
    };

    mockDb = {
      getRepository: vi.fn().mockImplementation((name: string) => {
        if (name === 'msGraphGatewayAuditLogs') return mockAuditLogsRepo;
        if (name === 'msGraphGatewayQueue') return mockQueueRepo;
        if (name === 'msGraphGatewayApiKeys') return mockApiKeysRepo;
        return { findOne: vi.fn(), create: vi.fn(), update: vi.fn(), find: vi.fn(), count: vi.fn() };
      }),
      on: vi.fn(),
    };

    mockApp = {
      db: mockDb,
      log: {
        child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
      },
      context: { reqId: 'test_req' },
      resourceManager: { define: vi.fn() },
      acl: { allow: vi.fn(), registerSnippet: vi.fn() },
      on: vi.fn(),
    };

    plugin = new PluginMicrosoftGraphGatewayServer(mockApp, { db: mockDb } as any);
  });

  const createContext = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body: Record<string, any> = {},
  ) => {
    const resHeaders: Record<string, string> = {};
    const ctx: any = {
      db: mockDb,
      request: {
        method,
        path,
        url: path,
        headers,
        body,
      },
      action: {
        params: { values: body },
      },
      state: {},
      ip: '127.0.0.1',
      status: 200,
      set: (key: string, val: string) => {
        resHeaders[key] = val;
      },
      throw: (status: number, msg: string) => {
        const err: any = new Error(msg);
        err.status = status;
        err.statusCode = status;
        throw err;
      },
    };
    return { ctx, resHeaders };
  };

  it('audits synchronous read requests with status 200, correlation ID, and metadata', async () => {
    const { ctx, resHeaders } = createContext(
      'POST',
      '/api/msGraphGateway:listMessages',
      { 'x-api-key': 'mgk_validkey123456789', 'user-agent': 'JestTest' },
      { user: 'user@example.com', folder: 'inbox' },
    );

    vi.spyOn(plugin as any, 'graphList').mockImplementation(async (c: Context, scope: any) => {
      await (plugin as any).authorize(c, scope);
      c.body = { data: [{ id: 'msg1' }] };
    });

    let actionHandler: any;
    mockApp.resourceManager.define.mockImplementation(({ actions }: any) => {
      actionHandler = actions.listMessages;
    });

    await plugin.load();
    await actionHandler(ctx, vi.fn());

    expect(resHeaders['X-Request-ID']).toBeDefined();
    expect(createdAuditLogs.length).toBe(1);

    const log = createdAuditLogs[0];
    expect(log.operation).toBe('listMessages');
    expect(log.status).toBe('succeeded');
    expect(log.httpStatus).toBe(200);
    expect(log.graphHttpStatus).toBe(200);
    expect(log.apiKeyName).toBe('Production Key');
    expect(log.apiKeyPrefix).toBe('mgk_validkey');
    expect(log.requestFields).toEqual(['folder', 'user']);
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    expect(log.details?.result).toBeUndefined();
    expect(log.result).toBeUndefined();
  });

  it('audits authentication (401) and authorization (403) rejections correctly', async () => {
    let actionsMap: any;
    mockApp.resourceManager.define.mockImplementation(({ actions }: any) => {
      actionsMap = actions;
    });
    await plugin.load();

    const { ctx: ctx401 } = createContext(
      'POST',
      '/api/msGraphGateway:listMessages',
      { 'x-api-key': 'mgk_invalidkey123456' },
      { user: 'user@example.com' },
    );
    await expect(actionsMap.listMessages(ctx401, vi.fn())).rejects.toThrow('Invalid API key');

    expect(createdAuditLogs.length).toBe(1);
    const log401 = createdAuditLogs[0];
    expect(log401.status).toBe('rejected');
    expect(log401.httpStatus).toBe(401);
    expect(log401.apiKeyPrefix).toBe('mgk_invalidk');

    const { ctx: ctxScope } = createContext('POST', '/api/msGraphGateway:uploadFile', {
      'x-api-key': 'mgk_validkey123456789',
    });
    await expect(actionsMap.uploadFile(ctxScope, vi.fn())).rejects.toThrow('API key scope drive:write is required');

    expect(createdAuditLogs.length).toBe(2);
    const log403 = createdAuditLogs[1];
    expect(log403.status).toBe('rejected');
    expect(log403.httpStatus).toBe(403);
    expect(log403.apiKeyName).toBe('Production Key');
  });

  it('redacts API keys, secrets, and tokens in audit error messages', async () => {
    let actionsMap: any;
    mockApp.resourceManager.define.mockImplementation(({ actions }: any) => {
      actionsMap = actions;
    });
    await plugin.load();

    const { ctx } = createContext(
      'POST',
      '/api/msGraphGateway:listMessages',
      { 'x-api-key': 'mgk_validkey123456789' },
      { user: 'user@example.com' },
    );

    vi.spyOn(plugin as any, 'graphList').mockImplementation(async () => {
      const err: any = new Error('Failed with access_token=secret_token_123 and mgk_validkey123456789');
      err.status = 502;
      throw err;
    });

    await expect(actionsMap.listMessages(ctx, vi.fn())).rejects.toThrow();

    expect(createdAuditLogs.length).toBe(1);
    const log = createdAuditLogs[0];
    expect(log.status).toBe('failed');
    expect(log.error).not.toContain('secret_token_123');
    expect(log.error).not.toContain('mgk_validkey123456789');
    expect(log.error).toContain('[REDACTED]');
  });

  it('audits enqueued async requests with status queued and idempotency key', async () => {
    let actionsMap: any;
    mockApp.resourceManager.define.mockImplementation(({ actions }: any) => {
      actionsMap = actions;
    });
    await plugin.load();

    const { ctx } = createContext(
      'POST',
      '/api/msGraphGateway:sendEmail',
      { 'x-api-key': 'mgk_validkey123456789', 'idempotency-key': 'idem_12345' },
      { user: 'user@example.com', message: { subject: 'Hello' } },
    );

    await actionsMap.sendEmail(ctx, vi.fn());

    expect(createdJobs.length).toBe(1);
    const job = createdJobs[0];
    expect(job.idempotencyKey).toBe('idem_12345');

    expect(createdAuditLogs.length).toBe(1);
    const log = createdAuditLogs[0];
    expect(log.operation).toBe('sendEmail');
    expect(log.status).toBe('queued');
    expect(log.httpStatus).toBe(200);
    expect(log.jobId).toBe(job.jobId);
    expect(log.idempotencyKey).toBe('idem_12345');
    expect(log.requestFields).toEqual(['message', 'user']);
    expect(log.details?.result).toBeUndefined();
  });

  it('audits background worker job execution transitions without storing response body', async () => {
    const jobModel: any = {
      get: (key: string) => {
        const d: Record<string, any> = {
          id: 1,
          jobId: 'mg_job123',
          operation: 'sendEmail',
          payload: { user: 'user@example.com' },
          idempotencyKey: 'idem_999',
        };
        return d[key];
      },
      update: vi.fn().mockResolvedValue(true),
    };

    const settingsModel: any = {
      get: (key: string) => (key === 'maxAttempts' ? 3 : 30),
    };

    vi.spyOn(plugin as any, 'execute').mockResolvedValue(null);

    await (plugin as any).processJob(jobModel, settingsModel, 1, Date.now() - 50);

    expect(createdAuditLogs.length).toBe(1);
    const logSuccess = createdAuditLogs[0];
    expect(logSuccess.jobId).toBe('mg_job123');
    expect(logSuccess.idempotencyKey).toBe('idem_999');
    expect(logSuccess.status).toBe('succeeded');
    expect(logSuccess.httpStatus).toBe(200);
    expect(logSuccess.graphHttpStatus).toBe(200);
    expect(logSuccess.attempt).toBe(1);
    expect(logSuccess.durationMs).toBeGreaterThanOrEqual(0);

    expect(jobModel.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded', result: null }));
  });
});
