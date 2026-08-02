import { createRequestMethodPolicy } from '../middlewares/request-method-policy';
import { createResourceMutationPolicy, isProtectedGenericMutation } from '../middlewares/resource-mutation-policy';

function context(input: {
  resourceName: string;
  actionName: string;
  method?: string;
  params?: Record<string, unknown>;
  targetCollection?: string;
}) {
  const headers = new Map<string, string>();
  return {
    ...input,
    headers,
    action: {
      resourceName: input.resourceName,
      actionName: input.actionName,
      params: input.params || {},
    },
    getCurrentRepository: input.targetCollection
      ? () => ({ targetCollection: { name: input.targetCollection } })
      : undefined,
    set(name: string, value: string) {
      headers.set(name, value);
    },
    throw(status: number, message: string) {
      throw Object.assign(new Error(message), { status });
    },
  };
}

describe('skill registry request policies', () => {
  it('allows read-only public methods and rejects public writes', async () => {
    const middleware = createRequestMethodPolicy();
    const allowed = context({ resourceName: 'skillRegistryPublic', actionName: 'download', method: 'GET' });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(allowed as never, next);

    expect(next).toHaveBeenCalledOnce();

    const rejected = context({ resourceName: 'skillRegistryPublic', actionName: 'list', method: 'POST' });
    await expect(middleware(rejected as never, next)).rejects.toMatchObject({ status: 405 });
    expect(rejected.headers.get('Allow')).toBe('GET, HEAD');

    const headDownload = context({ resourceName: 'skillRegistryPublic', actionName: 'download', method: 'HEAD' });
    await expect(middleware(headDownload as never, next)).rejects.toMatchObject({
      code: 'METHOD_NOT_ALLOWED',
      status: 405,
    });
    expect(headDownload.headers.get('Allow')).toBe('GET');
  });

  it('requires POST for every registry admin command', async () => {
    const middleware = createRequestMethodPolicy();
    const next = vi.fn().mockResolvedValue(undefined);
    const rejected = context({ resourceName: 'skillRegistryAdmin', actionName: 'yank', method: 'GET' });

    await expect(middleware(rejected as never, next)).rejects.toMatchObject({ status: 405 });
    expect(rejected.headers.get('Allow')).toBe('POST');

    const rejectedSettingsUpdate = context({
      resourceName: 'skillRegistryAdmin',
      actionName: 'updateSettings',
      method: 'GET',
    });
    await expect(middleware(rejectedSettingsUpdate as never, next)).rejects.toMatchObject({ status: 405 });
    expect(rejectedSettingsUpdate.headers.get('Allow')).toBe('POST');

    const allowed = context({ resourceName: 'skillRegistryAdmin', actionName: 'publish', method: 'POST' });
    await middleware(allowed as never, next);
    expect(next).toHaveBeenCalledOnce();

    const readPreview = context({
      resourceName: 'skillRegistryAdmin',
      actionName: 'yankImpact',
      method: 'GET',
    });
    await middleware(readPreview as never, next);
    expect(next).toHaveBeenCalledTimes(2);

    const rejectedPreviewWrite = context({
      resourceName: 'skillRegistryAdmin',
      actionName: 'installationStates',
      method: 'POST',
    });
    await expect(middleware(rejectedPreviewWrite as never, next)).rejects.toMatchObject({ status: 405 });
    expect(rejectedPreviewWrite.headers.get('Allow')).toBe('GET, HEAD');
  });

  it('blocks generic mutation of internal resources regardless of filter shape', async () => {
    const direct = context({
      resourceName: 'skillRegistryVersions',
      actionName: 'update',
      method: 'POST',
      params: { filter: { status: 'published' } },
    });
    const associated = context({
      resourceName: 'skillRegistryPackages.versions',
      actionName: 'set',
      method: 'POST',
      params: { associatedName: 'skillRegistryPackages', resourceName: 'versions' },
    });
    const repositoryResolvedAssociation = context({
      resourceName: 'skillRegistryPackages.versions',
      actionName: 'create',
      method: 'POST',
      params: { associatedName: 'versions' },
      targetCollection: 'skillRegistryVersions',
    });
    const targeted = context({
      resourceName: 'unrelatedResources',
      actionName: 'updateOrCreate',
      method: 'POST',
      params: { targetCollection: 'skillRegistryArtifacts' },
    });

    expect(isProtectedGenericMutation(direct as never)).toBe(true);
    expect(isProtectedGenericMutation(associated as never)).toBe(true);
    expect(isProtectedGenericMutation(targeted as never)).toBe(true);
    expect(isProtectedGenericMutation(repositoryResolvedAssociation as never)).toBe(true);

    const middleware = createResourceMutationPolicy();
    const next = vi.fn().mockResolvedValue(undefined);
    await expect(middleware(direct as never, next)).rejects.toMatchObject({ status: 405 });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows only validated direct source CRUD and read operations', async () => {
    const sourceCreate = context({ resourceName: 'skillRegistrySources', actionName: 'create', method: 'POST' });
    const sourceUpdate = context({
      resourceName: 'skillRegistrySources',
      actionName: 'update',
      method: 'POST',
      params: { filterByTk: 'source-1' },
    });
    const bulkSourceUpdate = context({
      resourceName: 'skillRegistrySources',
      actionName: 'update',
      method: 'POST',
      params: { filter: { enabled: true } },
    });
    const sourceUpsert = context({
      resourceName: 'skillRegistrySources',
      actionName: 'updateOrCreate',
      method: 'POST',
    });
    const associatedSourceUpdate = context({
      resourceName: 'unrelated.sources',
      actionName: 'update',
      method: 'POST',
      targetCollection: 'skillRegistrySources',
    });
    const versionList = context({ resourceName: 'skillRegistryVersions', actionName: 'list', method: 'GET' });

    expect(isProtectedGenericMutation(sourceCreate as never)).toBe(false);
    expect(isProtectedGenericMutation(sourceUpdate as never)).toBe(false);
    expect(isProtectedGenericMutation(bulkSourceUpdate as never)).toBe(true);
    expect(isProtectedGenericMutation(sourceUpsert as never)).toBe(true);
    expect(isProtectedGenericMutation(associatedSourceUpdate as never)).toBe(true);
    expect(isProtectedGenericMutation(versionList as never)).toBe(false);

    const middleware = createResourceMutationPolicy();
    const next = vi.fn().mockResolvedValue(undefined);
    await middleware(sourceCreate as never, next);
    await middleware(sourceUpdate as never, next);
    await middleware(versionList as never, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('rejects GET requests that try to invoke a collection mutation explicitly', async () => {
    const middleware = createRequestMethodPolicy();
    const next = vi.fn().mockResolvedValue(undefined);
    const sourceCreate = context({ resourceName: 'skillRegistrySources', actionName: 'create', method: 'GET' });
    const associatedUpdate = context({
      resourceName: 'skillRegistryPackages.versions',
      actionName: 'update',
      method: 'GET',
      targetCollection: 'skillRegistryVersions',
    });

    await expect(middleware(sourceCreate as never, next)).rejects.toMatchObject({ status: 405 });
    await expect(middleware(associatedUpdate as never, next)).rejects.toMatchObject({ status: 405 });
    expect(sourceCreate.headers.get('Allow')).toBe('POST');
    expect(associatedUpdate.headers.get('Allow')).toBe('POST');
    expect(next).not.toHaveBeenCalled();
  });
});
