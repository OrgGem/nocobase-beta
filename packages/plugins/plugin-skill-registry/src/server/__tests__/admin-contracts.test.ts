import { createAdminActions } from '../actions';

describe('skill registry admin contracts', () => {
  it('accepts publish values from the NocoBase values envelope', async () => {
    const publish = {
      publish: vi.fn().mockResolvedValue({ get: (key: string) => ({ id: 'v1', version: '1.0.0' })[key] }),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: publish as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: { values: { sourceItemId: '12', version: '1.0.0', channel: 'stable' } } },
      auth: { user: { id: '1' } },
      body: null,
    };

    await actions.publish(ctx as never, async () => undefined);

    expect(publish.publish).toHaveBeenCalledWith({
      sourceItemId: '12',
      version: '1.0.0',
      channel: 'stable',
      changelog: undefined,
      publishedById: '1',
      access: { kind: 'user', userId: '1', roles: [] },
    });
  });

  it('accepts publish values from the HTTP request body', async () => {
    const publish = { publish: vi.fn().mockResolvedValue({ get: () => '1.0.0' }) };
    const actions = createAdminActions({
      sync: {} as never,
      publish: publish as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: {} },
      request: { body: { sourceItemId: '12', version: '1.0.0', channel: 'stable' } },
      auth: { user: { id: '1' } },
      body: null,
    };

    await actions.publish(ctx as never, async () => undefined);

    expect(publish.publish).toHaveBeenCalled();
  });

  it('accepts a numeric source item ID when publishing an auto-increment record', async () => {
    const publish = { publish: vi.fn().mockResolvedValue({ get: () => '1.0.1' }) };
    const actions = createAdminActions({
      sync: {} as never,
      publish: publish as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: { values: { sourceItemId: 207, version: '1.0.1', channel: 'stable' } } },
      auth: { user: { id: 1 } },
      body: null,
    };

    await actions.publish(ctx as never, async () => undefined);

    expect(publish.publish).toHaveBeenCalledWith({
      sourceItemId: 207,
      version: '1.0.1',
      channel: 'stable',
      changelog: undefined,
      publishedById: '1',
      access: { kind: 'user', userId: '1', roles: [] },
    });
  });

  it('forwards the authenticated user and roles to source discovery and sync', async () => {
    const sync = {
      discover: vi.fn().mockResolvedValue({ candidates: [] }),
      sync: vi.fn().mockResolvedValue({ get: (key: string) => ({ id: 'run-1', status: 'succeeded' })[key] }),
    };
    const actions = createAdminActions({
      sync: sync as never,
      publish: {} as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: { values: { sourceId: 'source-1' } } },
      auth: { user: { id: 'admin-1' } },
      state: { currentRoles: ['registry-manager'] },
      body: null,
    };

    await actions.discover(ctx as never, async () => undefined);
    await actions.sync(ctx as never, async () => undefined);

    const access = { kind: 'user', userId: 'admin-1', roles: ['registry-manager'] };
    expect(sync.discover).toHaveBeenCalledWith('source-1', access);
    expect(sync.sync).toHaveBeenCalledWith('source-1', 'manual', 'admin-1', access);
  });

  it('publishes selected candidates independently and reports partial results', async () => {
    const publish = {
      publish: vi
        .fn()
        .mockResolvedValueOnce({ get: (key: string) => (key === 'version' ? '1.0.0' : 'v1') })
        .mockRejectedValueOnce(new Error('provider failed')),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: publish as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: { values: { sourceItemIds: ['1', '2'], version: '1.0.0', channel: 'stable' } } },
      auth: { user: { id: '1' } },
      body: null,
    };

    await actions.publishBatch(ctx as never, async () => undefined);

    expect(ctx.body).toMatchObject({ published: 1, failed: 1 });
  });

  it('unpublishes selected candidates independently and reports partial results', async () => {
    const publish = {
      unpublishSourceItem: vi
        .fn()
        .mockResolvedValueOnce({ sourceItemId: '1', state: 'ready', yanked: 2 })
        .mockRejectedValueOnce(new Error('database failed')),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: publish as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: { values: { sourceItemIds: ['1', '2'], reason: 'Superseded' } } },
      body: null,
    };

    await actions.unpublishBatch(ctx as never, async () => undefined);

    expect(publish.unpublishSourceItem).toHaveBeenNthCalledWith(1, '1', 'Superseded');
    expect(ctx.body).toMatchObject({ unpublished: 1, failed: 1 });
  });

  it('returns the final source state from an unpublish operation', async () => {
    const publish = {
      unpublishSourceItem: vi.fn().mockResolvedValue({ sourceItemId: '12', state: 'ready', yanked: 2 }),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: publish as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = { action: { params: { values: { sourceItemId: 12 } } }, body: null };

    await actions.unpublish(ctx as never, async () => undefined);

    expect(ctx.body).toEqual({ sourceItemId: '12', status: 'ready', yanked: 2 });
  });

  it('accepts numeric source IDs returned by auto-increment collections', async () => {
    const sync = {
      discover: vi.fn().mockResolvedValue({ sourceId: '1', candidates: [] }),
    };
    const actions = createAdminActions({
      sync: sync as never,
      publish: {} as never,
      database: {} as never,
      installationBridge: {} as never,
    });
    const ctx = {
      action: { params: { values: { sourceId: 1 } } },
      body: null,
      throw: vi.fn(),
    };

    await actions.discover(ctx as never, async () => undefined);

    expect(sync.discover).toHaveBeenCalledWith(1, { kind: 'user', roles: [] });
  });

  it('verifies a published artifact through the installation bridge', async () => {
    const bridge = {
      verify: vi.fn().mockResolvedValue({
        versionId: 'version-1',
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        signatureVerified: true,
      }),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: {} as never,
      database: {} as never,
      installationBridge: bridge as never,
    });
    const ctx = {
      action: { params: { values: { versionId: 'version-1' } } },
      body: null,
      throw: vi.fn(),
    };

    await actions.verify(ctx as never, async () => undefined);

    expect(bridge.verify).toHaveBeenCalledWith('version-1');
    expect(ctx.body).toEqual({
      versionId: 'version-1',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      signatureVerified: true,
    });
  });

  it('returns installation states for selected version IDs', async () => {
    const bridge = {
      installationStates: vi.fn().mockResolvedValue([{ registryVersionId: 'version-1', status: 'installed' }]),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: {} as never,
      database: {} as never,
      installationBridge: bridge as never,
    });
    const ctx = { action: { params: { versionIds: ['version-1'] } }, body: null };

    await actions.installationStates(ctx as never, async () => undefined);

    expect(bridge.installationStates).toHaveBeenCalledWith(['version-1']);
    expect(ctx.body).toEqual({ states: [{ registryVersionId: 'version-1', status: 'installed' }] });
  });

  it('previews the exact package effect before yanking a version', async () => {
    const version = {
      get: (key: string) => ({ id: 'v2', packageId: 'p1', status: 'published', version: '2.0.0' })[key],
    };
    const replacement = { get: (key: string) => ({ id: 'v1', version: '1.0.0' })[key] };
    const versions = {
      findOne: vi
        .fn()
        .mockResolvedValueOnce(version)
        .mockResolvedValueOnce(replacement)
        .mockResolvedValueOnce(replacement),
    };
    const packages = {
      findOne: vi.fn().mockResolvedValue({
        get: (key: string) => ({ id: 'p1', namespace: 'acme', slug: 'report', latestStableVersionId: 'v2' })[key],
      }),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: {} as never,
      database: { getRepository: (name: string) => (name === 'skillRegistryVersions' ? versions : packages) } as never,
      installationBridge: {} as never,
    });
    const ctx = { action: { params: { versionId: 'v2' } }, body: null };

    await actions.yankImpact(ctx as never, async () => undefined);

    expect(ctx.body).toMatchObject({
      packageIdentity: 'acme/report',
      version: '2.0.0',
      isLatestStable: true,
      replacementVersion: '1.0.0',
      packageWillBecomeDraft: false,
    });
  });

  it('restores the target selected by Agent Orchestrator without exposing installation storage to the registry', async () => {
    const bridge = {
      rollback: vi.fn().mockResolvedValue({
        installationId: 'installation-1',
        skillDefinitionId: 'skill-1',
        toolName: 'registry_acme_report',
        status: 'installed',
      }),
    };
    const actions = createAdminActions({
      sync: {} as never,
      publish: {} as never,
      database: {} as never,
      installationBridge: bridge as never,
    });
    const ctx = {
      action: { params: { values: { installationId: 'installation-2' } } },
      auth: { user: { id: 'admin-1' } },
      body: null,
      throw: vi.fn(),
    };

    await actions.rollback(ctx as never, async () => undefined);

    expect(bridge.rollback).toHaveBeenCalledWith('installation-2', 'admin-1');
    expect(ctx.body).toEqual({
      installationId: 'installation-1',
      skillDefinitionId: 'skill-1',
      toolName: 'registry_acme_report',
      status: 'installed',
    });
  });
});
