// SPDX-License-Identifier: Apache-2.0

import type { Model } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import { Environment } from '../../../../../core/server/src/environment';
import PluginSftpgoIntegrationServer from '../plugin';

type PluginApp = ConstructorParameters<typeof PluginSftpgoIntegrationServer>[0];

function createPlugin(
  variables: Record<string, string>,
  extras: Record<string, unknown> = {},
  secrets: Record<string, string> = {},
) {
  const environment = new Environment();
  for (const [name, value] of Object.entries(variables)) {
    environment.setVariable(name, value);
  }
  for (const [name, value] of Object.entries(secrets)) {
    environment.setVariable(name, value, { isSecret: true });
  }
  const mockApp = {
    environment,
    ...extras,
  };
  return new PluginSftpgoIntegrationServer(mockApp as unknown as PluginApp);
}

describe('PluginSftpgoIntegrationServer.resolveEnv', () => {
  it('resolves {{$env.VAR}} with optional whitespace', () => {
    const plugin = createPlugin({ SFTPGO_HOST: 'https://sftp.example.com', SFTPGO_USER: 'admin_user' });
    expect(plugin.resolveEnv('{{$env.SFTPGO_HOST}}')).toBe('https://sftp.example.com');
    expect(plugin.resolveEnv('{{ $env.SFTPGO_USER }}')).toBe('admin_user');
  });

  it('resolves templates embedded in a longer value', () => {
    const plugin = createPlugin({ SFTPGO_HOST: 'sftp.example.com' });
    expect(plugin.resolveEnv('https://{{$env.SFTPGO_HOST}}:8080')).toBe('https://sftp.example.com:8080');
  });

  it('does not fall back to process.env for unregistered variables', () => {
    process.env.SFTPGO_LEAK_TEST = 'leaked-secret';
    try {
      const plugin = createPlugin({});
      expect(plugin.resolveEnv('{{$env.SFTPGO_LEAK_TEST}}')).toBe('{{$env.SFTPGO_LEAK_TEST}}');
    } finally {
      delete process.env.SFTPGO_LEAK_TEST;
    }
  });

  it('keeps unknown variables untouched', () => {
    const plugin = createPlugin({});
    expect(plugin.resolveEnv('{{$env.NON_EXISTENT_VAR}}')).toBe('{{$env.NON_EXISTENT_VAR}}');
  });

  it('resolves secret variables only when explicitly enabled for credentials', () => {
    const plugin = createPlugin({}, {}, { SFTPGO_API_KEY: 'private-api-key' });

    expect(plugin.resolveEnv('{{$env.SFTPGO_API_KEY}}')).toBe('{{$env.SFTPGO_API_KEY}}');
    expect(plugin.resolveEnv('{{$env.SFTPGO_API_KEY}}', true)).toBe('private-api-key');
  });

  it('never rewrites bare $env / process.env / {{env.*}} substrings inside literal values', () => {
    const plugin = createPlugin({ USER: 'admin' });
    expect(plugin.resolveEnv('pa$env.USERword')).toBe('pa$env.USERword');
    expect(plugin.resolveEnv('process.env.USER')).toBe('process.env.USER');
    expect(plugin.resolveEnv('{{env.USER}}')).toBe('{{env.USER}}');
  });

  it('returns null/undefined/plain values unchanged', () => {
    const plugin = createPlugin({});
    expect(plugin.resolveEnv(null)).toBeNull();
    expect(plugin.resolveEnv(undefined)).toBeUndefined();
    expect(plugin.resolveEnv('https://plain-url.com')).toBe('https://plain-url.com');
  });
});

describe('sftpgoConnections.beforeSave baseUrl validation', () => {
  type BeforeSaveHandler = (model: Model, options?: { context?: unknown }) => Promise<void>;

  async function captureBeforeSave(variables: Record<string, string>, secrets: Record<string, string> = {}) {
    const handlers = new Map<string, BeforeSaveHandler>();
    const plugin = createPlugin(
      variables,
      {
        aesEncryptor: {
          encrypt: async (value: string) => `encrypted:${value}`,
          decrypt: async (value: string) => value,
        },
        db: {
          on: (event: string, handler: (model: Model) => Promise<void>) => {
            handlers.set(event, handler as BeforeSaveHandler);
          },
        },
      },
      secrets,
    );
    await plugin.beforeLoad();
    const handler = handlers.get('sftpgoConnections.beforeSave');
    if (!handler) throw new Error('sftpgoConnections.beforeSave handler was not registered');
    return handler;
  }

  function mockConnectionModel(baseUrl: string): Model {
    return {
      changed: (field: string) => field === 'baseUrl',
      get: (field: string) => (field === 'baseUrl' ? baseUrl : null),
      set: () => undefined,
    } as unknown as Model;
  }

  function mockCredentialConnection(changes: Record<string, unknown>, changedFields: string[]) {
    const values: Record<string, unknown> = { ...changes };
    return {
      isNewRecord: true,
      changed: (field: string) => changedFields.includes(field),
      get: (field: string) => values[field] ?? null,
      set: (field: string, value: unknown) => {
        values[field] = value;
      },
    } as unknown as Model;
  }

  it('accepts a baseUrl template that resolves to a valid http(s) address', async () => {
    const handler = await captureBeforeSave({ SFTPGO_URL: 'https://sftp.example.com' });
    await expect(handler(mockConnectionModel('{{$env.SFTPGO_URL}}'))).resolves.toBeUndefined();
  });

  it('rejects a baseUrl template whose variable is unknown', async () => {
    const handler = await captureBeforeSave({});
    await expect(handler(mockConnectionModel('{{$env.MISSING_URL}}'))).rejects.toThrow(/Invalid SFTPGo base URL/);
  });

  it('rejects a template that resolves to a non-http(s) address', async () => {
    const handler = await captureBeforeSave({ SFTPGO_URL: 'ftp://sftp.example.com' });
    await expect(handler(mockConnectionModel('{{$env.SFTPGO_URL}}'))).rejects.toThrow(/must use http or https/);
  });

  it('does not include an expanded secret in an invalid base URL error', async () => {
    const secretUrl = 'https://private-secret.example.com:invalid';
    const handler = await captureBeforeSave({ SFTPGO_URL: secretUrl });
    const error = await handler(mockConnectionModel('{{$env.SFTPGO_URL}}')).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Invalid SFTPGo base URL/);
    expect((error as Error).message).not.toContain(secretUrl);
  });

  it('requires unscoped environment variable update permission to bind credential references', async () => {
    const handler = await captureBeforeSave({}, { SFTPGO_API_KEY: 'private-api-key' });
    const permissionDenied = vi.fn((status: number, message: string) => {
      throw new Error(`${status}: ${message}`);
    });
    const context = { can: vi.fn().mockReturnValue(null), throw: permissionDenied };
    const model = mockCredentialConnection(
      { authMethod: 'apikey', baseUrl: 'https://sftp.example.com', apiKey: '{{$env.SFTPGO_API_KEY}}' },
      ['apiKey'],
    );

    await expect(handler(model, { context })).rejects.toThrow('Permission denied');
    expect(context.can).toHaveBeenCalledWith({ resource: 'environmentVariables', action: 'update' });
  });

  it('requires environment variable update permission before redirecting a connection with an existing credential reference', async () => {
    const handler = await captureBeforeSave({}, { SFTPGO_API_KEY: 'private-api-key' });
    const context = {
      can: vi.fn().mockReturnValue({ params: { filter: { name: 'safe-key' } } }),
      throw: (status: number, message: string) => {
        throw new Error(`${status}: ${message}`);
      },
    };
    const model = mockCredentialConnection(
      { authMethod: 'apikey', baseUrl: 'https://attacker.example.com', apiKey: '{{$env.SFTPGO_API_KEY}}' },
      ['baseUrl'],
    );

    await expect(handler(model, { context })).rejects.toThrow('Permission denied');
    expect(context.can).toHaveBeenCalledWith({ resource: 'environmentVariables', action: 'update' });
  });
});

describe('PluginSftpgoIntegrationServer.getClient', () => {
  function mockConnection(id: number, overrides: Record<string, unknown> = {}): Model {
    const row: Record<string, unknown> = {
      id,
      baseUrl: 'https://sftp.example.com',
      authMethod: 'admin',
      username: 'admin',
      password: 'encrypted-password',
      ...overrides,
    };
    return { get: (field: string) => row[field] } as unknown as Model;
  }

  it('reuses the cached client until a referenced environment variable changes', async () => {
    const environment = new Environment();
    environment.setVariable('SFTPGO_URL', 'https://a.example.com');
    const plugin = new PluginSftpgoIntegrationServer({
      environment,
      aesEncryptor: { decrypt: async (value: string) => value },
    } as unknown as PluginApp);
    const connection = mockConnection(1, { baseUrl: '{{$env.SFTPGO_URL}}' });

    const first = await plugin.getClient(connection);
    expect(await plugin.getClient(connection)).toBe(first);

    environment.setVariable('SFTPGO_URL', 'https://b.example.com');
    expect(await plugin.getClient(connection)).not.toBe(first);
  });

  it('requires unscoped environment update permission for legacy secret references, including cache hits', async () => {
    const environment = new Environment();
    environment.setVariable('SFTPGO_API_KEY', 'private-api-key', { isSecret: true });
    const plugin = new PluginSftpgoIntegrationServer({
      environment,
      aesEncryptor: { decrypt: async (value: string) => value },
    } as unknown as PluginApp);
    const connection = mockConnection(1, {
      authMethod: 'apikey',
      apiKey: '{{$env.SFTPGO_API_KEY}}',
      password: null,
    });
    const permittedContext = { can: () => ({ params: {} }) };

    const client = await plugin.getClient(connection, permittedContext);
    await expect(plugin.getClient(connection)).rejects.toThrow('Permission denied');
    await expect(plugin.getClient(connection, permittedContext)).resolves.toBe(client);
  });

  it('allows non-secret credential references without environment update permission', async () => {
    const environment = new Environment();
    environment.setVariable('SFTPGO_API_KEY', 'shared-api-key');
    const plugin = new PluginSftpgoIntegrationServer({
      environment,
      aesEncryptor: { decrypt: async (value: string) => value },
    } as unknown as PluginApp);
    const connection = mockConnection(1, {
      authMethod: 'apikey',
      apiKey: '{{$env.SFTPGO_API_KEY}}',
      password: null,
    });

    await expect(plugin.getClient(connection)).resolves.toBeDefined();
  });

  it('does not resolve or authorize a secret reference in the inactive auth method credential', async () => {
    const environment = new Environment();
    environment.setVariable('SFTPGO_API_KEY', 'private-api-key', { isSecret: true });
    const plugin = new PluginSftpgoIntegrationServer({
      environment,
      aesEncryptor: { decrypt: async (value: string) => value },
    } as unknown as PluginApp);
    const connection = mockConnection(1, {
      authMethod: 'admin',
      username: 'admin',
      password: 'admin-password',
      apiKey: '{{$env.SFTPGO_API_KEY}}',
    });

    await expect(plugin.getClient(connection)).resolves.toBeDefined();
  });
});
