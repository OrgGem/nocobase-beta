import { createMockServer } from '@nocobase/test';

describe('HashiCorp Vault integration plugin smoke', () => {
  let app;

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads and registers collections', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'hashicorp-vault-integration'],
    });

    expect(app).toBeTruthy();
    expect(app.db.getCollection('vaultConnections')).toBeTruthy();
    expect(app.db.getCollection('vaultSecretMappings')).toBeTruthy();
  });

  it('encrypts credentials at rest and validates mappings', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'hashicorp-vault-integration'],
    });

    const connectionRepo = app.db.getRepository('vaultConnections');
    const connection = await connectionRepo.create({
      values: {
        name: 'test-vault',
        address: 'https://vault.example.com:8200',
        authMethod: 'token',
        token: 'hvs.plaintext-token-value-123456',
      },
    });
    expect(connection.get('token')).toBeTruthy();
    expect(connection.get('token')).not.toBe('hvs.plaintext-token-value-123456');

    await expect(
      connectionRepo.create({
        values: { name: 'bad-address', address: 'ftp://vault.example.com', authMethod: 'token', token: 'x' },
      }),
    ).rejects.toThrow();

    const mappingRepo = app.db.getRepository('vaultSecretMappings');
    await expect(
      mappingRepo.create({
        values: {
          connectionId: connection.get('id'),
          variableKey: '1invalid-key',
          secretPath: 'apps/billing',
          secretKey: 'password',
        },
      }),
    ).rejects.toThrow();

    await expect(
      mappingRepo.create({
        values: {
          connectionId: connection.get('id'),
          variableKey: 'DB_PASSWORD',
          secretPath: '../escape',
          secretKey: 'password',
        },
      }),
    ).rejects.toThrow();

    const mapping = await mappingRepo.create({
      values: {
        connectionId: connection.get('id'),
        variableKey: 'DB_PASSWORD',
        secretPath: 'apps/billing',
        secretKey: 'password',
      },
    });
    expect(mapping.get('exposeToClient')).toBeFalsy();
  });
});
