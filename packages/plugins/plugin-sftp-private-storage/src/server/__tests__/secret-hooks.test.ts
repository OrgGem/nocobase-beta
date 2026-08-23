import { vi } from 'vitest';
import { PluginSftpPrivateStorageServer } from '../plugin';
import { encryptSecret, isEncrypted } from '../secret-box';

function createPlugin() {
  const beforeSaveHandlers: Array<(model: any) => void> = [];
  const afterSaveHandlers: Array<(model: any) => void> = [];
  const afterDestroyHandlers: Array<(model: any) => void> = [];
  const childLog = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const app: any = {
    pm: { get: () => ({ registerStorageType: () => {} }) },
    resourceManager: {
      registerActionHandler: vi.fn(),
      define: vi.fn(),
    },
    acl: {
      allow: vi.fn(),
      registerSnippet: vi.fn(),
    },
    on: vi.fn(),
    environment: null,
    context: { reqId: 'test' },
    log: {
      child: () => childLog,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    db: {
      on: (event: string, handler: (model: any) => void) => {
        if (event === 'sftpStorageConfigs.beforeSave') {
          beforeSaveHandlers.push(handler);
        } else if (event === 'sftpStorageConfigs.afterSave') {
          afterSaveHandlers.push(handler);
        } else if (event === 'sftpStorageConfigs.afterDestroy') {
          afterDestroyHandlers.push(handler);
        }
      },
    },
  };
  const plugin = new PluginSftpPrivateStorageServer(app, {
    name: 'plugin-sftp-private-storage',
    packageName: 'plugin-sftp-private-storage',
  });
  return { plugin, beforeSaveHandlers, afterSaveHandlers, afterDestroyHandlers, childLog };
}

describe('sftpStorageConfigs secret encryption hooks', () => {
  beforeEach(() => {
    process.env.SFTP_STORAGE_SECRET_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.SFTP_STORAGE_SECRET_KEY;
  });

  it('registers a beforeSave hook that encrypts password and passphrase', async () => {
    const { plugin, beforeSaveHandlers } = createPlugin();
    await plugin.load();

    expect(beforeSaveHandlers).toHaveLength(1);

    const model = {
      data: { password: 'my-secret', passphrase: 'my-passphrase', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----', username: 'u' },
      get(key: string) {
        return this.data[key];
      },
      set(key: string, value: unknown) {
        this.data[key] = value;
      },
    };

    beforeSaveHandlers[0](model);

    expect(isEncrypted(model.get('password'))).toBe(true);
    expect(isEncrypted(model.get('passphrase'))).toBe(true);
    expect(isEncrypted(model.get('privateKey'))).toBe(true);
    // Non-secret fields untouched
    expect(model.get('username')).toEqual('u');
  });

  it('does not double-encrypt values already encrypted', async () => {
    const { plugin, beforeSaveHandlers } = createPlugin();
    await plugin.load();

    const preEncrypted = encryptSecret('already-encrypted');
    const model = {
      data: { password: preEncrypted },
      get(key: string) {
        return this.data[key];
      },
      set(key: string, value: unknown) {
        this.data[key] = value;
      },
    };

    beforeSaveHandlers[0](model);
    expect(model.get('password')).toEqual(preEncrypted);
  });

  it('unregisters pooled connections when a config is disabled or destroyed', async () => {
    const { plugin, afterSaveHandlers, afterDestroyHandlers } = createPlugin();
    await plugin.load();

    expect(afterSaveHandlers).toHaveLength(1);
    expect(afterDestroyHandlers).toHaveLength(1);

    const unregister = vi.fn();
    plugin.connectionManager = { unregisterConfig: unregister } as any;

    const disabledModel = {
      data: { id: 11, enabled: false },
      get(key: string) {
        return this.data[key];
      },
    };
    afterSaveHandlers[0](disabledModel);
    expect(unregister).toHaveBeenCalledWith(11);

    const enabledModel = {
      data: { id: 12, enabled: true },
      get(key: string) {
        return this.data[key];
      },
    };
    afterSaveHandlers[0](enabledModel);
    expect(unregister).toHaveBeenCalledTimes(1);

    afterDestroyHandlers[0](disabledModel);
    expect(unregister).toHaveBeenCalledTimes(2);
  });

  it('warns when only an ephemeral key is available', async () => {
    delete process.env.SFTP_STORAGE_SECRET_KEY;
    // Simulate an environment without a persisted JWT secret file so key
    // resolution falls through to the ephemeral path.
    const fs = await import('fs');
    const existsSpy = vi.spyOn(fs.default ?? fs, 'existsSync').mockReturnValue(false);
    const { plugin, childLog } = createPlugin();
    try {
      await plugin.load();
      expect(childLog.warn).toHaveBeenCalledWith(expect.stringContaining('ephemeral encryption key'));
    } finally {
      existsSpy.mockRestore();
    }
  });
});
