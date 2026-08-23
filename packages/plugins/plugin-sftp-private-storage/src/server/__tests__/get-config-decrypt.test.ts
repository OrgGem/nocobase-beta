import { describe, it, expect, vi } from 'vitest';
import { PluginSftpPrivateStorageServer } from '../plugin';
import { encryptSecret } from '../secret-box';

function createPlugin(configValues: Record<string, unknown>) {
  const warn = vi.fn();
  const registerConfig = vi.fn();
  const connectionManager = { registerConfig, destroy: vi.fn(), unregisterConfig: vi.fn() };
  const app: any = {
    pm: { get: () => null },
    environment: null,
    context: { reqId: 'test' },
    log: { warn, info: vi.fn(), error: vi.fn(), child: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
    resourceManager: { registerActionHandler: vi.fn() },
    acl: { allow: vi.fn(), registerSnippet: vi.fn() },
    on: vi.fn(),
    db: {
      on: vi.fn(),
      getRepository: (name: string) => {
        if (name === 'sftpStorageConfigs') {
          return {
            findOne: vi.fn().mockResolvedValue({
              get: (key: string) => configValues[key],
              toJSON: () => configValues,
            }),
          };
        }
        return { findOne: vi.fn().mockResolvedValue(null) };
      },
    },
  };
  const plugin = new PluginSftpPrivateStorageServer(app, {
    name: 'plugin-sftp-private-storage',
    packageName: 'plugin-sftp-private-storage',
  });
  plugin.connectionManager = connectionManager;
  return { plugin, warn, registerConfig };
}

describe('getConfigByName decryption containment', () => {
  afterEach(() => {
    delete process.env.SFTP_STORAGE_SECRET_KEY;
  });

  it('decrypts an encrypted password with the configured key', async () => {
    process.env.SFTP_STORAGE_SECRET_KEY = 'correct-key';
    const { plugin } = createPlugin({ id: 7, name: 'sftp-a', password: encryptSecret('hunter2') });
    const cfg = await plugin.getConfigByName('sftp-a');
    expect(cfg?.password).toBe('hunter2');
  });

  it('returns null instead of throwing when the ciphertext cannot be decrypted', async () => {
    process.env.SFTP_STORAGE_SECRET_KEY = 'correct-key';
    const withWrongKey = encryptSecret('hunter2');

    // Rotate the key after encryption to simulate a mismatch.
    process.env.SFTP_STORAGE_SECRET_KEY = 'rotated-key';
    const { plugin, warn } = createPlugin({ id: 7, name: 'sftp-a', password: withWrongKey });

    const cfg = await plugin.getConfigByName('sftp-a');
    expect(cfg).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unable to decrypt credentials'));
  });
});
