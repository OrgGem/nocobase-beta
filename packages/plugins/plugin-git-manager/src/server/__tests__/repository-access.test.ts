import { enforceRepositoryAccess, enforceRepositoryCollectionAccess } from '../repository-access';
import { vi } from 'vitest';

function createContext(repositoryId: number, filter?: unknown, roles = ['developer']) {
  const throwError = vi.fn((status: number, message: string) => {
    const error = new Error(message) as Error & { status: number };
    error.status = status;
    throw error;
  });
  return {
    action: { resourceName: 'gitManager', actionName: 'fileTree', params: { repositoryId } },
    state: { currentRoles: roles },
    app: {
      acl: {
        can: vi.fn().mockResolvedValue({ params: filter === undefined ? {} : { filter } }),
      },
    },
    throw: throwError,
  };
}

function createActionContext(input: {
  actionName: string;
  params?: Record<string, unknown>;
  requestBody?: Record<string, unknown>;
  query?: Record<string, unknown>;
  requestQuery?: Record<string, unknown>;
  filter?: unknown;
  roles?: string[];
  configRepositoryId?: number;
  reviewRepositoryId?: number;
}) {
  const throwError = vi.fn((status: number, message: string) => {
    const error = new Error(message) as Error & { status: number };
    error.status = status;
    throw error;
  });
  const configFindOne = vi
    .fn()
    .mockResolvedValue(
      input.configRepositoryId === undefined ? null : { get: (attribute: string) => input.configRepositoryId },
    );
  const reviewFindOne = vi
    .fn()
    .mockResolvedValue(
      input.reviewRepositoryId === undefined ? null : { get: (attribute: string) => input.reviewRepositoryId },
    );
  const getRepository = vi.fn((name: string) => {
    if (name === 'gitSubtreeConfigs') return { findOne: configFindOne };
    if (name === 'gitCodeReviews') return { findOne: reviewFindOne };
    throw new Error(`Unexpected repository ${name}`);
  });
  const context = {
    action: { resourceName: 'gitManager', actionName: input.actionName, params: input.params || {} },
    ...(input.requestBody ? { request: { body: input.requestBody } } : {}),
    state: { currentRoles: input.roles || ['developer'] },
    db: { getRepository },
    app: {
      acl: {
        can: vi.fn().mockResolvedValue({ params: input.filter === undefined ? {} : { filter: input.filter } }),
      },
    },
    throw: throwError,
  };
  return { context, configFindOne, reviewFindOne };
}

function createCollectionContext(input: {
  resourceName: string;
  actionName: string;
  params?: Record<string, unknown>;
  requestBody?: unknown;
  filter?: unknown;
  roles?: string[];
  configRepositoryId?: number;
}) {
  const throwError = vi.fn((status: number, message: string) => {
    const error = new Error(message) as Error & { status: number };
    error.status = status;
    throw error;
  });
  const mergeParams = vi.fn();
  const configFindOne = vi
    .fn()
    .mockResolvedValue(
      input.configRepositoryId === undefined ? null : { get: (attribute: string) => input.configRepositoryId },
    );
  const context = {
    action: {
      resourceName: input.resourceName,
      actionName: input.actionName,
      params: input.params || {},
      mergeParams,
    },
    ...(input.query ? { query: input.query } : {}),
    ...(input.requestBody || input.requestQuery
      ? {
          request: {
            ...(input.requestBody ? { body: input.requestBody } : {}),
            ...(input.requestQuery ? { query: input.requestQuery } : {}),
          },
        }
      : {}),
    state: { currentRoles: input.roles || ['developer'] },
    db: {
      getRepository: vi.fn((name: string) => {
        if (name === 'gitSubtreeConfigs') return { findOne: configFindOne };
        throw new Error(`Unexpected repository ${name}`);
      }),
    },
    app: {
      acl: {
        can: vi.fn().mockResolvedValue({ params: input.filter === undefined ? {} : { filter: input.filter } }),
      },
    },
    throw: throwError,
  };
  return { context, mergeParams, configFindOne };
}

describe('Git Manager repository access', () => {
  it('allows the repository included in the role scope', async () => {
    const ctx = createContext(10, { $and: [{ id: { $in: [10] } }] });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryAccess(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a repository represented by a legacy direct id scope', async () => {
    const ctx = createContext(10, { id: 10 });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryAccess(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a repository represented by an equality scope', async () => {
    const ctx = createContext(10, { id: { $eq: '10' } });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryAccess(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects another repository outside the role scope', async () => {
    const ctx = createContext(20, { $and: [{ id: { $in: [10] } }] });

    await expect(enforceRepositoryAccess(ctx, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it('accepts a repository granted by one of multiple roles', async () => {
    const ctx = createContext(20, {
      $or: [{ $and: [{ id: { $in: [10] } }] }, { $and: [{ id: { $in: [20] } }] }],
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryAccess(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows root without evaluating repository scope', async () => {
    const ctx = createContext(20, { $and: [{ id: { $in: [10] } }] }, ['root']);
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryAccess(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.app.acl.can).not.toHaveBeenCalled();
  });

  it('checks the repository ID from a request body and lets the body override URL params', async () => {
    const { context } = createActionContext({
      actionName: 'triggerReview',
      params: { repositoryId: 10 },
      requestBody: { repositoryId: 20 },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(context.app.acl.can).toHaveBeenCalledWith({
      roles: ['developer'],
      resource: 'gitManager',
      action: 'triggerReview',
    });
  });

  it('checks the repository ID from the action values envelope', async () => {
    const { context } = createActionContext({
      actionName: 'subtreeOptions',
      params: { values: { repositoryId: 20 } },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it.each(['subtreePreview', 'subtreeRun', 'subtreeReplace'])(
    'resolves the repository scope from a subtree config for %s',
    async (actionName) => {
      const { context, configFindOne } = createActionContext({
        actionName,
        requestBody: { configId: 8 },
        configRepositoryId: 20,
        filter: { id: { $in: [10] } },
      });

      await expect(enforceRepositoryAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
      expect(configFindOne).toHaveBeenCalledWith({ filterByTk: 8 });
    },
  );

  it.each(['reviewApprovePost', 'reviewReject'])(
    'resolves the repository scope from a code review for %s',
    async (actionName) => {
      const { context, reviewFindOne } = createActionContext({
        actionName,
        params: { values: { reviewId: 7 } },
        reviewRepositoryId: 20,
        filter: { id: { $in: [10] } },
      });

      await expect(enforceRepositoryAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
      expect(reviewFindOne).toHaveBeenCalledWith({ filterByTk: 7 });
    },
  );

  it('denies a scoped role from polling every repository', async () => {
    const { context } = createActionContext({
      actionName: 'pollNow',
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it('checks a poll target supplied in the request body', async () => {
    const { context } = createActionContext({
      actionName: 'pollNow',
      requestBody: { repositoryId: 20 },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it('allows polling every repository only with an unscoped permission', async () => {
    const { context } = createActionContext({ actionName: 'pollNow' });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryAccess(context, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a repository-scoped action has no repository ID', async () => {
    const { context } = createActionContext({ actionName: 'fileTree', filter: { id: { $in: [10] } } });

    await expect(enforceRepositoryAccess(context, vi.fn())).rejects.toMatchObject({ status: 400 });
  });
});

describe('Git Manager repository collection access', () => {
  it.each([
    ['gitCodeReviews', { repositoryId: { $in: [10] } }],
    ['gitReviewFlows', { repositoryId: { $in: [10] } }],
    ['gitSubtreeConfigs', { repositoryId: { $in: [10] } }],
    ['gitSubtreeRuns', { config: { repositoryId: { $in: [10] } } }],
    ['gitRepositories', { id: { $in: [10] } }],
  ])('merges repository scope into %s collection reads', async (resourceName, expectedFilter) => {
    const { context, mergeParams } = createCollectionContext({
      resourceName,
      actionName: 'list',
      filter: { id: { $in: [10] } },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryCollectionAccess(context, next);

    expect(mergeParams).toHaveBeenCalledWith({ filter: expectedFilter });
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a scoped repository read that appends gitAccount from action params', async () => {
    const { context, mergeParams } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'list',
      params: { appends: ['gitAccount'] },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(mergeParams).not.toHaveBeenCalled();
  });

  it('rejects an option-suffixed gitAccount append from action params', async () => {
    const { context, mergeParams } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'list',
      params: { appends: 'gitAccount(recursively=true)' },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(mergeParams).not.toHaveBeenCalled();
  });

  it('rejects a scoped repository read that appends gitAccount from the request body', async () => {
    const { context, mergeParams } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'get',
      requestBody: { appends: ['gitAccount'] },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(mergeParams).not.toHaveBeenCalled();
  });

  it('rejects an ORM-style gitAccount include inside the action values envelope', async () => {
    const { context, mergeParams } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'list',
      params: { values: { include: [{ association: 'gitAccount' }] } },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(mergeParams).not.toHaveBeenCalled();
  });

  it('rejects a credential relation field path for a scoped repository read', async () => {
    const { context, mergeParams } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'list',
      params: { fields: ['id', 'gitAccount.pat'] },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(mergeParams).not.toHaveBeenCalled();
  });

  it.each([
    ['ctx.query', { query: { appends: 'gitAccount' } }],
    ['ctx.request.query', { requestQuery: { appends: 'gitAccount' } }],
  ])('rejects a credential append supplied through %s', async (_source, queryInput) => {
    const { context, mergeParams } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'list',
      ...queryInput,
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(mergeParams).not.toHaveBeenCalled();
  });

  it.each([
    ['gitReviewFlows', 'repository.gitAccount'],
    ['gitCodeReviews', 'repository.gitAccount'],
    ['gitSubtreeConfigs', 'repository.gitAccount'],
    ['gitSubtreeRuns', 'config.repository.gitAccount'],
  ])('rejects a credential append through scoped %s reads', async (resourceName, credentialPath) => {
    const { context, mergeParams } = createCollectionContext({
      resourceName,
      actionName: 'list',
      params: { appends: [credentialPath] },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(mergeParams).not.toHaveBeenCalled();
  });

  it.each(['gitRepositories.10.gitAccount', 'gitAccounts.2.repositories'])(
    'rejects a scoped credential association route %s',
    async (resourceName) => {
      const { context, mergeParams } = createCollectionContext({
        resourceName,
        actionName: 'list',
        filter: { id: { $in: [10] } },
      });

      await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
      expect(mergeParams).not.toHaveBeenCalled();
    },
  );

  it('allows safe relation appends and preserves unscoped and root reads', async () => {
    const scoped = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'list',
      params: { appends: ['autoReviewFlow'] },
      filter: { id: { $in: [10] } },
    });
    const unrestricted = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'list',
      params: { appends: ['gitAccount'] },
    });
    const root = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'list',
      params: { appends: ['gitAccount'] },
      filter: { id: { $in: [10] } },
      roles: ['root'],
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryCollectionAccess(scoped.context, next);
    await enforceRepositoryCollectionAccess(unrestricted.context, next);
    await enforceRepositoryCollectionAccess(root.context, next);

    expect(scoped.mergeParams).toHaveBeenCalledWith({ filter: { id: { $in: [10] } } });
    expect(next).toHaveBeenCalledTimes(3);
    expect(root.context.app.acl.can).not.toHaveBeenCalled();
  });

  it('keeps a zero-selection scope restrictive instead of falling back to a global collection action', async () => {
    const { context, mergeParams } = createCollectionContext({
      resourceName: 'gitCodeReviews',
      actionName: 'destroy',
      params: { filterByTk: 20 },
      filter: { $and: [{ id: { $in: [] } }] },
    });

    await enforceRepositoryCollectionAccess(context, vi.fn());

    expect(mergeParams).toHaveBeenCalledWith({ filter: { repositoryId: { $in: [] } } });
  });

  it.each(['gitAccounts', 'gitCodeReviews'])(
    'rejects a gitRepositories request that redirects to %s with targetCollection',
    async (targetCollection) => {
      const { context } = createCollectionContext({
        resourceName: 'gitRepositories',
        actionName: 'get',
        params: { filterByTk: 10, targetCollection },
        filter: { id: { $in: [10] } },
      });

      await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    },
  );

  it('rejects an association payload that redirects a scoped repository request', async () => {
    const { context } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'update',
      params: { filterByTk: 10, values: { __collection: 'gitAccounts' } },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['request body', { gitAccountId: 2 }],
    ['request body', { gitAccount: { id: 2 } }],
    ['request body', { repoUrl: 'https://git.example.test/other/project.git' }],
    ['request body', { localPath: 'other-project' }],
    ['action values', { gitAccountId: 2 }],
    ['action values', { gitAccount: { id: 2 } }],
    ['action values', { repoUrl: 'https://git.example.test/other/project.git' }],
    ['action values', { localPath: 'other-project' }],
  ])('rejects a scoped repository connection mutation from %s', async (source, values) => {
    const { context } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'update',
      ...(source === 'request body' ? { requestBody: values } : { params: { values } }),
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a dotted gitAccount mutation key from action params', async () => {
    const { context } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'update',
      params: { 'gitAccount.id': 2 },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a bracket gitAccount mutation key from action values', async () => {
    const { context } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'update',
      params: { values: { 'gitAccount[pat]': 'secret' } },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a quoted bracket gitAccount mutation key from action params', async () => {
    const { context } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'update',
      params: { 'values["gitAccount"]["pat"]': 'secret' },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it('rejects nested credential values in an association-update payload', async () => {
    const { context } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'update',
      requestBody: { updateAssociationValues: { gitAccount: { id: 2 } } },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['dotted repoUrl', { 'repoUrl.value': 'https://git.example.test/other/project.git' }],
    ['bracket localPath', { 'localPath[0]': 'other-project' }],
  ])('rejects a scoped repository mutation using %s', async (_source, values) => {
    const { context } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'update',
      params: { values },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['ctx.query', { query: { 'gitAccount.id': '2' } }],
    ['ctx.request.query', { requestQuery: { 'gitAccount[pat]': 'secret' } }],
  ])('rejects a credential mutation supplied through %s', async (_source, queryInput) => {
    const { context } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'update',
      ...queryInput,
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['request body array', { requestBody: [{ id: 10 }, { id: 20 }] }],
    ['action values array', { params: { values: [{ id: 10 }, { id: 20 }] } }],
  ])('rejects a scoped bulk mutation from %s', async (_source, bulkInput) => {
    const { context, mergeParams } = createCollectionContext({
      resourceName: 'gitCodeReviews',
      actionName: 'update',
      ...bulkInput,
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(mergeParams).not.toHaveBeenCalled();
  });

  it.each([
    ['create', { repositoryId: 10, flowId: 8 }],
    ['update', { metadata: { aiEmployeeUsername: 'admin-reviewer', userId: 1 } }],
    ['update', { status: 'pending' }],
  ])('rejects scoped generic gitCodeReviews %s mutations', async (actionName, values) => {
    const { context, mergeParams } = createCollectionContext({
      resourceName: 'gitCodeReviews',
      actionName,
      requestBody: values,
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
    expect(mergeParams).not.toHaveBeenCalled();
  });

  it('does not block the checked custom gitManager review actions', async () => {
    const { context } = createCollectionContext({
      resourceName: 'gitManager',
      actionName: 'triggerReview',
      params: { repositoryId: 10 },
      filter: { id: { $in: [10] } },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryCollectionAccess(context, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ['gitReviewFlows', 'dotted action params', { params: { 'repository.id': 20 } }],
    ['gitCodeReviews', 'bracket action values', { params: { values: { 'repository[id]': 20 } } }],
    [
      'gitSubtreeConfigs',
      'nested request body',
      { requestBody: { updateAssociationValues: { repository: { id: 20 } } } },
    ],
  ])('rejects a scoped %s repository association mutation from %s', async (resourceName, _source, mutationInput) => {
    const { context } = createCollectionContext({
      resourceName,
      actionName: 'update',
      ...mutationInput,
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['dotted action params', { params: { 'config.id': 8 } }],
    ['bracket action values', { params: { values: { 'config[id]': 8 } } }],
    ['nested request body', { requestBody: { updateAssociationValues: { config: { id: 8 } } } }],
  ])('rejects a scoped subtree-run config association mutation from %s', async (_source, mutationInput) => {
    const { context } = createCollectionContext({
      resourceName: 'gitSubtreeRuns',
      actionName: 'update',
      ...mutationInput,
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['gitReviewFlows', { name: 'Flow 10' }],
    ['gitSubtreeConfigs', { name: 'Config 10' }],
    ['gitSubtreeRuns', { status: 'queued' }],
  ])('allows a scoped %s metadata update without association changes', async (resourceName, values) => {
    const { context } = createCollectionContext({
      resourceName,
      actionName: 'update',
      requestBody: values,
      filter: { id: { $in: [10] } },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryCollectionAccess(context, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('allows a scoped repository metadata update', async () => {
    const { context } = createCollectionContext({
      resourceName: 'gitRepositories',
      actionName: 'update',
      requestBody: { name: 'Repository 10', autoReview: true },
      filter: { id: { $in: [10] } },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryCollectionAccess(context, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a body value that overrides an allowed URL/action value with another repository', async () => {
    const { context } = createCollectionContext({
      resourceName: 'gitCodeReviews',
      actionName: 'update',
      params: { values: { repositoryId: 10 } },
      requestBody: { repositoryId: 20 },
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });

  it('accepts matching string and numeric repository IDs for a scoped collection create', async () => {
    const { context } = createCollectionContext({
      resourceName: 'gitSubtreeConfigs',
      actionName: 'create',
      requestBody: { repositoryId: 10 },
      filter: { id: { $eq: '10' } },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await enforceRepositoryCollectionAccess(context, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a global review flow and unknown generic mutation for a scoped role', async () => {
    const globalFlow = createCollectionContext({
      resourceName: 'gitReviewFlows',
      actionName: 'create',
      requestBody: { repositoryId: null },
      filter: { id: { $in: [10] } },
    });
    const unknownMutation = createCollectionContext({
      resourceName: 'gitCodeReviews',
      actionName: 'updateOrCreate',
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(globalFlow.context, vi.fn())).rejects.toMatchObject({ status: 403 });
    await expect(enforceRepositoryCollectionAccess(unknownMutation.context, vi.fn())).rejects.toMatchObject({
      status: 403,
    });
  });

  it('checks a subtree run config before allowing a scoped create', async () => {
    const denied = createCollectionContext({
      resourceName: 'gitSubtreeRuns',
      actionName: 'create',
      requestBody: { configId: 8 },
      configRepositoryId: 20,
      filter: { id: { $in: [10] } },
    });
    const allowed = createCollectionContext({
      resourceName: 'gitSubtreeRuns',
      actionName: 'create',
      requestBody: { configId: 8 },
      configRepositoryId: 10,
      filter: { id: { $in: [10] } },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(enforceRepositoryCollectionAccess(denied.context, vi.fn())).rejects.toMatchObject({ status: 403 });
    await enforceRepositoryCollectionAccess(allowed.context, next);

    expect(denied.configFindOne).toHaveBeenCalledWith({ filterByTk: 8 });
    expect(allowed.configFindOne).toHaveBeenCalledWith({ filterByTk: 8 });
    expect(next).toHaveBeenCalledOnce();
  });

  it('fails closed for unsupported repository scopes and protects global credentials', async () => {
    const unsupported = createCollectionContext({
      resourceName: 'gitCodeReviews',
      actionName: 'list',
      filter: { status: 'active' },
    });
    const accounts = createCollectionContext({
      resourceName: 'gitAccounts',
      actionName: 'list',
      filter: { id: { $in: [10] } },
    });

    await expect(enforceRepositoryCollectionAccess(unsupported.context, vi.fn())).rejects.toMatchObject({
      status: 403,
    });
    await expect(enforceRepositoryCollectionAccess(accounts.context, vi.fn())).rejects.toMatchObject({ status: 403 });
  });
});
