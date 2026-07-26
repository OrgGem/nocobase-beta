import type { Model } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import PluginSftpgoIntegrationServer from '../plugin';

type PluginApp = ConstructorParameters<typeof PluginSftpgoIntegrationServer>[0];

function createPlugin(variables: Record<string, string>, extras: Record<string, unknown> = {}) {
  const mockApp = {
    environment: {
      getVariable: (name: string) => variables[name],
    },
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
  async function captureBeforeSave(variables: Record<string, string>) {
    const handlers = new Map<string, (model: Model) => Promise<void>>();
    const plugin = createPlugin(variables, {
      db: {
        on: (event: string, handler: (model: Model) => Promise<void>) => {
          handlers.set(event, handler);
        },
      },
    });
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
});

describe('PluginSftpgoIntegrationServer.getClient', () => {
  function mockConnection(id: number): Model {
    const row: Record<string, unknown> = {
      id,
      baseUrl: '{{$env.SFTPGO_URL}}',
      authMethod: 'admin',
      username: 'admin',
      password: 'encrypted-password',
    };
    return { get: (field: string) => row[field] } as unknown as Model;
  }

  it('reuses the cached client until a referenced environment variable changes', async () => {
    const variables: Record<string, string> = { SFTPGO_URL: 'https://a.example.com' };
    const plugin = createPlugin(variables, {
      aesEncryptor: { decrypt: async (value: string) => value },
    });
    const connection = mockConnection(1);

    const first = await plugin.getClient(connection);
    expect(await plugin.getClient(connection)).toBe(first);

    variables.SFTPGO_URL = 'https://b.example.com';
    expect(await plugin.getClient(connection)).not.toBe(first);
  });
});
