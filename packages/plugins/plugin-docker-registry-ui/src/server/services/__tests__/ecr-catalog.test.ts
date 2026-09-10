import { describe, expect, it, vi } from 'vitest';
import { RegistryRequestError } from '../registry-client';
import { EcrCatalogProvider, type EcrCatalogClientFactory, type EcrCatalogClientLike } from '../ecr-catalog';

interface MockSetup {
  send: ReturnType<typeof vi.fn>;
  configs: Array<{ region: string; credentials?: unknown }>;
}

function mockClient(handler: (command: unknown) => unknown): {
  createClient: EcrCatalogClientFactory;
  mock: MockSetup;
} {
  const mock: MockSetup = { send: vi.fn(), configs: [] };
  mock.send.mockImplementation(async (command: unknown) => handler(command));
  const createClient: EcrCatalogClientFactory = (config) => {
    mock.configs.push(config);
    return { send: mock.send } as EcrCatalogClientLike;
  };
  return { createClient, mock };
}

function provider(createClient: EcrCatalogClientFactory) {
  return new EcrCatalogProvider({ region: 'ap-southeast-1', createClient });
}

function commandInput(command: unknown): Record<string, unknown> {
  return (command as { input?: Record<string, unknown> }).input ?? {};
}

describe('EcrCatalogProvider', () => {
  it('maps DescribeRepositories into a RegistryListResult with nextCursor', async () => {
    const { createClient, mock } = mockClient((command) => {
      expect(commandInput(command)).toEqual({});
      return {
        repositories: [{ repositoryName: 'team/api' }, { repositoryName: 'team/worker' }],
        nextToken: 'page-2',
      };
    });
    await expect(provider(createClient).listRepositoriesPage()).resolves.toEqual({
      items: ['team/api', 'team/worker'],
      nextCursor: 'page-2',
    });
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it('passes nextToken through to DescribeRepositories and omits nextCursor on the last page', async () => {
    const { createClient } = mockClient((command) => {
      expect(commandInput(command)).toEqual({ nextToken: 'page-2' });
      return { repositories: [{ repositoryName: 'team/api' }] };
    });
    await expect(provider(createClient).listRepositoriesPage('page-2')).resolves.toEqual({
      items: ['team/api'],
      nextCursor: undefined,
    });
  });

  it('drops repositories without a usable name', async () => {
    const { createClient } = mockClient(() => ({
      repositories: [{ repositoryName: 'team/api' }, { repositoryName: '' }, {}, { repositoryName: 'team/worker' }],
    }));
    await expect(provider(createClient).listRepositoriesPage()).resolves.toEqual({
      items: ['team/api', 'team/worker'],
      nextCursor: undefined,
    });
  });

  it('maps ListImages tags and filters out untagged images', async () => {
    const { createClient } = mockClient((command) => {
      expect(commandInput(command)).toEqual({ repositoryName: 'team/api' });
      return {
        imageDetails: [{ imageTags: ['latest'] }, { imageTags: [undefined] }, {}, { imageTags: ['stable', ''] }],
      };
    });
    await expect(provider(createClient).listTagsPage('team/api')).resolves.toEqual({
      items: ['latest', 'stable'],
      nextCursor: undefined,
    });
  });

  it('passes repository and nextToken to ListImages and maps nextCursor', async () => {
    const { createClient } = mockClient((command) => {
      expect(commandInput(command)).toEqual({ repositoryName: 'team/api', nextToken: 'tags-2' });
      return { imageDetails: [{ imageTags: ['v2'] }], nextToken: 'tags-3' };
    });
    await expect(provider(createClient).listTagsPage('team/api', 'tags-2')).resolves.toEqual({
      items: ['v2'],
      nextCursor: 'tags-3',
    });
  });

  it('returns an empty list when ECR responds with no imageDetails', async () => {
    const { createClient } = mockClient(() => ({}));
    await expect(provider(createClient).listTagsPage('team/api')).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });
  });

  it('wraps DescribeRepositories failures in RegistryRequestError with ECR_CATALOG_FAILED', async () => {
    const { createClient } = mockClient(() => {
      throw new Error('AccessDenied');
    });
    await expect(provider(createClient).listRepositoriesPage()).rejects.toMatchObject({
      name: 'RegistryRequestError',
      status: 502,
      code: 'ECR_CATALOG_FAILED',
      message: expect.stringContaining('DescribeRepositories'),
    });
    await expect(provider(createClient).listRepositoriesPage()).rejects.toBeInstanceOf(RegistryRequestError);
  });

  it('wraps ListImages failures in RegistryRequestError with ECR_CATALOG_FAILED', async () => {
    const { createClient } = mockClient(() => {
      throw new Error('RepositoryNotFoundException');
    });
    await expect(provider(createClient).listTagsPage('missing/repo')).rejects.toMatchObject({
      status: 502,
      code: 'ECR_CATALOG_FAILED',
      message: expect.stringContaining('ListImages'),
    });
  });

  it('passes static credentials through to the client factory', async () => {
    const { createClient, mock } = mockClient(() => ({ repositories: [] }));
    const catalog = new EcrCatalogProvider({
      region: 'ap-southeast-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      createClient,
    });
    await catalog.listRepositoriesPage();
    expect(mock.configs[0]).toMatchObject({
      region: 'ap-southeast-1',
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    });
  });
});
