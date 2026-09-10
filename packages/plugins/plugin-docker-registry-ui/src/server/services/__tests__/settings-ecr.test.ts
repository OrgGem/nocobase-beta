import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@nocobase/actions';
import {
  getRegistryConnection,
  getSafeSettings,
  RegistryConfigurationError,
  updateRegistrySettings,
} from '../settings';

interface MockRow {
  id?: number;
  [key: string]: unknown;
}

function createContext(initialRow: MockRow | null): {
  ctx: Context;
  row: () => MockRow | null;
  updateCalls: Array<{ filterByTk: number; values: Record<string, unknown> }>;
  createCalls: Array<{ values: Record<string, unknown> }>;
} {
  let currentRow: MockRow | null = initialRow ? { ...initialRow } : null;
  const updateCalls: Array<{ filterByTk: number; values: Record<string, unknown> }> = [];
  const createCalls: Array<{ values: Record<string, unknown> }> = [];

  const repository = {
    findOne: vi.fn(async () => currentRow),
    create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => {
      createCalls.push({ values });
      currentRow = { id: 1, ...values };
      return currentRow;
    }),
    update: vi.fn(async ({ filterByTk, values }: { filterByTk: number; values: Record<string, unknown> }) => {
      updateCalls.push({ filterByTk, values });
      currentRow = { ...(currentRow ?? {}), id: filterByTk, ...values };
      return [currentRow];
    }),
  };

  const encryptor = {
    encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
    decrypt: vi.fn(async (value: string) => value.replace(/^encrypted:/, '')),
  };

  const ctx = {
    db: { getRepository: () => repository },
    app: { aesEncryptor: encryptor },
    action: { params: {} },
    request: { body: {} },
  } as unknown as Context;

  return { ctx, row: () => currentRow, updateCalls, createCalls };
}

const BASE_ROW: MockRow = {
  id: 1,
  displayName: 'Docker Registry',
  registryUrl: 'https://123456789012.dkr.ecr.ap-southeast-1.amazonaws.com',
  publicRegistryHost: '',
  credentialMode: 'anonymous',
  username: '',
  awsRegion: '',
  awsRoleArn: '',
  verifyTls: true,
  allowInsecureHttp: false,
  caCertificate: '',
  clientCertificate: '',
  requestTimeoutMs: 10000,
  catalogPageSize: 100,
  maxConcurrentRequests: 5,
  autoRefreshSeconds: 0,
  deleteEnabled: false,
  rawManifestEnabled: true,
  showLegacySchema1: false,
  maxTransferSizeMb: 4096,
  uploadChunkSizeMb: 4,
  transferTimeoutMs: 600000,
  maxDownloadSpeedKbps: 0,
  maxUploadSpeedKbps: 0,
};

function updateContext(row: MockRow | null, values: Record<string, unknown>) {
  const created = createContext(row);
  (created.ctx.action as { params: { values: Record<string, unknown> } }).params.values = values;
  return created;
}

describe('settings service — ECR credential mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts credentialMode=ecr when awsRegion is provided', async () => {
    const { ctx, row } = updateContext(BASE_ROW, { credentialMode: 'ecr', awsRegion: 'ap-southeast-1' });
    const result = await updateRegistrySettings(ctx);
    expect(result.credentialMode).toBe('ecr');
    expect(result.awsRegion).toBe('ap-southeast-1');
    expect(row()?.credentialMode).toBe('ecr');
  });

  it('rejects credentialMode=ecr without awsRegion', async () => {
    const { ctx } = updateContext(BASE_ROW, { credentialMode: 'ecr' });
    await expect(updateRegistrySettings(ctx)).rejects.toThrow(RegistryConfigurationError);
    await expect(updateRegistrySettings(ctx)).rejects.toThrow('AWS region is required for ECR registries');
  });

  it('trims awsRegion and awsRoleArn values', async () => {
    const { ctx } = updateContext(BASE_ROW, {
      credentialMode: 'ecr',
      awsRegion: '  ap-southeast-1  ',
      awsRoleArn: '  arn:aws:iam::123456789012:role/example-role  ',
    });
    const result = await updateRegistrySettings(ctx);
    expect(result.awsRegion).toBe('ap-southeast-1');
    expect(result.awsRoleArn).toBe('arn:aws:iam::123456789012:role/example-role');
  });

  it('rejects an awsRoleArn that is not an IAM role ARN', async () => {
    const { ctx } = updateContext(BASE_ROW, {
      credentialMode: 'ecr',
      awsRegion: 'ap-southeast-1',
      awsRoleArn: 'arn:aws:s3:::some-bucket',
    });
    await expect(updateRegistrySettings(ctx)).rejects.toThrow(RegistryConfigurationError);
  });

  it('accepts china and govcloud role ARN partitions', async () => {
    const partitions = [
      'arn:aws-cn:iam::123456789012:role/example-role',
      'arn:aws-us-gov:iam::123456789012:role/example-role',
    ];
    for (const awsRoleArn of partitions) {
      const { ctx } = updateContext(BASE_ROW, { credentialMode: 'ecr', awsRegion: 'cn-north-1', awsRoleArn });
      await expect(updateRegistrySettings(ctx)).resolves.toMatchObject({ awsRoleArn });
    }
  });

  it('exposes hasAwsAccessKeyId and hasAwsSecretAccessKey without leaking secrets', async () => {
    const { ctx } = createContext({
      ...BASE_ROW,
      credentialMode: 'ecr',
      awsRegion: 'ap-southeast-1',
      awsAccessKeyIdCiphertext: 'encrypted:AKIA_TEST',
      awsSecretAccessKeyCiphertext: 'encrypted:secret',
    });
    const settings = await getSafeSettings(ctx);
    expect(settings.hasAwsAccessKeyId).toBe(true);
    expect(settings.hasAwsSecretAccessKey).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('AKIA_TEST');
  });

  it('reports hasAwsAccessKeyId=false when no ciphertext is stored', async () => {
    const { ctx } = createContext(BASE_ROW);
    const settings = await getSafeSettings(ctx);
    expect(settings.hasAwsAccessKeyId).toBe(false);
    expect(settings.hasAwsSecretAccessKey).toBe(false);
  });

  it('decrypts stored AWS secrets in getRegistryConnection', async () => {
    const { ctx } = createContext({
      ...BASE_ROW,
      credentialMode: 'ecr',
      awsRegion: 'ap-southeast-1',
      awsAccessKeyIdCiphertext: 'encrypted:AKIA_TEST',
      awsSecretAccessKeyCiphertext: 'encrypted:secret',
    });
    const connection = await getRegistryConnection(ctx);
    expect(connection.awsAccessKeyId).toBe('AKIA_TEST');
    expect(connection.awsSecretAccessKey).toBe('secret');
    expect(connection.awsRegion).toBe('ap-southeast-1');
  });

  it('prefers override AWS secrets and honours clear flags in getRegistryConnection', async () => {
    const { ctx } = createContext({
      ...BASE_ROW,
      credentialMode: 'ecr',
      awsRegion: 'ap-southeast-1',
      awsAccessKeyIdCiphertext: 'encrypted:AKIA_TEST',
      awsSecretAccessKeyCiphertext: 'encrypted:secret',
    });
    const overridden = await getRegistryConnection(ctx, { awsAccessKeyId: 'AKIA_OVERRIDE' });
    expect(overridden.awsAccessKeyId).toBe('AKIA_OVERRIDE');
    expect(overridden.awsSecretAccessKey).toBe('secret');

    const cleared = await getRegistryConnection(ctx, { clearAwsSecretAccessKey: true });
    expect(cleared.awsSecretAccessKey).toBeUndefined();
    expect(cleared.awsAccessKeyId).toBe('AKIA_TEST');
  });

  it('encrypts AWS secrets when saving settings', async () => {
    const { ctx, updateCalls } = updateContext(BASE_ROW, {
      credentialMode: 'ecr',
      awsRegion: 'ap-southeast-1',
      awsAccessKeyId: 'AKIA_TEST',
      awsSecretAccessKey: 'secret',
    });
    await updateRegistrySettings(ctx);
    expect(updateCalls[0].values).toMatchObject({
      awsAccessKeyIdCiphertext: 'encrypted:AKIA_TEST',
      awsSecretAccessKeyCiphertext: 'encrypted:secret',
    });
    expect(JSON.stringify(updateCalls[0].values)).not.toContain('"awsAccessKeyId":"AKIA_TEST"');
  });

  it('nulls stored AWS secret ciphertext when a clear flag is set', async () => {
    const { ctx, updateCalls } = updateContext(
      { ...BASE_ROW, awsAccessKeyIdCiphertext: 'encrypted:AKIA_TEST' },
      { credentialMode: 'ecr', awsRegion: 'ap-southeast-1', clearAwsAccessKeyId: true },
    );
    await updateRegistrySettings(ctx);
    expect(updateCalls[0].values.awsAccessKeyIdCiphertext).toBeNull();
  });

  it('keeps stored AWS secret ciphertext when the field is left blank', async () => {
    const { ctx, updateCalls } = updateContext(
      { ...BASE_ROW, awsAccessKeyIdCiphertext: 'encrypted:AKIA_TEST' },
      { credentialMode: 'ecr', awsRegion: 'ap-southeast-1' },
    );
    await updateRegistrySettings(ctx);
    expect(updateCalls[0].values.awsAccessKeyIdCiphertext).toBeUndefined();
  });
});
