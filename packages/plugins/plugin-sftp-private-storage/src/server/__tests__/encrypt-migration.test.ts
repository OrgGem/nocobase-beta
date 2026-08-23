import { describe, it, expect, vi } from 'vitest';
import { encryptSecret, isEncrypted, __resetSecretKeyCacheForTest } from '../secret-box';
import EncryptSftpSecrets from '../migrations/20260821000000-encrypt-sftp-secrets';

function createMigrationCtx(ephemeral: boolean) {
  const alreadyEncrypted = encryptSecret('already-encrypted-key');
  const records = [
    { id: 1, privateKey: '-----BEGIN RSA PRIVATE KEY-----\nplaintext\n-----END RSA PRIVATE KEY-----' },
    { id: 2, privateKey: alreadyEncrypted },
    { id: 3, privateKey: '' },
  ];
  const updates: Array<{ id: number; privateKey: unknown }> = [];
  const repository = {
    find: vi.fn().mockResolvedValue(records),
    update: vi.fn().mockImplementation((args: any) => {
      updates.push({ id: args.filterByTk, privateKey: args.values.privateKey });
      return Promise.resolve();
    }),
  };
  const mock = {
    db: {
      getCollection: vi.fn().mockReturnValue({ repository, getTableNameWithSchema: () => 'sftp_storage_configs' }),
      sequelize: { getQueryInterface: () => ({ describeTable: vi.fn().mockResolvedValue({}) }) },
    },
    log: { warn: vi.fn() },
  };
  if (ephemeral) delete process.env.SFTP_STORAGE_SECRET_KEY;
  else process.env.SFTP_STORAGE_SECRET_KEY = 'migration-key';
  return { mock, repository, updates, records };
}

describe('encrypt-sftp-secrets migration (privateKey at rest)', () => {
  beforeEach(() => { __resetSecretKeyCacheForTest(); });
  afterEach(() => { delete process.env.SFTP_STORAGE_SECRET_KEY; __resetSecretKeyCacheForTest(); });

  it('encrypts plaintext privateKey and skips empty values', async () => {
    const { mock, repository, updates } = createMigrationCtx(false);
    const migration = new EncryptSftpSecrets();
    await (migration as any).up.call(mock);
    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(isEncrypted(updates[0].privateKey as string)).toBe(true);
    expect(updates.map((u) => u.id)).toEqual([1]);
  });

  it('skips encryption entirely when the key is ephemeral', async () => {
    const fs = await import('fs');
    const existsSpy = vi.spyOn(fs.default ?? fs, 'existsSync').mockReturnValue(false);
    try {
      const { mock, repository } = createMigrationCtx(true);
      const migration = new EncryptSftpSecrets();
      await (migration as any).up.call(mock);
      expect(repository.update).not.toHaveBeenCalled();
      expect(mock.log.warn).toHaveBeenCalledWith(expect.stringContaining('ephemeral'));
    } finally {
      existsSpy.mockRestore();
    }
  });
});
